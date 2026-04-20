import express, { type Request, type Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { GoogleGenAI, ThinkingLevel, EditMode, RawReferenceImage, MaskReferenceImage } from '@google/genai';
import type { GenerateContentConfig, Part } from '@google/genai';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import path from 'path';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(cors({ origin: process.env.ALLOWED_ORIGIN ?? `http://localhost:${PORT}` }));
app.use(express.json({ limit: '50mb' }));

const PORT = Number(process.env.PORT) || 3456;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!GEMINI_API_KEY) {
  console.error('[fatal] GEMINI_API_KEY not set. Create .env from .env.example');
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
const GENERATION_MODEL = 'gemini-3.1-flash-image-preview';
const JUDGE_MODEL = 'gemini-2.5-flash';
const EDIT_MODEL = 'imagen-3.0-capability-001';

// ─── Context Snapshot types ──────────────────────────────────────────────────
interface PartSnapshot {
  type: 'image' | 'text';
  content: string;
  label: string;
  detail?: string;
}

interface TurnSnapshot {
  turn: number;
  type: 'user' | 'model';
  role: 'generate' | 'refine' | 'model-response';
  parts: PartSnapshot[];
  metadata: {
    thoughtSignature?: string;
    modelDescription?: string;
    timestamp: number;
    roundId?: string;
  };
}

interface ContextSnapshot {
  sessionId: string;
  turns: TurnSnapshot[];
  currentStatus: {
    hasValidThoughtSignature: boolean;
    mode: 'single-turn' | 'multi-turn';
    totalImages: number;
    totalTurns: number;
  };
}

// ─── Session status types ─────────────────────────────────────────────────────
type SessionStatus = 'idle' | 'generating' | 'judging' | 'refining' | 'done' | 'error';
type SessionMode = 'manual' | 'auto';
type ErrorCode = 'CONTENT_POLICY' | 'TIMEOUT' | 'MODEL_ERROR' | 'RATE_LIMIT' | 'INVALID_INPUT';

// ─── In-memory session store ─────────────────────────────────────────────────
interface GenerationRound {
  id: string;
  turn: number;
  type: 'generate' | 'refine' | 'edit';
  prompt: string;
  instruction?: string;
  imageBase64: string;
  thoughtSignature?: string;
  modelDescription?: string;
  converged: boolean;
  scores?: Record<string, { score: number; notes: string }>;
  topIssues?: Array<{ issue: string; fix: string }>;
  nextFocus?: string;
  createdAt: number;
  contextSnapshot?: TurnSnapshot[];
}

interface Session {
  id: string;
  rounds: GenerationRound[];
  baseImageBase64?: string;
  basePrompt?: string;
  status: SessionStatus;
  mode: SessionMode;
  maxRounds: number;
  lastAccessedAt: number;
  currentTask?: {
    type: 'generate' | 'refine' | 'judge';
    roundId?: string;
    startedAt: number;
  };
  error?: {
    code: ErrorCode;
    message: string;
    roundId?: string;
    timestamp: number;
  };
  abortController?: AbortController;
}

const sessions = new Map<string, Session>();

const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS) || 24 * 60 * 60 * 1000; // default 24h
const SESSION_CLEANUP_INTERVAL_MS = Number(process.env.SESSION_CLEANUP_INTERVAL_MS) || 60 * 60 * 1000; // default 1h

function getOrCreateSession(sessionId: string): Session {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      id: sessionId,
      rounds: [],
      status: 'idle',
      mode: 'manual',
      maxRounds: 3,
      lastAccessedAt: Date.now(),
    });
  } else {
    sessions.get(sessionId)!.lastAccessedAt = Date.now();
  }
  return sessions.get(sessionId)!;
}

function cleanupExpiredSessions(): void {
  const now = Date.now();
  let cleaned = 0;
  for (const [id, session] of sessions) {
    if (now - session.lastAccessedAt > SESSION_TTL_MS) {
      // Abort any active auto loop before deletion
      session.abortController?.abort(new Error('Session expired'));
      sessions.delete(id);
      cleaned++;
    }
  }
  if (cleaned > 0) {
    console.log(`[cleanup] Removed ${cleaned} expired sessions (>${SESSION_TTL_MS / 1000 / 60 / 60}h)`);
  }
}

// ─── Human-in-the-loop: pending choices ───────────────────────────────────────

interface PendingChoice {
  id: string;
  sessionId: string;
  type: string;
  payload: unknown;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
  createdAt: number;
}

const pendingChoices = new Map<string, PendingChoice>();

function createChoice<T>(
  sessionId: string,
  type: string,
  payload: unknown,
  timeoutMs = 300_000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const timeout = setTimeout(() => {
      pendingChoices.delete(id);
      reject(new Error(`Choice ${id} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    pendingChoices.set(id, { id, sessionId, type, payload, resolve, reject, timeout, createdAt: Date.now() });
    broadcast(sessionId, { type: 'choice-request', choiceId: id, choiceType: type, payload });
  });
}

function resolveChoice(choiceId: string, result: unknown): boolean {
  const choice = pendingChoices.get(choiceId);
  if (!choice) return false;
  clearTimeout(choice.timeout);
  pendingChoices.delete(choiceId);
  choice.resolve(result);
  return true;
}

function rejectChoice(choiceId: string, reason: string): boolean {
  const choice = pendingChoices.get(choiceId);
  if (!choice) return false;
  clearTimeout(choice.timeout);
  pendingChoices.delete(choiceId);
  choice.reject(new Error(reason));
  return true;
}

// ─── SSE broadcast for web UI ────────────────────────────────────────────────
const sseClients = new Map<string, Set<Response>>();

function broadcast(sessionId: string, data: unknown) {
  const clients = sseClients.get(sessionId);
  if (!clients) return;
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch {
      clients.delete(res);
    }
  }
}

function setSessionStatus(
  session: Session,
  status: SessionStatus,
  task?: Session['currentTask'],
): void {
  session.status = status;
  session.currentTask = task;
  if (status !== 'error') session.error = undefined;
  broadcast(session.id, { type: 'status', status, task });
}

function setSessionError(
  session: Session,
  code: ErrorCode,
  message: string,
  roundId?: string,
): void {
  session.status = 'error';
  session.currentTask = undefined;
  session.error = { code, message, roundId, timestamp: Date.now() };
  broadcast(session.id, { type: 'error', code, message, roundId });
}

const GEMINI_TIMEOUT_MS = 120_000;

/**
 * Wraps a Gemini API factory with:
 * 1. A hard timeout (default 120s) — sends AbortSignal to cancel the in-flight HTTP request
 * 2. An optional external signal (e.g. session.abortController.signal) forwarded into the same controller
 *
 * Usage:
 *   await withGeminiCall((s) => doGenerate({ ...params, signal: s }), { signal: sessionSignal });
 */
function withGeminiCall<T>(
  factory: (signal: AbortSignal) => Promise<T>,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<T> {
  const { signal: externalSignal, timeoutMs = GEMINI_TIMEOUT_MS } = options;
  const timeoutCtrl = new AbortController();
  const timer = setTimeout(() => {
    timeoutCtrl.abort(
      Object.assign(new Error(`Gemini call timed out after ${timeoutMs / 1000}s`), { code: 'ETIMEDOUT' }),
    );
  }, timeoutMs);
  // Forward external abort (user interrupt) into the same controller
  const onAbort = () => timeoutCtrl.abort(externalSignal!.reason);
  externalSignal?.addEventListener('abort', onAbort, { once: true });
  return factory(timeoutCtrl.signal).finally(() => {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', onAbort);
  });
}

function isValidBase64(str: string): boolean {
  if (typeof str !== 'string' || str.length === 0) return false;
  if (str.startsWith('data:')) return false; // reject data URLs, expect pure base64
  const maxValidate = 100_000;
  const toCheck = str.length > maxValidate ? str.slice(0, maxValidate) + str.slice(-100) : str;
  return /^[A-Za-z0-9+/]*={0,2}$/.test(toCheck) && str.length % 4 === 0;
}

function isAbortError(err: unknown): boolean {
  const e = err as any;
  return (
    e?.name === 'AbortError' ||
    e?.code === 'ABORT_ERR' ||
    String(e?.message ?? '').toLowerCase().includes('aborted') ||
    String(e?.message ?? '').toLowerCase().includes('user requested abort')
  );
}

function classifyError(err: unknown): ErrorCode {
  const msg = ((err as any)?.message ?? String(err)).toLowerCase();
  // 1. Rate limit first — explicit and unambiguous (must precede CONTENT_POLICY
  //    because 'generate_content' appears in quota error messages)
  if (msg.includes('429') || msg.includes('quota') || msg.includes('rate limit') || msg.includes('resource_exhausted')) {
    return 'RATE_LIMIT';
  }
  // 2. Content policy — avoid bare 'content' which matches API path segments
  if (msg.includes('safety') || msg.includes('content policy') || msg.includes('content_policy') || msg.includes('blocked') || msg.includes('harm')) {
    return 'CONTENT_POLICY';
  }
  if (msg.includes('timeout') || msg.includes('timed out') || (err as any)?.code === 'ETIMEDOUT') {
    return 'TIMEOUT';
  }
  if (msg.includes('invalid') || msg.includes('400') || msg.includes('bad request')) {
    return 'INVALID_INPUT';
  }
  return 'MODEL_ERROR';
}

app.get('/api/events/:sessionId', (req: Request, res: Response) => {
  const { sessionId } = req.params;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.write(':ok\n\n');
  if (!sseClients.has(sessionId)) sseClients.set(sessionId, new Set());
  sseClients.get(sessionId)!.add(res);
  req.on('close', () => {
    sseClients.get(sessionId)?.delete(res);
  });
});

// ─── REST API: Generate ──────────────────────────────────────────────────────
interface GenerateBody {
  sessionId: string;
  imageBase64?: string;
  prompt: string;
  aspectRatio?: string;
  imageSize?: string;
  thinkingLevel?: 'minimal' | 'high';
  extraImagesBase64?: string[];
  styleRefBase64?: string;
  autoRefine?: boolean;
  maxRounds?: number;
}

app.post('/api/generate', async (req: Request, res: Response) => {
  try {
    const body = req.body as GenerateBody;
    if (!body.sessionId || typeof body.sessionId !== 'string') {
      res.status(400).json({ success: false, error: 'sessionId is required' });
      return;
    }
    if (!body.prompt || !body.prompt.trim()) {
      res.status(400).json({ success: false, error: 'prompt is required' });
      return;
    }
    if (body.imageBase64 && !isValidBase64(body.imageBase64)) {
      res.status(400).json({ success: false, error: 'imageBase64 is not valid base64' });
      return;
    }

    const session = getOrCreateSession(body.sessionId);

    // ── Auto mode ──────────────────────────────────────────────────────────
    if (body.autoRefine) {
      const busy = session.status !== 'idle' && session.status !== 'done' && session.status !== 'error';
      if (busy) {
        res.status(409).json({ success: false, error: '当前会话在自动模式中，请等待', code: 'INVALID_INPUT' });
        return;
      }
      session.mode = 'auto';
      session.maxRounds = body.maxRounds ?? 3;
      // Reset state for new run
      session.rounds = [];
      session.baseImageBase64 = body.imageBase64;
      session.basePrompt = body.prompt;

      res.json({ success: true, sessionId: body.sessionId, status: 'running' });

      // Fire-and-forget: generate → runAutoRefine
      // Create AbortController NOW so abort endpoint can cancel even during the initial generate
      const ctrl = new AbortController();
      session.abortController = ctrl;
      void (async () => {
        const sig = ctrl.signal;
        try {
          setSessionStatus(session, 'generating', { type: 'generate', startedAt: Date.now() });
          const result = await withGeminiCall(
            (s) => doGenerate({
              imageBase64: body.imageBase64,
              prompt: body.prompt,
              aspectRatio: body.aspectRatio ?? '1:1',
              imageSize: body.imageSize ?? '1K',
              thinkingLevel: body.thinkingLevel ?? 'minimal',
              extraImagesBase64: body.extraImagesBase64,
              styleRefBase64: body.styleRefBase64,
              signal: s,
            }),
            { signal: sig },
          );
          if (sig.aborted) { setSessionStatus(session, 'idle'); session.mode = 'manual'; return; }
          const round: GenerationRound = {
            id: randomUUID(),
            turn: 0,
            type: 'generate',
            prompt: body.prompt,
            imageBase64: result.imageBase64,
            thoughtSignature: result.thoughtSignature,
            modelDescription: result.modelDescription,
            converged: false,
            createdAt: Date.now(),
            contextSnapshot: result.contextSnapshot,
          };
          session.rounds.push(round);
          broadcast(body.sessionId, { type: 'round', round });
          await runAutoRefine(session);
        } catch (err: unknown) {
          if (isAbortError(err)) {
            setSessionStatus(session, 'idle');
            session.mode = 'manual';
            broadcast(body.sessionId, { type: 'aborted' });
          } else {
            setSessionError(session, classifyError(err), (err as any)?.message ?? String(err));
          }
        } finally {
          if (session.abortController === ctrl) session.abortController = undefined;
        }
      })();
      return;
    }

    // ── Manual mode ────────────────────────────────────────────────────────
    session.mode = 'manual';
    const result = await doGenerate({
      imageBase64: body.imageBase64,
      prompt: body.prompt,
      aspectRatio: body.aspectRatio ?? '1:1',
      imageSize: body.imageSize ?? '1K',
      thinkingLevel: body.thinkingLevel ?? 'minimal',
      extraImagesBase64: body.extraImagesBase64,
      styleRefBase64: body.styleRefBase64,
    });

    const round: GenerationRound = {
      id: randomUUID(),
      turn: session.rounds.length,
      type: 'generate',
      prompt: body.prompt,
      imageBase64: result.imageBase64,
      thoughtSignature: result.thoughtSignature,
      modelDescription: result.modelDescription,
      converged: false,
      createdAt: Date.now(),
      contextSnapshot: result.contextSnapshot,
    };

    if (body.imageBase64) session.baseImageBase64 = body.imageBase64;
    session.basePrompt = body.prompt;
    session.rounds.push(round);

    broadcast(body.sessionId, { type: 'round', round });
    res.json({ success: true, round });
  } catch (err: any) {
    console.error('[generate]', err);
    res.status(500).json({ success: false, error: err.message ?? String(err) });
  }
});

// ─── REST API: Refine ────────────────────────────────────────────────────────
interface RefineBody {
  sessionId: string;
  roundId: string;
  instruction: string;
  instructionParts?: { id: string; label: string; src: string; picIndex: number }[];
  newImagesBase64?: Record<number, string>;
  aspectRatio?: string;
  imageSize?: string;
}

app.post('/api/refine', async (req: Request, res: Response) => {
  try {
    const body = req.body as RefineBody;
    if (!body.sessionId || typeof body.sessionId !== 'string') {
      res.status(400).json({ success: false, error: 'sessionId is required' });
      return;
    }
    if (!body.roundId || typeof body.roundId !== 'string') {
      res.status(400).json({ success: false, error: 'roundId is required' });
      return;
    }
    if (!body.instruction || !body.instruction.trim()) {
      res.status(400).json({ success: false, error: 'instruction is required' });
      return;
    }
    const session = getOrCreateSession(body.sessionId);

    // Refuse manual refine while auto loop is running
    if (session.mode === 'auto' && session.status !== 'idle' && session.status !== 'done' && session.status !== 'error') {
      res.status(409).json({ success: false, error: '当前会话在自动模式中，请等待', code: 'INVALID_INPUT' });
      return;
    }

    const prevRound = session.rounds.find(r => r.id === body.roundId);
    if (!prevRound) {
      res.status(404).json({ success: false, error: 'Round not found' });
      return;
    }

    const result = await doRefine({
      baseImageBase64: session.baseImageBase64,
      basePrompt: session.basePrompt ?? '',
      prevImageBase64: prevRound.imageBase64,
      prevThoughtSignature: prevRound.thoughtSignature,
      prevModelDescription: prevRound.modelDescription,
      instruction: body.instruction,
      newImagesBase64: body.newImagesBase64,
      aspectRatio: body.aspectRatio,
      imageSize: body.imageSize,
    });

    const round: GenerationRound = {
      id: randomUUID(),
      turn: session.rounds.length,
      type: 'refine',
      prompt: session.basePrompt ?? '',
      instruction: body.instruction,
      imageBase64: result.imageBase64,
      thoughtSignature: result.thoughtSignature,
      modelDescription: result.modelDescription,
      converged: false,
      createdAt: Date.now(),
      contextSnapshot: result.contextSnapshot,
    };

    session.rounds.push(round);
    broadcast(body.sessionId, { type: 'round', round });
    res.json({ success: true, round });
  } catch (err: any) {
    console.error('[refine]', err);
    res.status(500).json({ success: false, error: err.message ?? String(err) });
  }
});

// ─── REST API: Reverse Prompt ─────────────────────────────────────────────────
interface ReverseBody {
  imageBase64: string;
  mode: 'text-to-image' | 'image-to-image';
}

app.post('/api/reverse', async (req: Request, res: Response) => {
  try {
    const body = req.body as ReverseBody;
    if (!body.imageBase64 || typeof body.imageBase64 !== 'string') {
      res.status(400).json({ success: false, error: 'imageBase64 is required' });
      return;
    }
    if (!isValidBase64(body.imageBase64)) {
      res.status(400).json({ success: false, error: 'imageBase64 is not valid base64' });
      return;
    }
    if (!body.mode || !['text-to-image', 'image-to-image'].includes(body.mode)) {
      res.status(400).json({ success: false, error: 'mode must be text-to-image or image-to-image' });
      return;
    }
    const result = await doReversePrompt(body.imageBase64, body.mode);
    res.json({ success: true, result });
  } catch (err: any) {
    console.error('[reverse]', err);
    res.status(500).json({ success: false, error: err.message ?? String(err) });
  }
});

// ─── REST API: Edit Image ─────────────────────────────────────────────────────
interface EditBody {
  sessionId: string;
  roundId: string;
  prompt: string;
  editMode: 'BGSWAP' | 'INPAINT_REMOVAL' | 'INPAINT_INSERTION' | 'STYLE';
}

app.post('/api/edit', async (req: Request, res: Response) => {
  try {
    const body = req.body as EditBody;
    if (!body.sessionId || typeof body.sessionId !== 'string') {
      res.status(400).json({ success: false, error: 'sessionId is required' });
      return;
    }
    if (!body.roundId || typeof body.roundId !== 'string') {
      res.status(400).json({ success: false, error: 'roundId is required' });
      return;
    }
    if (!body.prompt || typeof body.prompt !== 'string') {
      res.status(400).json({ success: false, error: 'prompt is required' });
      return;
    }
    const validEditModes = ['BGSWAP', 'INPAINT_REMOVAL', 'INPAINT_INSERTION', 'STYLE'];
    if (!body.editMode || !validEditModes.includes(body.editMode)) {
      res.status(400).json({ success: false, error: `editMode must be one of: ${validEditModes.join(', ')}` });
      return;
    }
    const session = getOrCreateSession(body.sessionId);
    const round = session.rounds.find(r => r.id === body.roundId);
    if (!round) {
      res.status(404).json({ success: false, error: 'Round not found' });
      return;
    }

    const result = await doEdit({
      imageBase64: round.imageBase64,
      prompt: body.prompt,
      editMode: body.editMode,
    });

    const newRound: GenerationRound = {
      id: randomUUID(),
      turn: session.rounds.length,
      type: 'edit',
      prompt: round.prompt,
      instruction: body.prompt,
      imageBase64: result.imageBase64,
      converged: false,
      createdAt: Date.now(),
    };

    session.rounds.push(newRound);
    broadcast(body.sessionId, { type: 'round', round: newRound });
    res.json({ success: true, round: newRound });
  } catch (err: any) {
    console.error('[edit]', err);
    res.status(500).json({ success: false, error: err.message ?? String(err) });
  }
});

// ─── REST API: Judge (LAAJ) ───────────────────────────────────────────────────
interface JudgeBody {
  imageBase64: string;
  prompt: string;
  dimensions?: string[];
  threshold?: number;
  signal?: AbortSignal;
  cachedContent?: string;
}

app.post('/api/judge', async (req: Request, res: Response) => {
  try {
    const body = req.body as JudgeBody;
    if (!body.imageBase64 || typeof body.imageBase64 !== 'string') {
      res.status(400).json({ success: false, error: 'imageBase64 is required' });
      return;
    }
    if (!isValidBase64(body.imageBase64)) {
      res.status(400).json({ success: false, error: 'imageBase64 is not valid base64' });
      return;
    }
    if (!body.prompt || !body.prompt.trim()) {
      res.status(400).json({ success: false, error: 'prompt is required' });
      return;
    }
    const result = await doJudge(body);
    res.json({ success: true, result });
  } catch (err: any) {
    console.error('[judge]', err);
    res.status(500).json({ success: false, error: err.message ?? String(err) });
  }
});

// ─── REST API: Session state ──────────────────────────────────────────────────
app.get('/api/session/:sessionId', (req: Request, res: Response) => {
  const session = sessions.get(req.params.sessionId);
  res.json({ exists: !!session, rounds: session?.rounds ?? [] });
});

// ─── REST API: Session status ─────────────────────────────────────────────────
app.get('/api/session/:sessionId/status', (req: Request, res: Response) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) {
    res.status(404).json({ success: false, error: 'Session not found' });
    return;
  }
  const lastRound = session.rounds[session.rounds.length - 1] ?? null;
  const refineCount = session.rounds.filter(r => r.type === 'refine').length;
  res.json({
    success: true,
    status: session.status,
    mode: session.mode,
    roundsCount: session.rounds.length,
    refineCount,
    maxRounds: session.maxRounds,
    currentRound: lastRound,
    converged: lastRound?.converged ?? false,
    currentTask: session.currentTask ?? null,
    error: session.error ?? null,
  });
});

// ─── REST API: Export session ─────────────────────────────────────────────────
app.get('/api/session/:sessionId/export', (req: Request, res: Response) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) {
    res.status(404).json({ success: false, error: 'Session not found' });
    return;
  }
  res.json({
    success: true,
    export: {
      exportedAt: new Date().toISOString(),
      version: '1.0',
      sessionId: session.id,
      mode: session.mode,
      maxRounds: session.maxRounds,
      status: session.status,
      rounds: session.rounds,
    },
  });
});

// ─── REST API: Abort auto loop ────────────────────────────────────────────────
app.post('/api/session/:sessionId/abort', (req: Request, res: Response) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) {
    res.status(404).json({ success: false, error: 'Session not found' });
    return;
  }
  if (!session.abortController) {
    res.json({ success: true, aborted: false, message: 'No active auto loop to abort' });
    return;
  }
  session.abortController.abort(new Error('User requested abort'));
  res.json({ success: true, aborted: true });
});

// ─── REST API: Context Snapshot ───────────────────────────────────────────────
app.get('/api/session/:sessionId/snapshot', (req: Request, res: Response) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) {
    res.status(404).json({ success: false, error: 'Session not found' });
    return;
  }

  const allTurns: TurnSnapshot[] = [];
  let totalImages = 0;

  for (const round of session.rounds) {
    if (round.contextSnapshot) {
      for (const turn of round.contextSnapshot) {
        allTurns.push({
          ...turn,
          metadata: { ...turn.metadata, roundId: round.id },
        });
        totalImages += turn.parts.filter(p => p.type === 'image').length;
      }
    }
  }

  const lastRound = session.rounds[session.rounds.length - 1];
  const hasValidThoughtSignature = !!lastRound?.thoughtSignature;

  const snapshot: ContextSnapshot = {
    sessionId: session.id,
    turns: allTurns,
    currentStatus: {
      hasValidThoughtSignature,
      mode: hasValidThoughtSignature ? 'multi-turn' : 'single-turn',
      totalImages,
      totalTurns: allTurns.length,
    },
  };

  res.json({ success: true, snapshot });
});

// ─── REST API: Human-in-the-loop choices ──────────────────────────────────────
app.post('/api/choice/:choiceId', (req: Request, res: Response) => {
  const { choiceId } = req.params;
  const resolved = resolveChoice(choiceId, req.body);
  res.json({ resolved });
});

app.get('/api/choices/:sessionId', (req: Request, res: Response) => {
  const { sessionId } = req.params;
  const choices = Array.from(pendingChoices.values())
    .filter(c => c.sessionId === sessionId)
    .map(c => ({ id: c.id, type: c.type, payload: c.payload, createdAt: c.createdAt }));
  res.json({ choices });
});

app.post('/api/cancel-choice/:choiceId', (req: Request, res: Response) => {
  const { choiceId } = req.params;
  const { reason } = req.body as { reason?: string };
  const cancelled = rejectChoice(choiceId, reason ?? 'User cancelled');
  res.json({ cancelled });
});

// ─── Test helpers (only available in non-production) ───────────────────────────
if (process.env.NODE_ENV !== 'production') {
  app.post('/api/test/create-choice', (req: Request, res: Response) => {
    const { sessionId, type, payload } = req.body as { sessionId: string; type: string; payload: unknown };
    const id = randomUUID();
    const timeout = setTimeout(() => {
      pendingChoices.delete(id);
    }, 300_000);
    pendingChoices.set(id, {
      id, sessionId, type, payload,
      resolve: () => {}, reject: () => {},
      timeout, createdAt: Date.now(),
    });
    broadcast(sessionId, { type: 'choice-request', choiceId: id, choiceType: type, payload });
    res.json({ choiceId: id });
  });
}

// ─── Static files ─────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'dist')));

// ─── Gemini API helpers ───────────────────────────────────────────────────────

interface GenerateResult {
  imageBase64: string;
  thoughtSignature?: string;
  modelDescription?: string;
  contextSnapshot: TurnSnapshot[];
}

async function doGenerate(params: {
  imageBase64?: string;
  prompt: string;
  aspectRatio: string;
  imageSize: string;
  thinkingLevel: 'minimal' | 'high';
  extraImagesBase64?: string[];
  styleRefBase64?: string;
  signal?: AbortSignal;
}): Promise<GenerateResult> {
  const parts: Part[] = [];
  const userParts: PartSnapshot[] = [];

  if (params.styleRefBase64) {
    parts.push({ inlineData: { data: params.styleRefBase64, mimeType: 'image/jpeg' } });
    parts.push({ text: `STYLE REFERENCE — COPY ONLY: COMPOSITION, LIGHTING, BACKGROUND. NEVER COPY: SUBJECT, COLOR, LABELS, PACKAGING.` });
    userParts.push({ type: 'image', content: '(base64)', label: '风格参考', detail: 'STYLE REFERENCE' });
    userParts.push({ type: 'text', content: 'STYLE REFERENCE — COPY ONLY: COMPOSITION, LIGHTING, BACKGROUND...', label: '风格说明' });
  }

  if (params.imageBase64) {
    parts.push({ inlineData: { data: params.imageBase64, mimeType: 'image/jpeg' } });
    userParts.push({ type: 'image', content: '(base64)', label: '原图', detail: '主体图' });
  }

  const extras = (params.extraImagesBase64 ?? []).slice(0, 9);
  for (let i = 0; i < extras.length; i++) {
    parts.push({ inlineData: { data: extras[i], mimeType: 'image/jpeg' } });
    userParts.push({ type: 'image', content: '(base64)', label: `额外参考 ${i + 1}`, detail: `extra-${i}` });
  }

  parts.push({ text: params.prompt });
  userParts.push({ type: 'text', content: params.prompt, label: '生成指令', detail: `prompt` });

  const thinkingLevelEnum = params.thinkingLevel === 'high' ? ThinkingLevel.HIGH : ThinkingLevel.MINIMAL;
  const config: GenerateContentConfig = {
    responseModalities: ['TEXT', 'IMAGE'],
    imageConfig: { aspectRatio: params.aspectRatio, imageSize: params.imageSize },
    thinkingConfig: { thinkingLevel: thinkingLevelEnum, includeThoughts: true },
    abortSignal: params.signal,
  };

  const response = await ai.models.generateContent({
    model: GENERATION_MODEL,
    contents: [{ role: 'user', parts }],
    config,
  });

  const responseParts: Part[] = response.candidates?.[0]?.content?.parts ?? [];
  const img = responseParts.find(p => p.inlineData?.mimeType?.startsWith('image/'));
  if (!img?.inlineData?.data) throw new Error('Model did not return an image');

  const thoughtSignature = img.thoughtSignature ?? undefined;
  const descPart = responseParts.find(p => p.text && !p.thought);
  const modelDescription = descPart?.text?.trim()
    ? (descPart.text.startsWith('RENDER:') ? descPart.text.slice(7).trim() : descPart.text.trim()).slice(0, 500)
    : undefined;

  const modelParts: PartSnapshot[] = [
    { type: 'image', content: '(base64)', label: '生成结果', detail: thoughtSignature ? `thoughtSignature: ${thoughtSignature.slice(0, 16)}...` : '无 thoughtSignature' },
  ];
  if (modelDescription) {
    modelParts.push({ type: 'text', content: modelDescription, label: '模型自描述', detail: 'RENDER' });
  }

  const contextSnapshot: TurnSnapshot[] = [
    {
      turn: 0,
      type: 'user',
      role: 'generate',
      parts: userParts,
      metadata: { timestamp: Date.now() },
    },
    {
      turn: 1,
      type: 'model',
      role: 'model-response',
      parts: modelParts,
      metadata: { thoughtSignature, modelDescription, timestamp: Date.now() },
    },
  ];

  return {
    imageBase64: img.inlineData.data,
    thoughtSignature,
    modelDescription,
    contextSnapshot,
  };
}

async function doRefine(params: {
  baseImageBase64?: string;
  basePrompt?: string;
  prevImageBase64: string;
  prevThoughtSignature?: string;
  prevModelDescription?: string;
  instruction: string;
  newImagesBase64?: Record<number, string>;
  aspectRatio?: string;
  imageSize?: string;
  signal?: AbortSignal;
}): Promise<GenerateResult> {
  const hasSig = !!params.prevThoughtSignature;

  // Build turn0 parts
  const turn0Parts: Part[] = [];
  const turn0Snapshots: PartSnapshot[] = [];
  if (params.baseImageBase64) {
    turn0Parts.push({ inlineData: { data: params.baseImageBase64, mimeType: 'image/jpeg' } });
    turn0Snapshots.push({ type: 'image', content: '(base64)', label: '原图', detail: 'base image' });
  }
  turn0Parts.push({ text: params.basePrompt ?? '' });
  turn0Snapshots.push({ type: 'text', content: params.basePrompt ?? '', label: '基础 Prompt', detail: 'base prompt' });

  // Build turn1 (model) parts with thoughtSignature
  const turn1Parts: Part[] = [];
  const turn1Snapshots: PartSnapshot[] = [];
  if (params.prevModelDescription) {
    turn1Parts.push({
      text: params.prevModelDescription,
      thoughtSignature: params.prevThoughtSignature,
    });
    turn1Snapshots.push({ type: 'text', content: params.prevModelDescription, label: '模型自描述', detail: 'thoughtSignature present' });
  }
  turn1Parts.push({
    inlineData: { data: params.prevImageBase64, mimeType: 'image/jpeg' },
    thoughtSignature: params.prevThoughtSignature,
  });
  turn1Snapshots.push({ type: 'image', content: '(base64)', label: '上次渲染结果', detail: hasSig ? `thoughtSignature: ${params.prevThoughtSignature!.slice(0, 16)}...` : '无 thoughtSignature' });

  // Build turn2 (user) parts — interleave instruction with new images
  let turn2Text = params.instruction;
  const picMap = new Map<number, Part>();
  const picMapSnapshots = new Map<number, PartSnapshot>();
  if (params.newImagesBase64) {
    for (const [idx, b64] of Object.entries(params.newImagesBase64)) {
      picMap.set(Number(idx), { inlineData: { data: b64, mimeType: 'image/jpeg' } });
      picMapSnapshots.set(Number(idx), { type: 'image', content: '(base64)', label: `新图 [pic_${idx}]`, detail: `user-uploaded-${idx}` });
    }
  }
  const turn2Parts = interleaveInstructionParts(turn2Text, picMap);

  // Build turn2 snapshot parts
  const turn2Snapshots: PartSnapshot[] = [];
  const regex = /\[pic_(\d+)\]/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(turn2Text)) !== null) {
    if (match.index > lastIndex) {
      const text = turn2Text.slice(lastIndex, match.index);
      turn2Snapshots.push({ type: 'text', content: text, label: '指令文本', detail: 'instruction' });
    }
    const picSnap = picMapSnapshots.get(parseInt(match[1], 10));
    if (picSnap) turn2Snapshots.push(picSnap);
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < turn2Text.length) {
    turn2Snapshots.push({ type: 'text', content: turn2Text.slice(lastIndex), label: '指令文本', detail: 'instruction' });
  }

  const contents = hasSig
    ? [
        { role: 'user' as const, parts: turn0Parts },
        { role: 'model' as const, parts: turn1Parts },
        { role: 'user' as const, parts: turn2Parts },
      ]
    : [
        // Fallback: single-turn, prev render as reference
        { role: 'user' as const, parts: [...turn0Parts, { inlineData: { data: params.prevImageBase64, mimeType: 'image/jpeg' } }, ...turn2Parts] },
      ];

  const config: GenerateContentConfig = {
    responseModalities: ['TEXT', 'IMAGE'],
    imageConfig: {
      aspectRatio: params.aspectRatio ?? '1:1',
      imageSize: params.imageSize ?? '1K',
    },
    // No thinkingConfig in refine to reduce latency
    abortSignal: params.signal,
  };

  const response = await ai.models.generateContent({
    model: GENERATION_MODEL,
    contents,
    config,
  });

  const responseParts: Part[] = response.candidates?.[0]?.content?.parts ?? [];
  const img = responseParts.find(p => p.inlineData?.mimeType?.startsWith('image/'));
  if (!img?.inlineData?.data) throw new Error('Model did not return an image');

  const thoughtSignature = img.thoughtSignature ?? undefined;
  const descPart = responseParts.find(p => p.text && !p.thought);
  const modelDescription = descPart?.text?.trim()
    ? (descPart.text.startsWith('RENDER:') ? descPart.text.slice(7).trim() : descPart.text.trim()).slice(0, 500)
    : undefined;

  const modelParts: PartSnapshot[] = [
    { type: 'image', content: '(base64)', label: '精调结果', detail: thoughtSignature ? `thoughtSignature: ${thoughtSignature.slice(0, 16)}...` : '无 thoughtSignature' },
  ];
  if (modelDescription) {
    modelParts.push({ type: 'text', content: modelDescription, label: '模型自描述', detail: 'RENDER' });
  }

  const contextSnapshot: TurnSnapshot[] = [];
  if (hasSig) {
    contextSnapshot.push(
      { turn: 0, type: 'user', role: 'refine', parts: turn0Snapshots, metadata: { timestamp: Date.now() } },
      { turn: 1, type: 'model', role: 'model-response', parts: turn1Snapshots, metadata: { timestamp: Date.now() } },
      { turn: 2, type: 'user', role: 'refine', parts: turn2Snapshots, metadata: { timestamp: Date.now() } },
      { turn: 3, type: 'model', role: 'model-response', parts: modelParts, metadata: { thoughtSignature, modelDescription, timestamp: Date.now() } },
    );
  } else {
    // Single-turn fallback: merge turn0 + prev image + turn2 into one user turn
    const fallbackUserParts = [
      ...turn0Snapshots,
      { type: 'image', content: '(base64)', label: '上次渲染（降级参考）', detail: '无 thoughtSignature，作为普通参考图' } as PartSnapshot,
      ...turn2Snapshots,
    ];
    contextSnapshot.push(
      { turn: 0, type: 'user', role: 'refine', parts: fallbackUserParts, metadata: { timestamp: Date.now() } },
      { turn: 1, type: 'model', role: 'model-response', parts: modelParts, metadata: { thoughtSignature, modelDescription, timestamp: Date.now() } },
    );
  }

  return {
    imageBase64: img.inlineData.data,
    thoughtSignature,
    modelDescription,
    contextSnapshot,
  };
}

function interleaveInstructionParts(instruction: string, picMap: Map<number, Part>): Part[] {
  const parts: Part[] = [];
  const regex = /\[pic_(\d+)\]/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(instruction)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ text: instruction.slice(lastIndex, match.index) });
    }
    const picPart = picMap.get(parseInt(match[1], 10));
    if (picPart) parts.push(picPart);
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < instruction.length) {
    parts.push({ text: instruction.slice(lastIndex) });
  }
  return parts;
}

// ─── Edit Image (Imagen 3) ────────────────────────────────────────────────────

async function doEdit(params: {
  imageBase64: string;
  prompt: string;
  editMode: 'BGSWAP' | 'INPAINT_REMOVAL' | 'INPAINT_INSERTION' | 'STYLE';
}): Promise<{ imageBase64: string }> {
  const editModeMap: Record<string, EditMode> = {
    BGSWAP: EditMode.EDIT_MODE_BGSWAP,
    INPAINT_REMOVAL: EditMode.EDIT_MODE_INPAINT_REMOVAL,
    INPAINT_INSERTION: EditMode.EDIT_MODE_INPAINT_INSERTION,
    STYLE: EditMode.EDIT_MODE_STYLE,
  };

  const maskModeMap: Record<string, string> = {
    BGSWAP: 'MASK_MODE_BACKGROUND',
    INPAINT_REMOVAL: 'MASK_MODE_SEMANTIC',
    INPAINT_INSERTION: 'MASK_MODE_SEMANTIC',
    STYLE: 'MASK_MODE_DEFAULT',
  };

  const response = await ai.models.editImage({
    model: EDIT_MODEL,
    prompt: params.prompt,
    referenceImages: [
      new RawReferenceImage({
        referenceImage: { imageBytes: params.imageBase64, mimeType: 'image/jpeg' },
        referenceId: 1,
      }),
      new MaskReferenceImage({
        referenceId: 2,
        config: {
          maskMode: maskModeMap[params.editMode] as any,
        },
      }),
    ],
    config: {
      editMode: editModeMap[params.editMode],
      numberOfImages: 1,
    },
  });

  const edited = response.generatedImages?.[0]?.image?.imageBytes;
  if (!edited) throw new Error('editImage did not return an image');
  return { imageBase64: edited };
}

// ─── Reverse Prompt ───────────────────────────────────────────────────────────

interface ReverseResult {
  textPrompt?: string;
  segments?: Record<string, string>;
}

async function doReversePrompt(imageBase64: string, mode: 'text-to-image' | 'image-to-image'): Promise<ReverseResult> {
  if (mode === 'text-to-image') {
    const response = await ai.models.generateContent({
      model: JUDGE_MODEL,
      contents: [{
        role: 'user',
        parts: [
          { inlineData: { data: imageBase64, mimeType: 'image/jpeg' } },
          { text: `Analyze this image and write a detailed text-to-image prompt that could reproduce it.
Focus on: subject, style, lighting, composition, color palette, background, mood.
Output ONLY the prompt text, no explanations.` },
        ],
      }],
    });
    return { textPrompt: response.text ?? '' };
  }

  // image-to-image: map to segment structure
  const response = await ai.models.generateContent({
    model: JUDGE_MODEL,
    contents: [{
      role: 'user',
      parts: [
        { inlineData: { data: imageBase64, mimeType: 'image/jpeg' } },
        { text: `Analyze this image as if it were generated by a structured image-generation pipeline.
Map its visual properties to the following prompt segments and output valid JSON:

{
  "identity": "What is the subject? What are its key visual characteristics?",
  "canvas": "Aspect ratio, framing, how much of the frame the subject fills",
  "environment": "Background style, shadow type, lighting setup",
  "view": "Camera angle, composition, perspective",
  "material": "Surface textures, material types, finish quality",
  "style": "Overall art style, color palette, rendering technique",
  "quality": "Sharpness, clarity, professional standards observed"
}

Output ONLY the JSON. No markdown, no explanations.` },
      ],
    }],
  });

  const text = (response.text ?? '').trim();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Model did not return valid JSON segments');
  try {
    const segments = JSON.parse(jsonMatch[0]) as Record<string, string>;
    return { segments };
  } catch (e: any) {
    throw new Error(`Failed to parse reverse segments JSON: ${e.message}`);
  }
}

// ─── LAAJ Judge ───────────────────────────────────────────────────────────────

const JUDGE_SYSTEM_INSTRUCTION = `You are an expert quality evaluator for AI-generated images. Your role is to provide rigorous, actionable assessments that guide iterative refinement.

## Scoring Scale
- 5 (Excellent): Fully meets the standard; no meaningful issues
- 4 (Good): Meets standard with minor, non-distracting imperfections
- 3 (Acceptable): Partially meets standard; noticeable but tolerable issues
- 2 (Poor): Falls notably short; significant issues affecting usability
- 1 (Unacceptable): Fails to meet the standard; must be regenerated

## Common Evaluation Dimensions
- **subject_fidelity**: Accuracy of subject identity, shape, details, and visual characteristics vs. prompt
- **instruction_following**: Adherence to all explicit instructions (quantity, pose, placement, attributes)
- **composition**: Framing, balance, negative space, rule-of-thirds, visual hierarchy
- **lighting_quality**: Lighting realism, shadow accuracy, highlight handling, atmospheric consistency
- **overall_quality**: Technical execution — sharpness, artifact-free, professional standard

## Output Format
Always respond with ONLY valid JSON — no markdown, no prose, no code fences:
{
  "scores": {
    "<dimension_name>": {
      "score": <integer 1–5>,
      "notes": "<specific, actionable observation — what exactly is right or wrong>"
    }
  },
  "converged": <boolean — true ONLY when ALL dimension scores >= the stated threshold>,
  "topIssues": [
    {
      "issue": "<concise problem statement>",
      "fix": "<exact prompt language or technique to address this — be specific>"
    }
  ],
  "nextFocus": "<single highest-impact improvement direction for the next generation>"
}

## Example 1 — Product Photography

User message:
Evaluate this image. Original prompt: "A ceramic coffee mug on pure white background, professional studio lighting, product photography"
Dimensions: subject_fidelity, instruction_following, composition, lighting_quality, overall_quality
Convergence threshold: 4

Expected output:
{
  "scores": {
    "subject_fidelity": { "score": 4, "notes": "Mug shape and ceramic glaze well rendered; handle slightly thick compared to reference" },
    "instruction_following": { "score": 3, "notes": "Background has visible light grey cast instead of pure white" },
    "composition": { "score": 5, "notes": "Centered composition with generous negative space; excellent product framing" },
    "lighting_quality": { "score": 4, "notes": "Soft diffused studio light; slight hot-spot on handle upper edge" },
    "overall_quality": { "score": 4, "notes": "Sharp, professional quality; background issue is main detractor" }
  },
  "converged": false,
  "topIssues": [
    {
      "issue": "Background is light grey instead of pure white",
      "fix": "Add to prompt: 'absolutely pure white background, #ffffff, no grey tones, no gradients, no shadows on background'"
    }
  ],
  "nextFocus": "Enforce pure white background rendering"
}

## Example 2 — Character Art

User message:
Evaluate this image. Original prompt: "Anime girl with silver hair and blue eyes, wearing a red hoodie, standing in a park at sunset"
Dimensions: subject_fidelity, instruction_following, composition, lighting_quality, overall_quality
Convergence threshold: 4

Expected output:
{
  "scores": {
    "subject_fidelity": { "score": 5, "notes": "Silver hair, blue eyes, and red hoodie all correctly rendered with anime style" },
    "instruction_following": { "score": 4, "notes": "Park and sunset present; character is slightly off-center but park is clearly identifiable" },
    "composition": { "score": 4, "notes": "Three-quarter view works well; slight crowding at bottom edge" },
    "lighting_quality": { "score": 5, "notes": "Warm golden-hour backlighting with accurate rim light on hair" },
    "overall_quality": { "score": 4, "notes": "Clean anime style, good line quality, minor composition crop issue" }
  },
  "converged": true,
  "topIssues": [
    {
      "issue": "Subject slightly off-center and tight at bottom frame edge",
      "fix": "Add to prompt: 'centered composition, full body visible, generous space around character'"
    }
  ],
  "nextFocus": "Improve character framing and centering"
}`;

interface JudgeResult {
  scores: Record<string, { score: number; notes: string }>;
  converged: boolean;
  topIssues: Array<{ issue: string; fix: string }>;
  nextFocus: string;
}

async function doJudge(
  params: JudgeBody,
  onProgress?: (partial: string) => void,
): Promise<JudgeResult> {
  const dimensions = params.dimensions ?? ['subject_fidelity', 'instruction_following', 'composition', 'lighting_quality', 'overall_quality'];
  const threshold = params.threshold ?? 4;

  const userText = `Evaluate this image. Original prompt: "${params.prompt}"
Dimensions: ${dimensions.join(', ')}
Convergence threshold: ${threshold}`;

  const requestParams: Parameters<typeof ai.models.generateContent>[0] = {
    model: JUDGE_MODEL,
    contents: [{
      role: 'user' as const,
      parts: [
        { inlineData: { data: params.imageBase64, mimeType: 'image/jpeg' } },
        { text: userText },
      ],
    }],
    config: {
      thinkingConfig: { thinkingBudget: 0 },
      abortSignal: params.signal,
      ...(params.cachedContent
        ? { cachedContent: params.cachedContent }
        : { systemInstruction: { parts: [{ text: JUDGE_SYSTEM_INSTRUCTION }] } }),
    },
  };

  let text: string;
  if (onProgress) {
    // Streaming mode — push partial JSON to callback as it arrives
    const stream = await ai.models.generateContentStream(requestParams);
    let accumulated = '';
    for await (const chunk of stream) {
      const delta = chunk.text ?? '';
      if (delta) {
        accumulated += delta;
        onProgress(accumulated);
      }
    }
    text = accumulated.trim();
  } else {
    const response = await ai.models.generateContent(requestParams);
    text = (response.text ?? '').trim();
  }

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Judge returned no JSON');
  let raw: any;
  try {
    raw = JSON.parse(jsonMatch[0]);
  } catch (e: any) {
    throw new Error(`Failed to parse judge JSON: ${e.message}`);
  }

  const allScores = Object.values(raw.scores as Record<string, { score: number }>).map(s => s.score);
  const converged = allScores.length > 0 && allScores.every(s => s >= threshold) && !!raw.converged;

  return {
    scores: raw.scores,
    converged,
    topIssues: raw.topIssues ?? [],
    nextFocus: raw.nextFocus ?? '',
  };
}

// ─── Auto-Refine Loop ─────────────────────────────────────────────────────────

async function runAutoRefine(session: Session): Promise<void> {
  // session.abortController must be set by the caller before invoking this function
  const sig = session.abortController?.signal;

  // Create judge cache once for the full loop (degrades gracefully on failure)
  let judgeCache: string | undefined;
  try {
    const cache = await ai.caches.create({
      model: JUDGE_MODEL,
      config: {
        displayName: `judge-${session.id.slice(0, 8)}`,
        ttl: '1800s',
        systemInstruction: { parts: [{ text: JUDGE_SYSTEM_INSTRUCTION }] },
      },
    });
    judgeCache = cache.name ?? undefined;
    console.log(`[cache] judge cache created: ${judgeCache}`);
  } catch (err) {
    console.warn('[cache] judge cache creation failed, proceeding without cache:', (err as any)?.message);
  }

  try {
    while (!sig?.aborted) {
      const currentRound = session.rounds[session.rounds.length - 1];
      if (!currentRound) {
        setSessionError(session, 'MODEL_ERROR', 'runAutoRefine called with empty rounds');
        return;
      }
      const refineCount = session.rounds.filter(r => r.type === 'refine').length;

      // Judge current round
      setSessionStatus(session, 'judging', {
        type: 'judge',
        roundId: currentRound.id,
        startedAt: Date.now(),
      });

      let judgeResult: JudgeResult;
      try {
        judgeResult = await withGeminiCall(
          (s) => doJudge(
            { imageBase64: currentRound.imageBase64, prompt: session.basePrompt ?? '', signal: s, cachedContent: judgeCache },
            (partial) => broadcast(session.id, { type: 'judge-progress', roundId: currentRound.id, partial }),
          ),
          { signal: sig },
        );
      } catch (err: unknown) {
        if (isAbortError(err)) break;
        setSessionError(session, classifyError(err), (err as any)?.message ?? String(err), currentRound.id);
        return;
      }

      // Patch round with judge results and broadcast update
      currentRound.converged = judgeResult.converged;
      currentRound.scores = judgeResult.scores;
      currentRound.topIssues = judgeResult.topIssues;
      currentRound.nextFocus = judgeResult.nextFocus;
      broadcast(session.id, { type: 'round-updated', round: currentRound });

      if (judgeResult.converged || refineCount >= session.maxRounds) {
        setSessionStatus(session, 'done');
        return;
      }

      const instruction = judgeResult.topIssues[0]?.fix?.trim() ?? judgeResult.nextFocus?.trim();
      if (!instruction) {
        setSessionStatus(session, 'done');
        return;
      }

      if (sig?.aborted) break;

      // Refine
      setSessionStatus(session, 'refining', {
        type: 'refine',
        roundId: currentRound.id,
        startedAt: Date.now(),
      });

      let refineResult: GenerateResult;
      try {
        refineResult = await withGeminiCall(
          (s) => doRefine({
            baseImageBase64: session.baseImageBase64,
            basePrompt: session.basePrompt ?? '',
            prevImageBase64: currentRound.imageBase64,
            prevThoughtSignature: currentRound.thoughtSignature,
            prevModelDescription: currentRound.modelDescription,
            instruction,
            signal: s,
          }),
          { signal: sig },
        );
      } catch (err: unknown) {
        if (isAbortError(err)) break;
        setSessionError(session, classifyError(err), (err as any)?.message ?? String(err), currentRound.id);
        return;
      }

      const newRound: GenerationRound = {
        id: randomUUID(),
        turn: session.rounds.length,
        type: 'refine',
        prompt: session.basePrompt ?? '',
        instruction,
        imageBase64: refineResult.imageBase64,
        thoughtSignature: refineResult.thoughtSignature,
        modelDescription: refineResult.modelDescription,
        converged: false,
        createdAt: Date.now(),
        contextSnapshot: refineResult.contextSnapshot,
      };

      session.rounds.push(newRound);
      broadcast(session.id, { type: 'round', round: newRound });
    }
  } finally {
    // Always clean up judge cache — runs on return, break, or throw
    if (judgeCache) {
      ai.caches.delete({ name: judgeCache }).catch((err) => {
        console.warn('[cache] judge cache delete failed:', (err as any)?.message);
      });
      console.log(`[cache] judge cache deleted: ${judgeCache}`);
    }
  }

  // Only reached when loop exits via break (abort path)
  setSessionStatus(session, 'idle');
  session.mode = 'manual';
  broadcast(session.id, { type: 'aborted' });
}

// ─── MCP Server ─────────────────────────────────────────────────────────────────

const mcpServer = new Server(
  { name: 'gemini-imagen-studio', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'open_image_studio',
      description: 'Open the Gemini Image Studio web UI in a browser. Returns the URL.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'Optional session ID to resume an existing session' },
        },
      },
    },
    {
      name: 'generate_image',
      description: 'Generate an image using Gemini. Set autoRefine=true to start the full auto-loop (generate -> judge -> refine until converged). When autoRefine is enabled, use get_session_status to poll for completion.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'Session ID to track this generation' },
          imageBase64: { type: 'string', description: 'Optional subject image (for image-to-image)' },
          prompt: { type: 'string', description: 'Generation prompt' },
          aspectRatio: { type: 'string', enum: ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'] },
          imageSize: { type: 'string', enum: ['1K', '2K', '4K'] },
          thinkingLevel: { type: 'string', enum: ['minimal', 'high'] },
          autoRefine: { type: 'boolean', description: 'If true, automatically run LAAJ and refine in a loop until converged or maxRounds reached' },
          maxRounds: { type: 'number', description: 'Maximum refinement rounds when autoRefine=true (default 3)' },
        },
        required: ['sessionId', 'prompt'],
      },
    },
    {
      name: 'refine_image',
      description: 'Refine a previously generated image using multi-turn with thoughtSignature.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
          roundId: { type: 'string', description: 'The round ID to refine from' },
          instruction: { type: 'string', description: 'Refinement instruction' },
        },
        required: ['sessionId', 'roundId', 'instruction'],
      },
    },
    {
      name: 'edit_image',
      description: 'Edit an existing image using Imagen 3 pixel-level editing (background swap, inpaint removal/insertion, style transfer). Does not return thoughtSignature.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
          roundId: { type: 'string', description: 'The round ID to edit' },
          prompt: { type: 'string', description: 'Edit instruction, e.g. "Replace background with pure white"' },
          editMode: { type: 'string', enum: ['BGSWAP', 'INPAINT_REMOVAL', 'INPAINT_INSERTION', 'STYLE'], description: 'Editing mode' },
        },
        required: ['sessionId', 'roundId', 'prompt', 'editMode'],
      },
    },
    {
      name: 'get_session_status',
      description: 'Get the current status of a session (idle, generating, judging, refining, done, error). Use this to poll when autoRefine is running.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
        },
        required: ['sessionId'],
      },
    },
    {
      name: 'abort_session',
      description: 'Abort an active auto-refine loop and return control to manual mode.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
        },
        required: ['sessionId'],
      },
    },
    {
      name: 'export_session',
      description: 'Export all rounds and metadata of a session as JSON.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
        },
        required: ['sessionId'],
      },
    },
    {
      name: 'reverse_prompt',
      description: 'Reverse-engineer a prompt from an image. Mode "text-to-image" returns a plain prompt. Mode "image-to-image" returns structured segments.',
      inputSchema: {
        type: 'object',
        properties: {
          imageBase64: { type: 'string' },
          mode: { type: 'string', enum: ['text-to-image', 'image-to-image'] },
        },
        required: ['imageBase64', 'mode'],
      },
    },
    {
      name: 'judge_image',
      description: 'Run LLM-as-a-Judge (LAAJ) evaluation on a generated image. Returns scores and improvement suggestions.',
      inputSchema: {
        type: 'object',
        properties: {
          imageBase64: { type: 'string' },
          prompt: { type: 'string', description: 'The prompt used to generate this image' },
          dimensions: { type: 'array', items: { type: 'string' } },
          threshold: { type: 'number', description: 'Score threshold for convergence (default 4)' },
        },
        required: ['imageBase64', 'prompt'],
      },
    },
    {
      name: 'choose_best',
      description: 'Ask the user to choose between two generated images via the web UI. Blocks until user makes a selection or times out.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'Session ID' },
          roundA: { type: 'string', description: 'Round ID of option A' },
          roundB: { type: 'string', description: 'Round ID of option B' },
          question: { type: 'string', description: 'Question to show the user, e.g. "Which pose looks more natural?"' },
        },
        required: ['sessionId', 'roundA', 'roundB'],
      },
    },
    {
      name: 'await_input',
      description: 'Wait for the user to provide a refinement instruction via the web UI. Blocks until input is received or times out.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'Session ID' },
          hint: { type: 'string', description: 'Hint text to show the user, e.g. "What would you like to change?"' },
          timeoutMs: { type: 'number', description: 'Timeout in milliseconds (default 300000)' },
        },
        required: ['sessionId'],
      },
    },
  ],
}));

mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'open_image_studio': {
        const sessionId = (args?.sessionId as string) ?? randomUUID();
        getOrCreateSession(sessionId);
        const url = `http://localhost:${PORT}?session=${sessionId}`;
        return {
          content: [{ type: 'text' as const, text: `Image Studio opened at: ${url}` }],
        };
      }

      case 'generate_image': {
        const { sessionId, imageBase64, prompt, aspectRatio, imageSize, thinkingLevel, autoRefine, maxRounds } = args as any;
        const session = getOrCreateSession(sessionId);

        if (autoRefine) {
          const busy = session.status !== 'idle' && session.status !== 'done' && session.status !== 'error';
          if (busy) {
            return {
              content: [{ type: 'text' as const, text: `Session is ${session.status}. Please wait or use a new session.` }],
              isError: true,
            };
          }
          session.mode = 'auto';
          session.maxRounds = maxRounds ?? 3;
          session.rounds = [];
          session.baseImageBase64 = imageBase64;
          session.basePrompt = prompt;

          const ctrl = new AbortController();
          session.abortController = ctrl;
          void (async () => {
            const sig = ctrl.signal;
            try {
              setSessionStatus(session, 'generating', { type: 'generate', startedAt: Date.now() });
              const result = await withGeminiCall(
                (s) => doGenerate({
                  imageBase64,
                  prompt,
                  aspectRatio: aspectRatio ?? '1:1',
                  imageSize: imageSize ?? '1K',
                  thinkingLevel: thinkingLevel ?? 'minimal',
                  signal: s,
                }),
                { signal: sig },
              );
              if (sig.aborted) { setSessionStatus(session, 'idle'); session.mode = 'manual'; return; }
              const round: GenerationRound = {
                id: randomUUID(),
                turn: 0,
                type: 'generate',
                prompt,
                imageBase64: result.imageBase64,
                thoughtSignature: result.thoughtSignature,
                modelDescription: result.modelDescription,
                converged: false,
                createdAt: Date.now(),
                contextSnapshot: result.contextSnapshot,
              };
              session.rounds.push(round);
              broadcast(sessionId, { type: 'round', round });
              await runAutoRefine(session);
            } catch (err: unknown) {
              if (isAbortError(err)) {
                setSessionStatus(session, 'idle');
                session.mode = 'manual';
                broadcast(sessionId, { type: 'aborted' });
              } else {
                setSessionError(session, classifyError(err), (err as any)?.message ?? String(err));
              }
            } finally {
              if (session.abortController === ctrl) session.abortController = undefined;
            }
          })();

          return {
            content: [
              { type: 'text' as const, text: `Auto-refine started (max ${session.maxRounds} rounds). Poll status with get_session_status(sessionId="${sessionId}").` },
            ],
          };
        }

        // Manual mode
        session.mode = 'manual';
        const result = await doGenerate({
          imageBase64,
          prompt,
          aspectRatio: aspectRatio ?? '1:1',
          imageSize: imageSize ?? '1K',
          thinkingLevel: thinkingLevel ?? 'minimal',
        });
        const round: GenerationRound = {
          id: randomUUID(),
          turn: session.rounds.length,
          type: 'generate',
          prompt,
          imageBase64: result.imageBase64,
          thoughtSignature: result.thoughtSignature,
          modelDescription: result.modelDescription,
          converged: false,
          createdAt: Date.now(),
          contextSnapshot: result.contextSnapshot,
        };
        if (imageBase64) session.baseImageBase64 = imageBase64;
        session.basePrompt = prompt;
        session.rounds.push(round);
        broadcast(sessionId, { type: 'round', round });
        return {
          content: [
            { type: 'text' as const, text: `Generated image (round ${round.turn}). Model description: ${result.modelDescription ?? 'none'}` },
            { type: 'image' as const, data: result.imageBase64, mimeType: 'image/png' },
          ],
        };
      }

      case 'refine_image': {
        const { sessionId, roundId, instruction } = args as any;
        const session = getOrCreateSession(sessionId);
        if (session.mode === 'auto' && session.status !== 'idle' && session.status !== 'done' && session.status !== 'error') {
          return {
            content: [{ type: 'text' as const, text: `Session is in auto mode (${session.status}). Please wait or call abort_session first.` }],
            isError: true,
          };
        }
        const prevRound = session.rounds.find(r => r.id === roundId);
        if (!prevRound) throw new Error('Round not found');
        const result = await doRefine({
          baseImageBase64: session.baseImageBase64,
          basePrompt: session.basePrompt,
          prevImageBase64: prevRound.imageBase64,
          prevThoughtSignature: prevRound.thoughtSignature,
          prevModelDescription: prevRound.modelDescription,
          instruction,
        });
        const round: GenerationRound = {
          id: randomUUID(),
          turn: session.rounds.length,
          type: 'refine',
          prompt: session.basePrompt ?? '',
          instruction,
          imageBase64: result.imageBase64,
          thoughtSignature: result.thoughtSignature,
          modelDescription: result.modelDescription,
          converged: false,
          createdAt: Date.now(),
        };
        session.rounds.push(round);
        broadcast(sessionId, { type: 'round', round });
        return {
          content: [
            { type: 'text' as const, text: `Refined image (round ${round.turn}). Model description: ${result.modelDescription ?? 'none'}` },
            { type: 'image' as const, data: result.imageBase64, mimeType: 'image/png' },
          ],
        };
      }

      case 'reverse_prompt': {
        const { imageBase64, mode } = args as any;
        const result = await doReversePrompt(imageBase64, mode);
        if (result.textPrompt) {
          return { content: [{ type: 'text' as const, text: `Reversed text-to-image prompt:\n${result.textPrompt}` }] };
        }
        return { content: [{ type: 'text' as const, text: `Reversed image-to-image segments:\n${JSON.stringify(result.segments, null, 2)}` }] };
      }

      case 'judge_image': {
        const { imageBase64, prompt, dimensions, threshold } = args as any;
        const result = await doJudge({ imageBase64, prompt, dimensions, threshold });
        return {
          content: [{ type: 'text' as const, text: `LAAJ Evaluation:\n${JSON.stringify(result, null, 2)}` }],
        };
      }

      case 'choose_best': {
        const { sessionId, roundA, roundB, question } = args as any;
        const session = getOrCreateSession(sessionId);
        const a = session.rounds.find(r => r.id === roundA);
        const b = session.rounds.find(r => r.id === roundB);
        if (!a || !b) throw new Error('One or both rounds not found');
        const result = await createChoice<{ choice: 'A' | 'B'; reason?: string }>(sessionId, 'ab_compare', {
          question: question ?? 'Which image do you prefer?',
          optionA: { roundId: a.id, turn: a.turn, imageBase64: a.imageBase64 },
          optionB: { roundId: b.id, turn: b.turn, imageBase64: b.imageBase64 },
        });
        return {
          content: [{ type: 'text' as const, text: `User chose: ${result.choice} (${result.reason ?? 'no reason given'})` }],
        };
      }

      case 'await_input': {
        const { sessionId, hint, timeoutMs } = args as any;
        const result = await createChoice<{ instruction: string }>(
          sessionId,
          'await_input',
          { hint: hint ?? 'What would you like to change?' },
          timeoutMs ?? 300_000,
        );
        return {
          content: [{ type: 'text' as const, text: `User input: ${result.instruction}` }],
        };
      }

      case 'edit_image': {
        const { sessionId, roundId, prompt, editMode } = args as any;
        const validEditModes = ['BGSWAP', 'INPAINT_REMOVAL', 'INPAINT_INSERTION', 'STYLE'];
        if (!validEditModes.includes(editMode)) {
          return {
            content: [{ type: 'text' as const, text: `editMode must be one of: ${validEditModes.join(', ')}` }],
            isError: true,
          };
        }
        const session = getOrCreateSession(sessionId);
        const round = session.rounds.find(r => r.id === roundId);
        if (!round) throw new Error('Round not found');
        const result = await doEdit({ imageBase64: round.imageBase64, prompt, editMode });
        const newRound: GenerationRound = {
          id: randomUUID(),
          turn: session.rounds.length,
          type: 'edit',
          prompt: round.prompt,
          instruction: prompt,
          imageBase64: result.imageBase64,
          converged: false,
          createdAt: Date.now(),
        };
        session.rounds.push(newRound);
        broadcast(sessionId, { type: 'round', round: newRound });
        return {
          content: [
            { type: 'text' as const, text: `Edited image (round ${newRound.turn}).` },
            { type: 'image' as const, data: result.imageBase64, mimeType: 'image/png' },
          ],
        };
      }

      case 'get_session_status': {
        const { sessionId } = args as any;
        const session = sessions.get(sessionId);
        if (!session) throw new Error('Session not found');
        const lastRound = session.rounds[session.rounds.length - 1] ?? null;
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              status: session.status,
              mode: session.mode,
              roundsCount: session.rounds.length,
              refineCount: session.rounds.filter(r => r.type === 'refine').length,
              maxRounds: session.maxRounds,
              converged: lastRound?.converged ?? false,
              currentTask: session.currentTask ?? null,
              error: session.error ?? null,
            }, null, 2),
          }],
        };
      }

      case 'abort_session': {
        const { sessionId } = args as any;
        const session = sessions.get(sessionId);
        if (!session) throw new Error('Session not found');
        if (!session.abortController) {
          return { content: [{ type: 'text' as const, text: 'No active auto loop to abort' }] };
        }
        session.abortController.abort(new Error('User requested abort'));
        return { content: [{ type: 'text' as const, text: 'Auto loop aborted. Session returned to manual mode.' }] };
      }

      case 'export_session': {
        const { sessionId } = args as any;
        const session = sessions.get(sessionId);
        if (!session) throw new Error('Session not found');
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              exportedAt: new Date().toISOString(),
              version: '1.0',
              sessionId: session.id,
              mode: session.mode,
              maxRounds: session.maxRounds,
              status: session.status,
              rounds: session.rounds,
            }, null, 2),
          }],
        };
      }

      default:
        return { content: [{ type: 'text' as const, text: `Unknown tool: ${name}` }], isError: true };
    }
  } catch (err: any) {
    return { content: [{ type: 'text' as const, text: `Error: ${err.message ?? String(err)}` }], isError: true };
  }
});

// ─── MCP SSE endpoint ─────────────────────────────────────────────────────────

let transport: SSEServerTransport | null = null;

app.get('/mcp/sse', async (_req: Request, res: Response) => {
  transport = new SSEServerTransport('/mcp/message', res);
  await mcpServer.connect(transport);
});

app.post('/mcp/message', async (req: Request, res: Response) => {
  if (!transport) {
    res.status(400).json({ error: 'No active SSE connection' });
    return;
  }
  // Pass req.body as parsedBody because express.json() already consumed the stream
  await transport.handlePostMessage(req, res, req.body);
});

// ─── Catch-all (must be LAST) ─────────────────────────────────────────────────
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

// ─── Start server ─────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`[server] Image Studio running at http://localhost:${PORT}`);
  console.log(`[mcp]    MCP SSE endpoint at http://localhost:${PORT}/mcp/sse`);
  setInterval(cleanupExpiredSessions, SESSION_CLEANUP_INTERVAL_MS);
  console.log(`[cleanup] Session TTL: ${SESSION_TTL_MS / 1000 / 60 / 60}h, cleanup interval: ${SESSION_CLEANUP_INTERVAL_MS / 1000 / 60}min`);
});

import express, { type Request, type Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { GoogleGenAI, ThinkingLevel } from '@google/genai';
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
app.use(cors());
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

// ─── In-memory session store ─────────────────────────────────────────────────
interface GenerationRound {
  id: string;
  turn: number;
  type: 'generate' | 'refine';
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
}

const sessions = new Map<string, Session>();

function getOrCreateSession(sessionId: string): Session {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, { id: sessionId, rounds: [] });
  }
  return sessions.get(sessionId)!;
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
    const session = getOrCreateSession(body.sessionId);
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

// ─── REST API: Judge (LAAJ) ───────────────────────────────────────────────────
interface JudgeBody {
  imageBase64: string;
  prompt: string;
  dimensions?: string[];
  threshold?: number;
}

app.post('/api/judge', async (req: Request, res: Response) => {
  try {
    const body = req.body as JudgeBody;
    if (!body.imageBase64 || typeof body.imageBase64 !== 'string') {
      res.status(400).json({ success: false, error: 'imageBase64 is required' });
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

interface JudgeResult {
  scores: Record<string, { score: number; notes: string }>;
  converged: boolean;
  topIssues: Array<{ issue: string; fix: string }>;
  nextFocus: string;
}

async function doJudge(params: JudgeBody): Promise<JudgeResult> {
  const dimensions = params.dimensions ?? ['subject_fidelity', 'instruction_following', 'composition', 'lighting_quality', 'overall_quality'];
  const threshold = params.threshold ?? 4;

  const dimensionList = dimensions.map(d => `    "${d}": { "score": 1-5, "notes": "..." }`).join(',\n');

  const judgePrompt = `Evaluate this generated image against the original prompt.

Original prompt:
${params.prompt}

Score each dimension from 1 (poor) to 5 (excellent). Output only valid JSON:
{
  "scores": {
${dimensionList}
  },
  "converged": <true if all scores >= ${threshold}>,
  "topIssues": [
    { "issue": "concise description", "fix": "exact prompt language to address this" }
  ],
  "nextFocus": "single most impactful improvement direction"
}`;

  const response = await ai.models.generateContent({
    model: JUDGE_MODEL,
    contents: [{
      role: 'user',
      parts: [
        { inlineData: { data: params.imageBase64, mimeType: 'image/jpeg' } },
        { text: judgePrompt },
      ],
    }],
    config: {
      thinkingConfig: { thinkingBudget: 0 },
    },
  });

  const text = (response.text ?? '').trim();
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
      description: 'Generate an image using Gemini. Returns the image base64 and metadata.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'Session ID to track this generation' },
          imageBase64: { type: 'string', description: 'Optional subject image (for image-to-image)' },
          prompt: { type: 'string', description: 'Generation prompt' },
          aspectRatio: { type: 'string', enum: ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'] },
          imageSize: { type: 'string', enum: ['1K', '2K', '4K'] },
          thinkingLevel: { type: 'string', enum: ['minimal', 'high'] },
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
        const { sessionId, imageBase64, prompt, aspectRatio, imageSize, thinkingLevel } = args as any;
        const result = await doGenerate({
          imageBase64,
          prompt,
          aspectRatio: aspectRatio ?? '1:1',
          imageSize: imageSize ?? '1K',
          thinkingLevel: thinkingLevel ?? 'minimal',
        });
        const session = getOrCreateSession(sessionId);
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
});

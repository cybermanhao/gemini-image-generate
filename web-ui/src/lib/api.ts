const API_BASE = '';

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({ success: false, error: 'Invalid JSON' }));
  if (!res.ok || !data.success) {
    throw new Error(data.error ?? `HTTP ${res.status}`);
  }
  return data;
}

export type SessionStatus = 'idle' | 'generating' | 'judging' | 'refining' | 'done' | 'error';
export type SessionMode = 'manual' | 'auto';
export type ErrorCode = 'CONTENT_POLICY' | 'TIMEOUT' | 'MODEL_ERROR' | 'RATE_LIMIT' | 'INVALID_INPUT';

export interface SessionStatusResult {
  success: boolean;
  status: SessionStatus;
  mode: SessionMode;
  roundsCount: number;
  refineCount: number;
  maxRounds: number;
  currentRound: GenerationRound | null;
  converged: boolean;
  currentTask: { type: 'generate' | 'refine' | 'judge'; roundId?: string; startedAt: number } | null;
  error: { code: ErrorCode; message: string; roundId?: string; timestamp: number } | null;
}

export interface GenerateParams {
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

export interface PartSnapshot {
  type: 'image' | 'text';
  content: string;
  label: string;
  detail?: string;
}

export interface TurnSnapshot {
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

export interface ContextSnapshot {
  sessionId: string;
  turns: TurnSnapshot[];
  currentStatus: {
    hasValidThoughtSignature: boolean;
    mode: 'single-turn' | 'multi-turn';
    totalImages: number;
    totalTurns: number;
  };
}

export interface GenerationRound {
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
}

export async function generate(params: GenerateParams & { autoRefine?: false }): Promise<{ round: GenerationRound }>;
export async function generate(params: GenerateParams & { autoRefine: true }): Promise<{ sessionId: string; status: 'running' }>;
export async function generate(params: GenerateParams): Promise<{ round: GenerationRound } | { sessionId: string; status: 'running' }> {
  return post('/api/generate', params);
}

export interface RefineParams {
  sessionId: string;
  roundId: string;
  instruction: string;
  newImagesBase64?: Record<number, string>;
  aspectRatio?: string;
  imageSize?: string;
}

export async function refine(params: RefineParams): Promise<{ round: GenerationRound }> {
  return post('/api/refine', params);
}

export type EditMode = 'BGSWAP' | 'INPAINT_REMOVAL' | 'INPAINT_INSERTION' | 'STYLE';

export interface EditParams {
  sessionId: string;
  roundId: string;
  prompt: string;
  editMode: EditMode;
}

export async function editImage(params: EditParams): Promise<{ round: GenerationRound }> {
  return post('/api/edit', params);
}

export interface ReverseParams {
  imageBase64: string;
  mode: 'text-to-image' | 'image-to-image';
}

export interface ReverseResult {
  textPrompt?: string;
  segments?: Record<string, string>;
}

export async function reversePrompt(params: ReverseParams): Promise<{ result: ReverseResult }> {
  return post('/api/reverse', params);
}

export interface JudgeParams {
  imageBase64: string;
  prompt: string;
  dimensions?: string[];
  threshold?: number;
}

export interface JudgeResult {
  scores: Record<string, { score: number; notes: string }>;
  converged: boolean;
  topIssues: Array<{ issue: string; fix: string }>;
  nextFocus: string;
}

export async function judge(params: JudgeParams): Promise<{ result: JudgeResult }> {
  return post('/api/judge', params);
}

export async function submitChoice(choiceId: string, result: unknown): Promise<{ resolved: boolean }> {
  const res = await fetch(`${API_BASE}/api/choice/${choiceId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(result),
  });
  return res.json();
}

export async function getSession(sessionId: string): Promise<{ exists: boolean; rounds: GenerationRound[] }> {
  const res = await fetch(`${API_BASE}/api/session/${sessionId}`);
  return res.json();
}

export async function getContextSnapshot(sessionId: string): Promise<{ success: boolean; snapshot: ContextSnapshot }> {
  const res = await fetch(`${API_BASE}/api/session/${sessionId}/snapshot`);
  return res.json();
}

export async function getSessionStatus(sessionId: string): Promise<SessionStatusResult> {
  const res = await fetch(`${API_BASE}/api/session/${sessionId}/status`);
  return res.json();
}

export async function abortSession(sessionId: string): Promise<{ success: boolean; aborted: boolean; message?: string }> {
  const res = await fetch(`${API_BASE}/api/session/${sessionId}/abort`, { method: 'POST' });
  return res.json();
}

// ─── Context Snapshot types ──────────────────────────────────────────────────

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

// ─── Session status types ─────────────────────────────────────────────────────

export type SessionStatus = 'idle' | 'generating' | 'judging' | 'refining' | 'done' | 'error';
export type SessionMode = 'manual' | 'auto';
export type ErrorCode =
  | 'CONTENT_POLICY'
  | 'TIMEOUT'
  | 'MODEL_ERROR'
  | 'RATE_LIMIT'
  | 'INVALID_INPUT'
  | 'INVALID_PROMPT'
  | 'ROUND_NOT_FOUND'
  | 'SESSION_NOT_FOUND'
  | 'SESSION_BUSY'
  | 'AUTO_REFINE_FAILED'
  | 'UNKNOWN';

export interface SessionError {
  code: ErrorCode;
  message: string;
  roundId?: string;
  timestamp: number;
}

export interface SessionTask {
  type: 'generate' | 'refine' | 'judge';
  roundId?: string;
  startedAt: number;
}

// ─── Session data ─────────────────────────────────────────────────────────────

export interface GenerationRound {
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
  satisfaction?: number;
  satisfactionNote?: string;
  autoApproved?: boolean;
}

export interface Session {
  id: string;
  rounds: GenerationRound[];
  baseImageBase64?: string;
  basePrompt?: string;
  status: SessionStatus;
  mode: SessionMode;
  maxRounds: number;
  lastAccessedAt: number;
  currentTask?: SessionTask;
  error?: SessionError;
  abortController?: AbortController;
  autoApproveTimeoutMs?: number;
  autoApproveStrategy?: 'satisfaction' | 'judge';
  autoRefineInstruction?: string;
  autoApproveTimer?: ReturnType<typeof setTimeout>;
  autoApproveInterval?: ReturnType<typeof setInterval>;
  autoApproveStartedAt?: number;
  autoApproveRoundId?: string;
}

// ─── Human-in-the-loop ────────────────────────────────────────────────────────

export interface PendingChoice {
  id: string;
  sessionId: string;
  type: string;
  payload: unknown;
  resolve: (value: any) => void;
  reject: (reason: any) => void;
  timeout: ReturnType<typeof setTimeout>;
  createdAt: number;
}

// ─── Gemini API result types ──────────────────────────────────────────────────

export interface GenerateResult {
  imageBase64: string;
  thoughtSignature?: string;
  modelDescription?: string;
  contextSnapshot: TurnSnapshot[];
}

export interface ReverseResult {
  textPrompt?: string;
  segments?: Record<string, string>;
}

export interface JudgeResult {
  scores: Record<string, { score: number; notes: string }>;
  converged: boolean;
  topIssues: Array<{ issue: string; fix: string }>;
  nextFocus: string;
}

// ─── Request body types ───────────────────────────────────────────────────────

export interface GenerateBody {
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
  autoApproveTimeoutMs?: number;
  autoApproveStrategy?: 'satisfaction' | 'judge';
  autoRefineInstruction?: string;
}

export interface RefineBody {
  sessionId: string;
  roundId: string;
  instruction: string;
  newImagesBase64?: Record<number, string>;
  aspectRatio?: string;
  imageSize?: string;
  autoApproveTimeoutMs?: number;
  autoApproveStrategy?: 'satisfaction' | 'judge';
  autoRefineInstruction?: string;
}

export interface EditBody {
  sessionId: string;
  roundId: string;
  prompt: string;
}

export interface JudgeBody {
  imageBase64: string;
  prompt: string;
  dimensions?: string[];
  threshold?: number;
  signal?: AbortSignal;
  cachedContent?: string;
}

export interface ReverseBody {
  imageBase64: string;
  mode: 'text-to-image' | 'image-to-image';
}

export interface SatisfactionBody {
  roundId: string;
  score: number;
  note?: string;
}

export interface OrganizePartsBody {
  images: Array<{ base64: string; label?: string }>;
  userInstruction: string;
}

export interface OrganizePartsResult {
  organizedInstruction: string;
  partsOrder: Array<{ index: number; role: string; description: string }>;
  reasoning: string;
}

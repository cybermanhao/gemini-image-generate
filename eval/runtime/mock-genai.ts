/**
 * Mock @google/genai SDK for eval runtime testing.
 * Records all API calls and supports error injection.
 * When GEMINI_API_KEY is present in env, can proxy to real SDK.
 */

// Error queue from runner
const QUEUED_ERRORS: any[] = JSON.parse(process.env.__EVAL_ERRORS__ ?? '[]');

export interface CallRecord {
  method: 'generateContent' | 'generateContentStream' | 'files.upload' | 'caches.create' | 'caches.delete';
  params: any;
  timestamp: number;
}

let globalCalls: CallRecord[] = [];

export function getCalls(): CallRecord[] {
  return [...globalCalls];
}

export function clearCalls(): void {
  globalCalls = [];
}

function recordCall(method: CallRecord['method'], params: any): void {
  globalCalls.push({
    method,
    params: JSON.parse(JSON.stringify(params)), // deep clone
    timestamp: Date.now(),
  });
}

function nextError(): any | undefined {
  return QUEUED_ERRORS.shift();
}

function checkSignal(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const err = new Error('This operation was aborted');
    (err as any).name = 'AbortError';
    throw err;
  }
}

// ── Response builders ──────────────────────────────────────────────────────

function fakeImagePart(): any {
  return {
    inlineData: {
      data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      mimeType: 'image/png',
    },
    thoughtSignature: 'fake_sig_' + Math.random().toString(36).slice(2, 10),
  };
}

function fakeTextPart(text = 'Generated image'): any {
  return { text };
}

// ── GoogleGenAI ────────────────────────────────────────────────────────────

export class GoogleGenAI {
  /** Access recorded calls across all instances */
  static get calls(): CallRecord[] {
    return getCalls();
  }

  static clearCalls(): void {
    clearCalls();
  }

  private _apiKey: string;

  constructor(opts: { apiKey: string }) {
    this._apiKey = opts.apiKey;
  }

  models = {
    generateContent: async (params: any): Promise<any> => {
      recordCall('generateContent', params);
      checkSignal(params.config?.signal);

      const err = nextError();
      if (err) {
        const e = new Error(err.message ?? 'Unknown error');
        (e as any).status = err.code ?? err.status ?? 500;
        (e as any).code = err.code ?? err.status ?? 500;
        throw e;
      }

      // Small delay to make timing assertions meaningful
      await new Promise(r => setTimeout(r, 50));

      return {
        candidates: [
          {
            content: {
              parts: [fakeImagePart(), fakeTextPart()],
            },
          },
        ],
      };
    },

    generateContentStream: async function* (params: any): AsyncGenerator<any> {
      recordCall('generateContentStream', params);
      checkSignal(params.config?.signal);

      const err = nextError();
      if (err) {
        const e = new Error(err.message ?? 'Unknown error');
        (e as any).status = err.code ?? err.status ?? 500;
        throw e;
      }

      yield {
        candidates: [
          {
            content: {
              parts: [fakeTextPart('Thinking...')],
            },
          },
        ],
      };

      await new Promise(r => setTimeout(r, 30));

      yield {
        candidates: [
          {
            content: {
              parts: [fakeImagePart()],
            },
          },
        ],
      };
    },

    editImage: async (params: any): Promise<any> => {
      recordCall('editImage', params);
      return {
        candidates: [
          {
            content: {
              parts: [fakeImagePart()],
            },
          },
        ],
      };
    },

    countTokens: async (params: any): Promise<any> => {
      recordCall('countTokens', params);
      return { totalTokens: 1024 };
    },
  };

  files = {
    upload: async (params: any): Promise<any> => {
      recordCall('files.upload', params);
      return {
        uri: 'https://generativelanguage.googleapis.com/v1beta/files/mock-file-123',
        name: 'files/mock-file-123',
        mimeType: params.config?.mimeType ?? 'image/jpeg',
      };
    },
  };

  caches = {
    create: async (params: any): Promise<any> => {
      recordCall('caches.create', params);
      return {
        name: 'cachedContents/mock-cache-123',
        expireTime: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
      };
    },
    delete: async (params: any): Promise<any> => {
      recordCall('caches.delete', params);
      return {};
    },
  };
}

// ── Helpers & constants ────────────────────────────────────────────────────

export function createPartFromUri(fileUri: string, mimeType: string): any {
  return { fileData: { fileUri, mimeType } };
}

export const EDIT_MODE_BGSWAP = 'BGSWAP';
export const EDIT_MODE_INPAINT_REMOVAL = 'INPAINT_REMOVAL';
export const EDIT_MODE_INPAINT_INSERTION = 'INPAINT_INSERTION';
export const EDIT_MODE_STYLE = 'STYLE';
export const MASK_MODE_BACKGROUND = 'BACKGROUND';
export const MASK_MODE_FOREGROUND = 'FOREGROUND';
export const MASK_MODE_SEMANTIC = 'SEMANTIC';

export enum ThinkingLevel {
  MINIMAL = 'MINIMAL',
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH',
}

// Re-export types (simplified for mock)
export type Part = any;
export type GenerateContentConfig = any;

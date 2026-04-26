import type { ErrorCode } from '../types.js';

export function isValidBase64(str: string): boolean {
  if (typeof str !== 'string' || str.length === 0) return false;
  if (str.startsWith('data:')) return false; // reject data URLs, expect pure base64
  const maxValidate = 100_000;
  const toCheck = str.length > maxValidate ? str.slice(0, maxValidate) + str.slice(-100) : str;
  return /^[A-Za-z0-9+/]*={0,2}$/.test(toCheck) && str.length % 4 === 0;
}

export function isAbortError(err: unknown): boolean {
  const e = err as any;
  return (
    e?.name === 'AbortError' ||
    e?.code === 'ABORT_ERR' ||
    String(e?.message ?? '').toLowerCase().includes('aborted') ||
    String(e?.message ?? '').toLowerCase().includes('user requested abort')
  );
}

export function classifyError(err: unknown): ErrorCode {
  const msg = ((err as any)?.message ?? String(err)).toLowerCase();
  // 1. Rate limit first — explicit and unambiguous
  if (msg.includes('429') || msg.includes('quota') || msg.includes('rate limit') || msg.includes('resource_exhausted')) {
    return 'RATE_LIMIT';
  }
  // 2. Content policy
  if (msg.includes('safety') || msg.includes('content policy') || msg.includes('content_policy') || msg.includes('blocked') || msg.includes('harm')) {
    return 'CONTENT_POLICY';
  }
  if (msg.includes('timeout') || msg.includes('timed out') || (err as any)?.code === 'ETIMEDOUT') {
    return 'TIMEOUT';
  }
  if (msg.includes('invalid') || msg.includes('400') || msg.includes('bad request')) {
    return 'INVALID_INPUT';
  }
  if (msg.includes('did not return an image') || msg.includes('model did not return')) {
    return 'MODEL_ERROR';
  }
  return 'UNKNOWN';
}

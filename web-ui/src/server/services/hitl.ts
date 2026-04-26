import { randomUUID } from 'crypto';
import type { PendingChoice } from '../types.js';
import { broadcast } from './sse.js';

const pendingChoices = new Map<string, PendingChoice>();

export function createChoice<T>(
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

export function resolveChoice(choiceId: string, result: unknown): boolean {
  const choice = pendingChoices.get(choiceId);
  if (!choice) return false;
  clearTimeout(choice.timeout);
  pendingChoices.delete(choiceId);
  choice.resolve(result);
  return true;
}

export function rejectChoice(choiceId: string, reason: string): boolean {
  const choice = pendingChoices.get(choiceId);
  if (!choice) return false;
  clearTimeout(choice.timeout);
  pendingChoices.delete(choiceId);
  choice.reject(new Error(reason));
  return true;
}

export function getChoicesForSession(sessionId: string): PendingChoice[] {
  return Array.from(pendingChoices.values()).filter(c => c.sessionId === sessionId);
}

export { pendingChoices };

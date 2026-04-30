import type { Session, SessionStatus, SessionTask, ErrorCode } from '../types.js';
import { SESSION_TTL_MS } from '../config.js';
import { broadcast } from './sse.js';

const sessions = new Map<string, Session>();

export function getOrCreateSession(sessionId: string): Session {
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

export function getSession(sessionId: string): Session | undefined {
  return sessions.get(sessionId);
}

export function cleanupExpiredSessions(): void {
  const now = Date.now();
  let cleaned = 0;
  for (const [id, session] of sessions) {
    if (now - session.lastAccessedAt > SESSION_TTL_MS) {
      session.abortController?.abort(new Error('Session expired'));
      sessions.delete(id);
      cleaned++;
    }
  }
  if (cleaned > 0) {
    console.log(`[cleanup] Removed ${cleaned} expired sessions (>${SESSION_TTL_MS / 1000 / 60 / 60}h)`);
  }
}

export function setSessionStatus(
  session: Session,
  status: SessionStatus,
  task?: SessionTask,
): void {
  session.status = status;
  session.currentTask = task;
  if (status !== 'error') session.error = undefined;
  broadcast(session.id, { type: 'status', status, task });
}

export function setSessionError(
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

export function setRoundSatisfaction(
  session: Session,
  roundId: string,
  score: number,
  note?: string,
): void {
  const round = session.rounds.find(r => r.id === roundId);
  if (!round) return;
  round.satisfaction = score;
  if (note !== undefined) round.satisfactionNote = note;
  broadcast(session.id, { type: 'round-updated', round });
}

export function cancelAutoApproveCountdown(session: Session): void {
  if (session.autoApproveInterval) {
    clearInterval(session.autoApproveInterval);
    session.autoApproveInterval = undefined;
  }
  if (session.autoApproveTimer) {
    clearTimeout(session.autoApproveTimer);
    session.autoApproveTimer = undefined;
  }
  if (session.autoApproveRoundId) {
    broadcast(session.id, { type: 'countdown-cancelled', roundId: session.autoApproveRoundId });
  }
  session.autoApproveStartedAt = undefined;
  session.autoApproveRoundId = undefined;
}

export function startAutoApproveCountdown(
  session: Session,
  roundId: string,
  onExpire: () => void,
): void {
  cancelAutoApproveCountdown(session);
  if (!session.autoApproveTimeoutMs || session.autoApproveTimeoutMs <= 0) return;

  session.autoApproveRoundId = roundId;
  session.autoApproveStartedAt = Date.now();
  const totalMs = session.autoApproveTimeoutMs;

  session.autoApproveInterval = setInterval(() => {
    const elapsed = Date.now() - (session.autoApproveStartedAt ?? Date.now());
    const remainingMs = Math.max(0, totalMs - elapsed);
    broadcast(session.id, { type: 'countdown', roundId, remainingMs, totalMs });
    if (remainingMs <= 0) {
      if (session.autoApproveInterval) {
        clearInterval(session.autoApproveInterval);
        session.autoApproveInterval = undefined;
      }
    }
  }, 1000);

  session.autoApproveTimer = setTimeout(() => {
    if (session.autoApproveInterval) {
      clearInterval(session.autoApproveInterval);
      session.autoApproveInterval = undefined;
    }
    session.autoApproveTimer = undefined;
    session.autoApproveStartedAt = undefined;
    session.autoApproveRoundId = undefined;
    onExpire();
  }, totalMs);
}

export { sessions };

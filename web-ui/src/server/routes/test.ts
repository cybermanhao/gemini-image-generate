import type { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { pendingChoices } from '../services/hitl.js';
import { broadcast } from '../services/sse.js';

export function register(app: import('express').Application) {
  if (process.env.NODE_ENV === 'production') return;

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

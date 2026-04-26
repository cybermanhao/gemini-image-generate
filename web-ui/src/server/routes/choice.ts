import type { Request, Response } from 'express';
import { resolveChoice, rejectChoice, getChoicesForSession } from '../services/hitl.js';

export function register(app: import('express').Application) {
  app.post('/api/choice/:choiceId', (req: Request, res: Response) => {
    const { choiceId } = req.params;
    const resolved = resolveChoice(choiceId, req.body);
    res.json({ resolved });
  });

  app.get('/api/choices/:sessionId', (req: Request, res: Response) => {
    const { sessionId } = req.params;
    const choices = getChoicesForSession(sessionId)
      .map(c => ({ id: c.id, type: c.type, payload: c.payload, createdAt: c.createdAt }));
    res.json({ choices });
  });

  app.post('/api/cancel-choice/:choiceId', (req: Request, res: Response) => {
    const { choiceId } = req.params;
    const { reason } = req.body as { reason?: string };
    const cancelled = rejectChoice(choiceId, reason ?? 'User cancelled');
    res.json({ cancelled });
  });
}

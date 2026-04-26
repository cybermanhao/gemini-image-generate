import type { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import type { EditBody } from '../types.js';
import { getOrCreateSession } from '../services/sessionStore.js';
import { broadcast } from '../services/sse.js';
import { doEdit } from '../services/gemini.js';

function getStatusFromError(err: any): number {
  if (err?.status === 429) return 429;
  if (err?.status === 400) return 400;
  return 500;
}

export function register(app: import('express').Application) {
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
      const session = getOrCreateSession(body.sessionId);
      const round = session.rounds.find(r => r.id === body.roundId);
      if (!round) {
        res.status(404).json({ success: false, error: 'Round not found' });
        return;
      }

      const result = await doEdit({ imageBase64: round.imageBase64, prompt: body.prompt });

      const newRound = {
        id: randomUUID(),
        turn: session.rounds.length,
        type: 'edit' as const,
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
      res.status(getStatusFromError(err)).json({ success: false, error: err.message ?? String(err) });
    }
  });
}

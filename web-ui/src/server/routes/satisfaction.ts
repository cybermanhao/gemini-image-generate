import type { Request, Response } from 'express';
import type { SatisfactionBody } from '../types.js';
import { sessions, setRoundSatisfaction, cancelAutoApproveCountdown } from '../services/sessionStore.js';

export function register(app: import('express').Application) {
  app.post('/api/session/:sessionId/satisfaction', (req: Request, res: Response) => {
    try {
      const { sessionId } = req.params;
      const body = req.body as SatisfactionBody;
      const session = sessions.get(sessionId);

      if (!session) {
        res.status(404).json({ success: false, error: 'Session not found' });
        return;
      }

      if (!body.roundId || typeof body.roundId !== 'string') {
        res.status(400).json({ success: false, error: 'roundId is required' });
        return;
      }

      const score = Number(body.score);
      if (!Number.isFinite(score) || score < 1 || score > 5) {
        res.status(400).json({ success: false, error: 'score must be 1-5' });
        return;
      }

      const round = session.rounds.find(r => r.id === body.roundId);
      if (!round) {
        res.status(404).json({ success: false, error: 'Round not found' });
        return;
      }

      // Cannot score while generation is in progress
      if (session.status === 'generating' || session.status === 'judging' || session.status === 'refining') {
        res.status(409).json({ success: false, error: 'Cannot score while generation is in progress' });
        return;
      }

      setRoundSatisfaction(session, body.roundId, score, body.note);
      cancelAutoApproveCountdown(session);

      res.json({ success: true, round });
    } catch (err: any) {
      console.error('[satisfaction]', err);
      res.status(500).json({ success: false, error: err.message ?? String(err) });
    }
  });
}

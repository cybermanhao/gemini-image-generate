import type { Request, Response } from 'express';
import { sessions } from '../services/sessionStore.js';

export function register(app: import('express').Application) {
  app.get('/api/session/:sessionId', (req: Request, res: Response) => {
    const session = sessions.get(req.params.sessionId);
    res.json({ exists: !!session, rounds: session?.rounds ?? [] });
  });

  app.get('/api/session/:sessionId/status', (req: Request, res: Response) => {
    const session = sessions.get(req.params.sessionId);
    if (!session) {
      res.status(404).json({ success: false, error: 'Session not found' });
      return;
    }
    const lastRound = session.rounds[session.rounds.length - 1] ?? null;
    const refineCount = session.rounds.filter(r => r.type === 'refine').length;
    res.json({
      success: true,
      status: session.status,
      mode: session.mode,
      roundsCount: session.rounds.length,
      refineCount,
      maxRounds: session.maxRounds,
      currentRound: lastRound,
      converged: lastRound?.converged ?? false,
      currentTask: session.currentTask ?? null,
      error: session.error ?? null,
    });
  });

  app.get('/api/session/:sessionId/export', (req: Request, res: Response) => {
    const session = sessions.get(req.params.sessionId);
    if (!session) {
      res.status(404).json({ success: false, error: 'Session not found' });
      return;
    }
    res.json({
      success: true,
      export: {
        exportedAt: new Date().toISOString(),
        version: '1.0',
        sessionId: session.id,
        mode: session.mode,
        maxRounds: session.maxRounds,
        status: session.status,
        rounds: session.rounds,
      },
    });
  });

  app.post('/api/session/:sessionId/abort', (req: Request, res: Response) => {
    const session = sessions.get(req.params.sessionId);
    if (!session) {
      res.status(404).json({ success: false, error: 'Session not found' });
      return;
    }
    if (!session.abortController) {
      res.json({ success: true, aborted: false, message: 'No active auto loop to abort' });
      return;
    }
    session.abortController.abort(new Error('User requested abort'));
    res.json({ success: true, aborted: true });
  });

  app.get('/api/session/:sessionId/snapshot', (req: Request, res: Response) => {
    const session = sessions.get(req.params.sessionId);
    if (!session) {
      res.status(404).json({ success: false, error: 'Session not found' });
      return;
    }

    const allTurns: import('../types.js').TurnSnapshot[] = [];
    let totalImages = 0;

    for (const round of session.rounds) {
      if (round.contextSnapshot) {
        for (const turn of round.contextSnapshot) {
          allTurns.push({
            ...turn,
            metadata: { ...turn.metadata, roundId: round.id },
          });
          totalImages += turn.parts.filter(p => p.type === 'image').length;
        }
      }
    }

    const lastRound = session.rounds[session.rounds.length - 1];
    const hasValidThoughtSignature = !!lastRound?.thoughtSignature;

    const snapshot = {
      sessionId: session.id,
      turns: allTurns,
      currentStatus: {
        hasValidThoughtSignature,
        mode: hasValidThoughtSignature ? 'multi-turn' : 'single-turn',
        totalImages,
        totalTurns: allTurns.length,
      },
    };

    res.json({ success: true, snapshot });
  });
}

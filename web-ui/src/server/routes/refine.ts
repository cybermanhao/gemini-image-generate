import type { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import type { RefineBody } from '../types.js';
import { getOrCreateSession } from '../services/sessionStore.js';
import { broadcast } from '../services/sse.js';
import { doRefine } from '../services/gemini.js';

function getStatusFromError(err: any): number {
  if (err?.status === 429) return 429;
  if (err?.status === 400) return 400;
  return 500;
}

export function register(app: import('express').Application) {
  app.post('/api/refine', async (req: Request, res: Response) => {
    try {
      const body = req.body as RefineBody;
      if (!body.sessionId || typeof body.sessionId !== 'string') {
        res.status(400).json({ success: false, error: 'sessionId is required' });
        return;
      }
      if (!body.roundId || typeof body.roundId !== 'string') {
        res.status(400).json({ success: false, error: 'roundId is required' });
        return;
      }
      if (!body.instruction || !body.instruction.trim()) {
        res.status(400).json({ success: false, error: 'instruction is required' });
        return;
      }
      const session = getOrCreateSession(body.sessionId);

      if (session.mode === 'auto' && session.status !== 'idle' && session.status !== 'done' && session.status !== 'error') {
        res.status(409).json({ success: false, error: '当前会话在自动模式中，请等待', code: 'INVALID_INPUT' });
        return;
      }

      const prevRound = session.rounds.find(r => r.id === body.roundId);
      if (!prevRound) {
        res.status(404).json({ success: false, error: 'Round not found' });
        return;
      }

      const result = await doRefine({
        baseImageBase64: session.baseImageBase64,
        basePrompt: session.basePrompt ?? '',
        prevImageBase64: prevRound.imageBase64,
        prevThoughtSignature: prevRound.thoughtSignature,
        prevModelDescription: prevRound.modelDescription,
        instruction: body.instruction,
        newImagesBase64: body.newImagesBase64,
        aspectRatio: body.aspectRatio,
        imageSize: body.imageSize,
      });

      const round = {
        id: randomUUID(),
        turn: session.rounds.length,
        type: 'refine' as const,
        prompt: session.basePrompt ?? '',
        instruction: body.instruction,
        imageBase64: result.imageBase64,
        thoughtSignature: result.thoughtSignature,
        modelDescription: result.modelDescription,
        converged: false,
        createdAt: Date.now(),
        contextSnapshot: result.contextSnapshot,
      };

      session.rounds.push(round);
      broadcast(body.sessionId, { type: 'round', round });
      res.json({ success: true, round });
    } catch (err: any) {
      console.error('[refine]', err);
      res.status(getStatusFromError(err)).json({ success: false, error: err.message ?? String(err) });
    }
  });
}

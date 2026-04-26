import type { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import type { GenerateBody } from '../types.js';
import { isValidBase64, isAbortError, classifyError } from '../utils/validation.js';
import { getOrCreateSession } from '../services/sessionStore.js';
import { setSessionStatus, setSessionError } from '../services/sessionStore.js';
import { broadcast } from '../services/sse.js';
import { withGeminiCall, doGenerate } from '../services/gemini.js';
import { runAutoRefine } from '../orchestrators/autoRefine.js';

function getStatusFromError(err: any): number {
  if (err?.status === 429) return 429;
  if (err?.status === 400) return 400;
  return 500;
}

export function register(app: import('express').Application) {
  app.post('/api/generate', async (req: Request, res: Response) => {
    try {
      const body = req.body as GenerateBody;
      if (!body.sessionId || typeof body.sessionId !== 'string') {
        res.status(400).json({ success: false, error: 'sessionId is required' });
        return;
      }
      if (!body.prompt || !body.prompt.trim()) {
        res.status(400).json({ success: false, error: 'prompt is required' });
        return;
      }
      if (body.imageBase64 && !isValidBase64(body.imageBase64)) {
        res.status(400).json({ success: false, error: 'imageBase64 is not valid base64' });
        return;
      }

      const session = getOrCreateSession(body.sessionId);

      if (body.autoRefine) {
        const busy = session.status !== 'idle' && session.status !== 'done' && session.status !== 'error';
        if (busy) {
          res.status(409).json({ success: false, error: '当前会话在自动模式中，请等待', code: 'INVALID_INPUT' });
          return;
        }
        session.mode = 'auto';
        session.maxRounds = body.maxRounds ?? 3;
        session.rounds = [];
        session.baseImageBase64 = body.imageBase64;
        session.basePrompt = body.prompt;

        res.json({ success: true, sessionId: body.sessionId, status: 'running' });

        const ctrl = new AbortController();
        session.abortController = ctrl;
        void (async () => {
          const sig = ctrl.signal;
          try {
            setSessionStatus(session, 'generating', { type: 'generate', startedAt: Date.now() });
            const result = await withGeminiCall(
              (s) => doGenerate({
                imageBase64: body.imageBase64,
                prompt: body.prompt,
                aspectRatio: body.aspectRatio ?? '1:1',
                imageSize: body.imageSize ?? '1K',
                thinkingLevel: body.thinkingLevel ?? 'minimal',
                extraImagesBase64: body.extraImagesBase64,
                styleRefBase64: body.styleRefBase64,
                signal: s,
              }),
              { signal: sig },
            );
            if (sig.aborted) { setSessionStatus(session, 'idle'); session.mode = 'manual'; return; }
            const round = {
              id: randomUUID(),
              turn: 0,
              type: 'generate' as const,
              prompt: body.prompt,
              imageBase64: result.imageBase64,
              thoughtSignature: result.thoughtSignature,
              modelDescription: result.modelDescription,
              converged: false,
              createdAt: Date.now(),
              contextSnapshot: result.contextSnapshot,
            };
            session.rounds.push(round);
            broadcast(body.sessionId, { type: 'round', round });
            await runAutoRefine(session);
          } catch (err: unknown) {
            if (isAbortError(err)) {
              setSessionStatus(session, 'idle');
              session.mode = 'manual';
              broadcast(body.sessionId, { type: 'aborted' });
            } else {
              setSessionError(session, classifyError(err), (err as any)?.message ?? String(err));
            }
          } finally {
            if (session.abortController === ctrl) session.abortController = undefined;
          }
        })();
        return;
      }

      session.mode = 'manual';
      const result = await doGenerate({
        imageBase64: body.imageBase64,
        prompt: body.prompt,
        aspectRatio: body.aspectRatio ?? '1:1',
        imageSize: body.imageSize ?? '1K',
        thinkingLevel: body.thinkingLevel ?? 'minimal',
        extraImagesBase64: body.extraImagesBase64,
        styleRefBase64: body.styleRefBase64,
      });

      const round = {
        id: randomUUID(),
        turn: session.rounds.length,
        type: 'generate' as const,
        prompt: body.prompt,
        imageBase64: result.imageBase64,
        thoughtSignature: result.thoughtSignature,
        modelDescription: result.modelDescription,
        converged: false,
        createdAt: Date.now(),
        contextSnapshot: result.contextSnapshot,
      };

      if (body.imageBase64) session.baseImageBase64 = body.imageBase64;
      session.basePrompt = body.prompt;
      session.rounds.push(round);

      broadcast(body.sessionId, { type: 'round', round });
      res.json({ success: true, round });
    } catch (err: any) {
      console.error('[generate]', err);
      res.status(getStatusFromError(err)).json({ success: false, error: err.message ?? String(err) });
    }
  });
}

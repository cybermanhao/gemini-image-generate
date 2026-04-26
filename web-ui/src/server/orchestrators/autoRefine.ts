import { randomUUID } from 'crypto';
import { ai } from '../config.js';
import type { Session, GenerationRound, JudgeResult } from '../types.js';
import { broadcast } from '../services/sse.js';
import { setSessionStatus, setSessionError } from '../services/sessionStore.js';
import { withGeminiCall, doJudge, doRefine } from '../services/gemini.js';
import { isAbortError, classifyError } from '../utils/validation.js';

export async function runAutoRefine(session: Session): Promise<void> {
  const sig = session.abortController?.signal;

  let judgeCache: string | undefined;
  try {
    const cache = await ai.caches.create({
      model: 'gemini-2.5-flash',
      config: {
        displayName: `judge-${session.id.slice(0, 8)}`,
        ttl: '1800s',
        systemInstruction: { parts: [{ text: `You are an expert quality evaluator for AI-generated images...` }] },
      },
    });
    judgeCache = cache.name ?? undefined;
    console.log(`[cache] judge cache created: ${judgeCache}`);
  } catch (err) {
    console.warn('[cache] judge cache creation failed, proceeding without cache:', (err as any)?.message);
  }

  try {
    while (!sig?.aborted) {
      const currentRound = session.rounds[session.rounds.length - 1];
      if (!currentRound) {
        setSessionError(session, 'MODEL_ERROR', 'runAutoRefine called with empty rounds');
        return;
      }
      const refineCount = session.rounds.filter(r => r.type === 'refine').length;

      setSessionStatus(session, 'judging', {
        type: 'judge',
        roundId: currentRound.id,
        startedAt: Date.now(),
      });

      let judgeResult: JudgeResult;
      try {
        judgeResult = await withGeminiCall(
          (s) => doJudge(
            { imageBase64: currentRound.imageBase64, prompt: session.basePrompt ?? '', signal: s, cachedContent: judgeCache },
            (partial) => broadcast(session.id, { type: 'judge-progress', roundId: currentRound.id, partial }),
          ),
          { signal: sig },
        );
      } catch (err: unknown) {
        if (isAbortError(err)) break;
        setSessionError(session, classifyError(err), (err as any)?.message ?? String(err), currentRound.id);
        return;
      }

      currentRound.converged = judgeResult.converged;
      currentRound.scores = judgeResult.scores;
      currentRound.topIssues = judgeResult.topIssues;
      currentRound.nextFocus = judgeResult.nextFocus;
      broadcast(session.id, { type: 'round-updated', round: currentRound });

      if (judgeResult.converged || refineCount >= session.maxRounds) {
        setSessionStatus(session, 'done');
        return;
      }

      const instruction = judgeResult.topIssues[0]?.fix?.trim() ?? judgeResult.nextFocus?.trim();
      if (!instruction) {
        setSessionStatus(session, 'done');
        return;
      }

      if (sig?.aborted) break;

      setSessionStatus(session, 'refining', {
        type: 'refine',
        roundId: currentRound.id,
        startedAt: Date.now(),
      });

      let refineResult: import('../types.js').GenerateResult;
      try {
        refineResult = await withGeminiCall(
          (s) => doRefine({
            baseImageBase64: session.baseImageBase64,
            basePrompt: session.basePrompt ?? '',
            prevImageBase64: currentRound.imageBase64,
            prevThoughtSignature: currentRound.thoughtSignature,
            prevModelDescription: currentRound.modelDescription,
            instruction,
            signal: s,
          }),
          { signal: sig },
        );
      } catch (err: unknown) {
        if (isAbortError(err)) break;
        setSessionError(session, classifyError(err), (err as any)?.message ?? String(err), currentRound.id);
        return;
      }

      const newRound: GenerationRound = {
        id: randomUUID(),
        turn: session.rounds.length,
        type: 'refine',
        prompt: session.basePrompt ?? '',
        instruction,
        imageBase64: refineResult.imageBase64,
        thoughtSignature: refineResult.thoughtSignature,
        modelDescription: refineResult.modelDescription,
        converged: false,
        createdAt: Date.now(),
        contextSnapshot: refineResult.contextSnapshot,
      };

      session.rounds.push(newRound);
      broadcast(session.id, { type: 'round', round: newRound });
    }
  } finally {
    if (judgeCache) {
      ai.caches.delete({ name: judgeCache }).catch((err) => {
        console.warn('[cache] judge cache delete failed:', (err as any)?.message);
      });
      console.log(`[cache] judge cache deleted: ${judgeCache}`);
    }
  }

  setSessionStatus(session, 'idle');
  session.mode = 'manual';
  broadcast(session.id, { type: 'aborted' });
}

import { randomUUID } from 'crypto';
import { PORT } from '../config.js';
import type { GenerationRound } from '../types.js';
import { getOrCreateSession, sessions } from '../services/sessionStore.js';
import { setSessionStatus, setSessionError } from '../services/sessionStore.js';
import { broadcast } from '../services/sse.js';
import { createChoice } from '../services/hitl.js';
import { withGeminiCall, doGenerate, doRefine, doEdit, doJudge, doReversePrompt } from '../services/gemini.js';
import { isAbortError, classifyError } from '../utils/validation.js';
import { runAutoRefine } from '../orchestrators/autoRefine.js';

export async function dispatchToolCall(name: string, args: unknown) {
  switch (name) {
    case 'open_image_studio': {
      const sessionId = (args as any)?.sessionId ?? randomUUID();
      getOrCreateSession(sessionId);
      const url = `http://localhost:${PORT}?session=${sessionId}`;
      return { content: [{ type: 'text' as const, text: `Image Studio opened at: ${url}` }] };
    }

    case 'generate_image': {
      const { sessionId, imageBase64, prompt, aspectRatio, imageSize, thinkingLevel, autoRefine, maxRounds } = args as any;
      const session = getOrCreateSession(sessionId);

      if (autoRefine) {
        const busy = session.status !== 'idle' && session.status !== 'done' && session.status !== 'error';
        if (busy) {
          return {
            content: [{ type: 'text' as const, text: `Session is ${session.status}. Please wait or use a new session.` }],
            isError: true,
          };
        }
        session.mode = 'auto';
        session.maxRounds = maxRounds ?? 3;
        session.rounds = [];
        session.baseImageBase64 = imageBase64;
        session.basePrompt = prompt;

        const ctrl = new AbortController();
        session.abortController = ctrl;
        void (async () => {
          const sig = ctrl.signal;
          try {
            setSessionStatus(session, 'generating', { type: 'generate', startedAt: Date.now() });
            const result = await withGeminiCall(
              (s) => doGenerate({
                imageBase64,
                prompt,
                aspectRatio: aspectRatio ?? '1:1',
                imageSize: imageSize ?? '1K',
                thinkingLevel: thinkingLevel ?? 'minimal',
                signal: s,
              }),
              { signal: sig },
            );
            if (sig.aborted) { setSessionStatus(session, 'idle'); session.mode = 'manual'; return; }
            const round: GenerationRound = {
              id: randomUUID(),
              turn: 0,
              type: 'generate',
              prompt,
              imageBase64: result.imageBase64,
              thoughtSignature: result.thoughtSignature,
              modelDescription: result.modelDescription,
              converged: false,
              createdAt: Date.now(),
              contextSnapshot: result.contextSnapshot,
            };
            session.rounds.push(round);
            broadcast(sessionId, { type: 'round', round });
            await runAutoRefine(session);
          } catch (err: unknown) {
            if (isAbortError(err)) {
              setSessionStatus(session, 'idle');
              session.mode = 'manual';
              broadcast(sessionId, { type: 'aborted' });
            } else {
              setSessionError(session, classifyError(err), (err as any)?.message ?? String(err));
            }
          } finally {
            if (session.abortController === ctrl) session.abortController = undefined;
          }
        })();

        return {
          content: [
            { type: 'text' as const, text: `Auto-refine started (max ${session.maxRounds} rounds). Poll status with get_session_status(sessionId="${sessionId}").` },
          ],
        };
      }

      session.mode = 'manual';
      const result = await doGenerate({
        imageBase64,
        prompt,
        aspectRatio: aspectRatio ?? '1:1',
        imageSize: imageSize ?? '1K',
        thinkingLevel: thinkingLevel ?? 'minimal',
      });
      const round: GenerationRound = {
        id: randomUUID(),
        turn: session.rounds.length,
        type: 'generate',
        prompt,
        imageBase64: result.imageBase64,
        thoughtSignature: result.thoughtSignature,
        modelDescription: result.modelDescription,
        converged: false,
        createdAt: Date.now(),
        contextSnapshot: result.contextSnapshot,
      };
      if (imageBase64) session.baseImageBase64 = imageBase64;
      session.basePrompt = prompt;
      session.rounds.push(round);
      broadcast(sessionId, { type: 'round', round });
      return {
        content: [
          { type: 'text' as const, text: `Generated image (round ${round.turn}). Model description: ${result.modelDescription ?? 'none'}` },
          { type: 'image' as const, data: result.imageBase64, mimeType: 'image/png' },
        ],
      };
    }

    case 'refine_image': {
      const { sessionId, roundId, instruction } = args as any;
      const session = getOrCreateSession(sessionId);
      if (session.mode === 'auto' && session.status !== 'idle' && session.status !== 'done' && session.status !== 'error') {
        return {
          content: [{ type: 'text' as const, text: `Session is in auto mode (${session.status}). Please wait or call abort_session first.` }],
          isError: true,
        };
      }
      const prevRound = session.rounds.find(r => r.id === roundId);
      if (!prevRound) throw new Error('Round not found');
      const result = await doRefine({
        baseImageBase64: session.baseImageBase64,
        basePrompt: session.basePrompt,
        prevImageBase64: prevRound.imageBase64,
        prevThoughtSignature: prevRound.thoughtSignature,
        prevModelDescription: prevRound.modelDescription,
        instruction,
      });
      const round: GenerationRound = {
        id: randomUUID(),
        turn: session.rounds.length,
        type: 'refine',
        prompt: session.basePrompt ?? '',
        instruction,
        imageBase64: result.imageBase64,
        thoughtSignature: result.thoughtSignature,
        modelDescription: result.modelDescription,
        converged: false,
        createdAt: Date.now(),
      };
      session.rounds.push(round);
      broadcast(sessionId, { type: 'round', round });
      return {
        content: [
          { type: 'text' as const, text: `Refined image (round ${round.turn}). Model description: ${result.modelDescription ?? 'none'}` },
          { type: 'image' as const, data: result.imageBase64, mimeType: 'image/png' },
        ],
      };
    }

    case 'reverse_prompt': {
      const { imageBase64, mode } = args as any;
      const result = await doReversePrompt(imageBase64, mode);
      if (result.textPrompt) {
        return { content: [{ type: 'text' as const, text: `Reversed text-to-image prompt:\n${result.textPrompt}` }] };
      }
      return { content: [{ type: 'text' as const, text: `Reversed image-to-image segments:\n${JSON.stringify(result.segments, null, 2)}` }] };
    }

    case 'judge_image': {
      const { imageBase64, prompt, dimensions, threshold } = args as any;
      const result = await doJudge({ imageBase64, prompt, dimensions, threshold });
      return {
        content: [{ type: 'text' as const, text: `LAAJ Evaluation:\n${JSON.stringify(result, null, 2)}` }],
      };
    }

    case 'choose_best': {
      const { sessionId, roundA, roundB, question } = args as any;
      const session = getOrCreateSession(sessionId);
      const a = session.rounds.find(r => r.id === roundA);
      const b = session.rounds.find(r => r.id === roundB);
      if (!a || !b) throw new Error('One or both rounds not found');
      const result = await createChoice<{ choice: 'A' | 'B'; reason?: string }>(sessionId, 'ab_compare', {
        question: question ?? 'Which image do you prefer?',
        optionA: { roundId: a.id, turn: a.turn, imageBase64: a.imageBase64 },
        optionB: { roundId: b.id, turn: b.turn, imageBase64: b.imageBase64 },
      });
      return {
        content: [{ type: 'text' as const, text: `User chose: ${result.choice} (${result.reason ?? 'no reason given'})` }],
      };
    }

    case 'await_input': {
      const { sessionId, hint, timeoutMs } = args as any;
      const result = await createChoice<{ instruction: string }>(
        sessionId,
        'await_input',
        { hint: hint ?? 'What would you like to change?' },
        timeoutMs ?? 300_000,
      );
      return {
        content: [{ type: 'text' as const, text: `User input: ${result.instruction}` }],
      };
    }

    case 'edit_image': {
      const { sessionId, roundId, prompt } = args as any;
      const session = getOrCreateSession(sessionId);
      const round = session.rounds.find(r => r.id === roundId);
      if (!round) throw new Error('Round not found');
      const result = await doEdit({ imageBase64: round.imageBase64, prompt });
      const newRound: GenerationRound = {
        id: randomUUID(),
        turn: session.rounds.length,
        type: 'edit',
        prompt: round.prompt,
        instruction: prompt,
        imageBase64: result.imageBase64,
        converged: false,
        createdAt: Date.now(),
      };
      session.rounds.push(newRound);
      broadcast(sessionId, { type: 'round', round: newRound });
      return {
        content: [
          { type: 'text' as const, text: `Edited image (round ${newRound.turn}).` },
          { type: 'image' as const, data: result.imageBase64, mimeType: 'image/png' },
        ],
      };
    }

    case 'get_session_status': {
      const { sessionId } = args as any;
      const session = sessions.get(sessionId);
      if (!session) throw new Error('Session not found');
      const lastRound = session.rounds[session.rounds.length - 1] ?? null;
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            status: session.status,
            mode: session.mode,
            roundsCount: session.rounds.length,
            refineCount: session.rounds.filter(r => r.type === 'refine').length,
            maxRounds: session.maxRounds,
            converged: lastRound?.converged ?? false,
            currentTask: session.currentTask ?? null,
            error: session.error ?? null,
          }, null, 2),
        }],
      };
    }

    case 'abort_session': {
      const { sessionId } = args as any;
      const session = sessions.get(sessionId);
      if (!session) throw new Error('Session not found');
      if (!session.abortController) {
        return { content: [{ type: 'text' as const, text: 'No active auto loop to abort' }] };
      }
      session.abortController.abort(new Error('User requested abort'));
      return { content: [{ type: 'text' as const, text: 'Auto loop aborted. Session returned to manual mode.' }] };
    }

    case 'export_session': {
      const { sessionId } = args as any;
      const session = sessions.get(sessionId);
      if (!session) throw new Error('Session not found');
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            exportedAt: new Date().toISOString(),
            version: '1.0',
            sessionId: session.id,
            mode: session.mode,
            maxRounds: session.maxRounds,
            status: session.status,
            rounds: session.rounds,
          }, null, 2),
        }],
      };
    }

    default:
      return { content: [{ type: 'text' as const, text: `Unknown tool: ${name}` }], isError: true };
  }
}

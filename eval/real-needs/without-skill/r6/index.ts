import { GoogleGenAI, type Part } from '@google/genai';

const MODEL = 'gemini-3.1-flash-image-preview';

type ErrorCode = 'RATE_LIMIT' | 'TIMEOUT' | 'CONTENT_POLICY' | 'MODEL_ERROR';

function classifyError(err: unknown): ErrorCode {
  const e = err as Record<string, any>;
  const code = e?.error?.code ?? e?.status;
  const msg = String(e?.error?.message ?? e?.message ?? '').toLowerCase();

  if (code === 429 || code === 'RESOURCE_EXHAUSTED' || msg.includes('quota')) {
    return 'RATE_LIMIT';
  }
  if (code === 503 || code === 'UNAVAILABLE') {
    return 'RATE_LIMIT';
  }
  if (msg.includes('safety') || msg.includes('blocked')) {
    return 'CONTENT_POLICY';
  }
  if (
    msg.includes('timeout') ||
    msg.includes('timed out') ||
    code === 'ETIMEDOUT' ||
    msg.includes('ECONNRESET') ||
    msg.includes('fetch failed')
  ) {
    return 'TIMEOUT';
  }
  return 'MODEL_ERROR';
}

function isAbortError(err: unknown): boolean {
  const e = err as any;
  return (
    e?.name === 'AbortError' ||
    e?.code === 'ABORT_ERR' ||
    String(e?.message ?? '').toLowerCase().includes('aborted') ||
    String(e?.message ?? '').toLowerCase().includes('user requested abort')
  );
}

function isRetryable(code: ErrorCode): boolean {
  return code === 'RATE_LIMIT' || code === 'TIMEOUT';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function doGenerate(
  ai: GoogleGenAI,
  prompt: string,
  imageBase64: string | undefined,
  abortSignal: AbortSignal,
): Promise<string> {
  const parts: Part[] = [];
  if (imageBase64) {
    parts.push({ inlineData: { data: imageBase64, mimeType: 'image/jpeg' } });
  }
  parts.push({ text: prompt });

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: [{ role: 'user', parts }],
    config: {
      responseModalities: ['TEXT', 'IMAGE'],
      abortSignal,
    },
  });

  const responseParts = response.candidates?.[0]?.content?.parts ?? [];
  const img = responseParts.find((p: Part) =>
    p.inlineData?.mimeType?.startsWith('image/'),
  );

  if (!img?.inlineData?.data) {
    throw new Error('No image was generated in the response');
  }

  return img.inlineData.data;
}

export async function generateWithResilience(
  prompt: string,
  imageBase64?: string,
  signal?: AbortSignal,
): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY environment variable is not set');
  }

  const ai = new GoogleGenAI({ apiKey });

  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(), 30000);

  if (signal) {
    signal.addEventListener('abort', () => timeoutController.abort(), { once: true });
  }

  const abortSignal = timeoutController.signal;

  try {
    for (let attempt = 0; attempt <= 3; attempt++) {
      if (abortSignal.aborted) {
        throw new Error('Request was cancelled');
      }

      try {
        return await doGenerate(ai, prompt, imageBase64, abortSignal);
      } catch (err) {
        if (isAbortError(err)) {
          throw err;
        }

        const code = classifyError(err);

        if (code === 'CONTENT_POLICY') {
          throw new Error(
            'Image generation blocked by safety filters. Please revise your prompt.',
          );
        }

        if (!isRetryable(code) || attempt === 3) {
          throw err;
        }

        const delay = 2000 * Math.pow(2, attempt);
        await sleep(delay);
      }
    }

    throw new Error('Image generation failed after maximum retries');
  } finally {
    clearTimeout(timeoutId);
  }
}

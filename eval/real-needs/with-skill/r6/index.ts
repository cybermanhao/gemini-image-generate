import { GoogleGenAI, type Part } from '@google/genai';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

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

async function doGenerate(
  prompt: string,
  imageBase64?: string,
  signal?: AbortSignal,
): Promise<string> {
  const parts: Part[] = [];

  if (imageBase64) {
    parts.push({ inlineData: { data: imageBase64, mimeType: 'image/jpeg' } });
  }

  parts.push({ text: prompt });

  const response = await ai.models.generateContent({
    model: 'gemini-3.1-flash-image-preview',
    contents: [{ role: 'user', parts }],
    config: {
      responseModalities: ['TEXT', 'IMAGE'],
      abortSignal: signal,
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
  const maxRetries = 3;

  for (let i = 0; i < maxRetries; i++) {
    if (signal?.aborted) {
      throw new Error('Request was cancelled');
    }

    try {
      return await doGenerate(prompt, imageBase64, signal);
    } catch (err: any) {
      if (isAbortError(err)) {
        throw err;
      }

      const code = classifyError(err);

      if (code === 'CONTENT_POLICY') {
        throw new Error(
          'Image generation blocked by safety filters. Please revise your prompt.',
        );
      }

      if (!isRetryable(code) || i === maxRetries - 1) {
        throw err;
      }

      // Exponential backoff: 2s, 4s, 8s
      const delay = 2000 * Math.pow(2, i);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  // Unreachable — loop always returns or throws
  throw new Error('Image generation failed after maximum retries');
}

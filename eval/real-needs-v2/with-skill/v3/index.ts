import { GoogleGenAI, type Part } from '@google/genai';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
const MODEL = 'gemini-3.1-flash-image-preview';
const MAX_RETRIES = 3;
const TIMEOUT_MS = 30000;

function isRetryable(err: unknown): boolean {
  const e = err as Record<string, any>;
  const code = e?.error?.code ?? e?.status;
  if (code === 429 || code === 'RESOURCE_EXHAUSTED') return true;
  if (code === 503 || code === 'UNAVAILABLE') return true;
  const msg = String(e?.error?.message ?? '');
  return msg.includes('fetch failed') || msg.includes('ETIMEDOUT') || msg.includes('ECONNRESET');
}

function isFileApiForbidden(err: unknown): boolean {
  const e = err as Record<string, any>;
  const code = e?.error?.code ?? e?.status;
  const msg = String(e?.error?.message ?? e?.message ?? '');
  return (code === 403 || code === 'PERMISSION_DENIED') && msg.includes('File');
}

function isSafetyBlock(err: unknown): boolean {
  const e = err as Record<string, any>;
  const msg = String(e?.message ?? '');
  return msg.includes('SAFETY') || msg.includes('BLOCKLIST') || msg.includes('content filter');
}

function isResponseSafetyBlocked(response: any): boolean {
  const candidate = response?.candidates?.[0];
  if (!candidate) return false;
  return candidate.finishReason === 'SAFETY' || candidate.finishReason === 'BLOCKLIST';
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function generateWithResilience(
  prompt: string,
  imageBase64?: string,
): Promise<string> {
  let fileUri: string | null = null;

  if (imageBase64) {
    const buffer = Buffer.from(imageBase64, 'base64');
    const blob = new Blob([buffer], { type: 'image/jpeg' });
    const uploaded = await ai.files.upload({
      file: blob,
      config: { mimeType: 'image/jpeg' },
    });
    fileUri = uploaded.uri ?? null;
  }

  const inlinePart: Part | null = imageBase64
    ? { inlineData: { data: imageBase64, mimeType: 'image/jpeg' } }
    : null;
  let filePart: Part | null = fileUri
    ? { fileData: { fileUri, mimeType: 'image/jpeg' } }
    : null;

  const parts: Part[] = [];
  if (filePart ?? inlinePart) {
    parts.push((filePart ?? inlinePart)!);
  }
  parts.push({ text: prompt });

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const response = await ai.models.generateContent({
        model: MODEL,
        contents: [{ role: 'user', parts }],
        config: {
          responseModalities: ['TEXT', 'IMAGE'],
          imageConfig: { aspectRatio: '1:1', imageSize: '1K' },
          abortSignal: controller.signal,
        },
      });

      if (isResponseSafetyBlocked(response)) {
        throw new Error('Safety filter blocked the generation');
      }

      const responseParts = response.candidates?.[0]?.content?.parts ?? [];
      const img = responseParts.find((p: any) =>
        p.inlineData?.mimeType?.startsWith('image/'),
      );
      if (img?.inlineData?.data) {
        return img.inlineData.data;
      }

      throw new Error('No image data found in response');
    } catch (err: any) {
      if (isSafetyBlock(err)) {
        throw err;
      }

      if (isFileApiForbidden(err) && filePart) {
        parts[0] = inlinePart!;
        filePart = null;
        continue;
      }

      if (!isRetryable(err)) {
        throw err;
      }

      if (attempt === MAX_RETRIES) {
        throw err;
      }

      const delay = Math.pow(2, attempt) * 1000;
      await sleep(delay);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  throw new Error('Max retries exceeded');
}

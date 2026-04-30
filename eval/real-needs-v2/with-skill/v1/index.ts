import { GoogleGenAI, type Part } from '@google/genai';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
const MODEL = 'gemini-3.1-flash-image-preview';

function isRetryable(err: unknown): boolean {
  const e = err as Record<string, any>;
  const code = e?.error?.code ?? e?.status;
  if (code === 429 || code === 'RESOURCE_EXHAUSTED') return true;
  if (code === 503 || code === 'UNAVAILABLE') return true;
  const msg = String(e?.error?.message ?? '');
  return msg.includes('fetch failed') || msg.includes('ETIMEDOUT') || msg.includes('ECONNRESET');
}

async function improveSingleImage(
  base64: string,
  originalPrompt?: string,
): Promise<{ base64: string; improved: boolean }> {
  const instruction = originalPrompt
    ? `Make this product photo look better. The product is: ${originalPrompt}. Enhance lighting, color balance, and overall professional quality. Preserve the exact product details, colors, and shape.`
    : 'Make this product photo look better. Enhance lighting, color balance, and overall professional quality. Preserve the exact product details, colors, and shape.';

  const parts: Part[] = [
    { inlineData: { data: base64, mimeType: 'image/jpeg' } },
    { text: instruction },
  ];

  const config = {
    responseModalities: ['TEXT', 'IMAGE'] as const,
    imageConfig: { aspectRatio: '1:1' as const },
  };

  async function tryGenerate(): Promise<{ base64: string; improved: boolean }> {
    const response = await ai.models.generateContent({
      model: MODEL,
      contents: [{ role: 'user', parts }],
      config,
    });

    const responseParts = response.candidates?.[0]?.content?.parts ?? [];
    const img = responseParts.find((p) => p.inlineData?.mimeType?.startsWith('image/'));
    if (img?.inlineData?.data) {
      return { base64: img.inlineData.data, improved: true };
    }
    return { base64, improved: false };
  }

  try {
    return await tryGenerate();
  } catch (err) {
    if (isRetryable(err)) {
      try {
        return await tryGenerate();
      } catch {
        return { base64, improved: false };
      }
    }
    return { base64, improved: false };
  }
}

export async function handleImages(
  images: Array<{ base64: string; originalPrompt?: string }>,
): Promise<Array<{ base64: string; improved: boolean }>> {
  return Promise.all(
    images.map((image) => improveSingleImage(image.base64, image.originalPrompt)),
  );
}

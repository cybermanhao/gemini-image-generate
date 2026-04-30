import { GoogleGenAI, ThinkingLevel, type Part } from '@google/genai';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

export async function generateWithStreaming(
  prompt: string,
  signal?: AbortSignal,
): Promise<{ image: string; progress: string[] }> {
  const parts: Part[] = [{ text: prompt }];

  const stream = await ai.models.generateContentStream({
    model: 'gemini-3.1-flash-image-preview',
    contents: [{ role: 'user', parts }],
    config: {
      responseModalities: ['TEXT', 'IMAGE'],
      imageConfig: { aspectRatio: '1:1', imageSize: '1K' },
      thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
      abortSignal: signal,
    },
  });

  const allParts: Part[] = [];
  const progress: string[] = [];

  for await (const chunk of stream) {
    const chunkParts = chunk.candidates?.[0]?.content?.parts ?? [];
    for (const p of chunkParts) {
      if (p.text) {
        progress.push(p.text);
      }
      allParts.push(p);
    }
  }

  const img = allParts.find((p) => p.inlineData?.mimeType?.startsWith('image/'));
  if (!img?.inlineData?.data) {
    throw new Error('Model did not return an image');
  }

  return {
    image: img.inlineData.data,
    progress,
  };
}

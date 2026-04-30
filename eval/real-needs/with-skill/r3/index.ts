import { GoogleGenAI, type Part } from '@google/genai';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

function interleaveInstructionParts(
  instruction: string,
  picPartMap: Map<number, Part>,
): Part[] {
  const parts: Part[] = [];
  let lastIndex = 0;
  const regex = /\[pic_(\d+)\]/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(instruction)) !== null) {
    const idx = parseInt(match[1], 10);
    const part = picPartMap.get(idx);
    if (!part) continue;

    const before = instruction.slice(lastIndex, match.index);
    if (before) parts.push({ text: before });
    parts.push(part);
    lastIndex = regex.lastIndex;
  }

  const after = instruction.slice(lastIndex);
  if (after) parts.push({ text: after });

  return parts;
}

export async function generateProductShot(
  productBase64: string,
  moodBase64: string,
  logoBase64: string,
): Promise<string> {
  const instruction = `Place the product from [pic_1] centered in the foreground on a reflective surface.
Use the mood and lighting from [pic_2] as the background environment.
Add the brand logo from [pic_3] subtly in the top-right corner.
MOST IMPORTANT: Maintain the watch's exact original colors and metal finish.
Do NOT copy background colors onto the watch.
Do NOT let the background's warm tones change how the watch looks.
Preserve the watch's original colors and material finish exactly.
Style: luxury product photography, soft studio lighting, 4K detail.`;

  const picMap = new Map<number, Part>([
    [1, { inlineData: { data: productBase64, mimeType: 'image/png' } }],
    [2, { inlineData: { data: moodBase64, mimeType: 'image/png' } }],
    [3, { inlineData: { data: logoBase64, mimeType: 'image/png' } }],
  ]);

  const parts = interleaveInstructionParts(instruction, picMap);

  const response = await ai.models.generateContent({
    model: 'gemini-3.1-flash-image-preview',
    contents: [{ role: 'user', parts }],
    config: {
      responseModalities: ['TEXT', 'IMAGE'],
      imageConfig: { aspectRatio: '1:1', imageSize: '1K' },
    },
  });

  const responseParts = response.candidates?.[0]?.content?.parts ?? [];
  const img = responseParts.find(
    (p) => p.inlineData?.mimeType?.startsWith('image/'),
  );

  if (!img?.inlineData?.data) {
    throw new Error('No image generated');
  }

  return img.inlineData.data;
}

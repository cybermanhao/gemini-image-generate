import { GoogleGenAI, type Part } from '@google/genai';

const MODEL = 'gemini-3.1-flash-image-preview';

export async function blendDesigns(
  subjectBase64: string,
  designRefBase64: string,
): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('Missing GEMINI_API_KEY environment variable');
  }

  const ai = new GoogleGenAI({ apiKey });

  const parts: Part[] = [
    { inlineData: { data: designRefBase64, mimeType: 'image/png' } },
    {
      text:
        'DESIGN REFERENCE — COPY ONLY: flowing green-and-white color palette, elegant posture, horn-like headpiece aesthetic. ' +
        'NEVER COPY: the exact species form, face structure, or body shape of the reference character.',
    },
    { inlineData: { data: subjectBase64, mimeType: 'image/png' } },
    {
      text:
        'Redraw the subject above incorporating the design reference elements: ' +
        'adopt the flowing green-and-white color palette, the elegant posture, and a horn-like headpiece inspired by the reference. ' +
        'CRITICAL: she must remain clearly herself. Do NOT turn her into the reference character. ' +
        'Preserve her original face, hair, body proportions, and core identity. ' +
        'Only borrow the specific design touches mentioned above.',
    },
  ];

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: [{ role: 'user', parts }],
    config: {
      responseModalities: ['TEXT', 'IMAGE'],
      imageConfig: { aspectRatio: '1:1' },
    },
  });

  const generatedParts = response.candidates?.[0]?.content?.parts ?? [];
  const imagePart = generatedParts.find((p) =>
    p.inlineData?.mimeType?.startsWith('image/'),
  );

  if (!imagePart?.inlineData?.data) {
    throw new Error('No image returned from Gemini');
  }

  return imagePart.inlineData.data;
}

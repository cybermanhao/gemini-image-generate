import { GoogleGenAI, type Part } from '@google/genai';

export async function blendDesigns(
  subjectBase64: string,
  designRefBase64: string,
): Promise<string> {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

  const parts: Part[] = [
    { inlineData: { data: designRefBase64, mimeType: 'image/jpeg' } },
    {
      text: `DESIGN REFERENCE — COPY ONLY: the flowing green-and-white color palette, elegant posture, horn-like headpiece.
NEVER COPY: Gardevoir's exact body shape, facial structure, full Pokemon appearance, or turning the subject into Gardevoir.
KEEP ALL characteristics of the subject in the NEXT image.`,
    },
    { inlineData: { data: subjectBase64, mimeType: 'image/jpeg' } },
    {
      text: 'Render the subject above incorporating ONLY the specified design elements from the design reference. She must remain clearly herself — do NOT transform her into the reference character.',
    },
  ];

  const response = await ai.models.generateContent({
    model: 'gemini-2.0-flash-exp-image-generation',
    contents: [{ role: 'user', parts }],
    config: {
      responseModalities: ['Text', 'Image'],
    },
  });

  const imagePart = response.candidates?.[0]?.content?.parts?.find(
    (p): p is Part & { inlineData: { data: string; mimeType: string } } =>
      'inlineData' in p && p.inlineData != null,
  );

  if (!imagePart) {
    throw new Error('No image returned from Gemini');
  }

  return imagePart.inlineData.data;
}

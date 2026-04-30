import { GoogleGenAI, type Part } from '@google/genai';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

export async function generateCosplay(
  subjectBase64: string,
  costumeRefBase64: string
): Promise<string> {
  const parts: Part[] = [
    // 1. Style/costume reference image first
    { inlineData: { data: costumeRefBase64, mimeType: 'image/png' } },

    // 2. Guardrails — explicitly separate what to copy vs. preserve
    {
      text: `COSTUME REFERENCE — COPY ONLY: wing texture, flame color scheme on the back.
NEVER COPY: facial features, body shape, head shape, electric cheek pouches.
KEEP ALL characteristics of the subject in the NEXT image exactly as they are.`,
    },

    // 3. Subject image
    { inlineData: { data: subjectBase64, mimeType: 'image/png' } },

    // 4. Instruction text last
    {
      text: "Render the subject cosplaying as the costume reference: apply Charizard's wing texture and flame color scheme to the subject's back, while keeping the subject's own face, body shape, and electric cheek pouches completely unchanged.",
    },
  ];

  const response = await ai.models.generateContent({
    model: 'gemini-2.0-flash-exp-image-generation',
    contents: [{ role: 'user', parts }],
    config: {
      responseModalities: ['Text', 'Image'],
    },
  });

  const candidate = response.candidates?.[0];
  const imagePart = candidate?.content?.parts?.find(
    (p: Part) => p.inlineData != null
  );

  if (!imagePart?.inlineData?.data) {
    throw new Error('No image was generated in the response');
  }

  return imagePart.inlineData.data;
}

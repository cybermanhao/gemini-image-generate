import { GoogleGenAI } from '@google/genai';

export async function generate(prompt: string): Promise<string> {
  const ai = new GoogleGenAI({ apiKey: 'test' });
  const result = await ai.models.generateContent({
    model: 'gemini-3.1-flash-image-preview',
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config: { responseModalities: ['TEXT', 'IMAGE'] },
  });
  return result.candidates[0].content.parts[0].inlineData.data;
}

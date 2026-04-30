import { GoogleGenAI } from "@google/genai";

const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

export async function generateWithStreaming(
  prompt: string,
  signal?: AbortSignal
): Promise<{ image: string; progress: string[] }> {
  const progress: string[] = [];
  let image = "";

  if (signal?.aborted) {
    throw new Error("Generation cancelled");
  }

  const stream = await client.models.generateContentStream({
    model: "gemini-2.0-flash-exp-image-generation",
    contents: prompt,
  });

  for await (const chunk of stream) {
    if (signal?.aborted) {
      throw new Error("Generation cancelled");
    }

    const parts = chunk.candidates?.[0]?.content?.parts ?? [];
    for (const part of parts) {
      if (part.text) {
        progress.push(part.text);
      }
      if (part.inlineData?.data) {
        image = part.inlineData.data;
      }
    }
  }

  return { image, progress };
}

import { GoogleGenAI, type GenerateContentConfig, type Part } from "@google/genai";

export async function refineCharacter(
  prevImageBase64: string,
  thoughtSig: string | undefined,
  userFeedback: string
): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY environment variable is not set");
  }

  const ai = new GoogleGenAI({ apiKey });

  const parts: Part[] = [];

  if (!thoughtSig) {
    parts.push({
      inlineData: {
        mimeType: "image/png",
        data: prevImageBase64,
      },
    });
  }

  parts.push({
    text: `Refine this cyberpunk character image based on the following feedback: ${userFeedback}`,
  });

  const config: GenerateContentConfig = {
    responseModalities: ["TEXT", "IMAGE"],
  };

  if (thoughtSig) {
    (config as any).thoughtSignature = thoughtSig;
  }

  const response = await ai.models.generateContent({
    model: "gemini-2.0-flash-exp-image-generation",
    contents: [{ role: "user", parts }],
    config,
  });

  const candidate = response.candidates?.[0];
  if (!candidate) {
    throw new Error("No candidate returned from Gemini");
  }

  const contentParts = candidate.content?.parts;
  if (!contentParts) {
    throw new Error("No content parts in Gemini response");
  }

  for (const part of contentParts) {
    if (part.inlineData?.data) {
      return part.inlineData.data;
    }
  }

  throw new Error("No image data found in Gemini response");
}

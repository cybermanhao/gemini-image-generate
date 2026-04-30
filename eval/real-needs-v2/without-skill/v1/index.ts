import { GoogleGenAI } from "@google/genai";

export async function handleImages(
  images: Array<{ base64: string; originalPrompt?: string }>
): Promise<Array<{ base64: string; improved: boolean }>> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not set");
  }

  const ai = new GoogleGenAI({ apiKey });
  const model = "gemini-2.0-flash-exp-image-generation";

  const results: Array<{ base64: string; improved: boolean }> = [];

  for (const image of images) {
    const promptText = image.originalPrompt
      ? `Make this product photo look better. Original context: ${image.originalPrompt}`
      : "Make this product photo look better.";

    try {
      const response = await ai.models.generateContent({
        model,
        contents: [
          {
            role: "user",
            parts: [
              { text: promptText },
              {
                inlineData: {
                  mimeType: "image/jpeg",
                  data: image.base64,
                },
              },
            ],
          },
        ],
        config: {
          responseModalities: ["Text", "Image"],
        },
      });

      const candidate = response.candidates?.[0];
      const parts = candidate?.content?.parts ?? [];
      const imagePart = parts.find((part) => part.inlineData);

      if (imagePart?.inlineData?.data) {
        results.push({
          base64: imagePart.inlineData.data,
          improved: true,
        });
      } else {
        results.push({
          base64: image.base64,
          improved: false,
        });
      }
    } catch {
      results.push({
        base64: image.base64,
        improved: false,
      });
    }
  }

  return results;
}

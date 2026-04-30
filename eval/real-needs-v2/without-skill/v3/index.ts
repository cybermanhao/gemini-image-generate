import { GoogleGenAI } from "@google/genai";

const MODEL = "gemini-2.0-flash-exp-image-generation";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function generateWithResilience(
  prompt: string,
  imageBase64?: string
): Promise<string> {
  const client = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY || "" });

  const parts: Array<
    | { text: string }
    | { inlineData: { mimeType: string; data: string } }
  > = [{ text: prompt }];

  if (imageBase64) {
    parts.push({
      inlineData: {
        mimeType: "image/png",
        data: imageBase64,
      },
    });
  }

  const maxRetries = 3;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await client.models.generateContent({
        model: MODEL,
        contents: [{ role: "user", parts }],
      });

      // Prompt-level safety block — do not retry
      if (response.promptFeedback?.blockReason === "SAFETY") {
        throw new Error("Safety filter blocked the generation");
      }

      const candidate = response.candidates?.[0];
      if (!candidate) {
        throw new Error("No candidate returned");
      }

      // Candidate-level safety block — do not retry
      if (
        candidate.finishReason === "SAFETY" ||
        candidate.finishReason === "BLOCKLIST"
      ) {
        throw new Error("Safety filter blocked the generation");
      }

      // Extract generated image base64
      for (const part of candidate.content?.parts || []) {
        if (part.inlineData?.data) {
          return part.inlineData.data;
        }
      }

      throw new Error("No image data found in response");
    } catch (error: any) {
      // Safety filter blocks must not be retried
      if (error.message?.includes("Safety filter blocked")) {
        throw error;
      }

      const statusCode = error.status || error.statusCode || error.code;
      const msg = error.message || String(error);

      const isRetryable =
        statusCode === 429 ||
        statusCode === 503 ||
        msg.includes("429") ||
        msg.includes("503") ||
        msg.includes("Rate limit") ||
        msg.includes("Unavailable");

      // Non-retryable client error (4xx except 429)
      if (
        !isRetryable ||
        (typeof statusCode === "number" &&
          statusCode >= 400 &&
          statusCode < 500 &&
          statusCode !== 429)
      ) {
        throw error;
      }

      if (attempt === maxRetries) {
        throw error;
      }

      // Exponential backoff: 1s, 2s, 4s
      await sleep(Math.pow(2, attempt) * 1000);
    }
  }

  throw new Error("Max retries exceeded");
}

import { GoogleGenAI, type Part } from "@google/genai";

const MODEL = "gemini-2.5-flash";

interface EvalInput {
  base64: string;
  prompt: string;
}

interface EvalResult {
  id: number;
  scores: {
    match: number;
    lighting: number;
    color: number;
  };
  flagged: boolean;
}

/**
 * Evaluates a batch of generated product images against their original prompts.
 *
 * Scores each image 1–5 on:
 *   - match    : how well the image matches the requested product
 *   - lighting : quality and appropriateness of lighting
 *   - color    : accuracy of colors compared to the prompt
 *
 * Flags any image that scores below 4 on any dimension.
 *
 * @param images - Array of images with their original generation prompts
 * @returns Evaluation results with scores and flag status
 */
export async function batchEvaluate(images: EvalInput[]): Promise<EvalResult[]> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY environment variable is not set");
  }

  const ai = new GoogleGenAI({ apiKey });

  const results = await Promise.all(
    images.map(async (image, index): Promise<EvalResult> => {
      const parts: Part[] = [
        {
          text: `You are a quality-control evaluator for AI-generated product images.

Evaluate the attached generated image against the original prompt below.
Score the image from 1 to 5 on these three dimensions:
- match    : how well the image matches the requested product
- lighting : quality and appropriateness of the lighting
- color    : accuracy of colors compared to the prompt

Respond ONLY with a JSON object in this exact format (no markdown, no extra text):
{"match": <int 1-5>, "lighting": <int 1-5>, "color": <int 1-5>}

Original prompt: ${image.prompt}`,
        },
        {
          inlineData: {
            mimeType: "image/png",
            data: image.base64,
          },
        },
      ];

      const response = await ai.models.generateContent({
        model: MODEL,
        contents: [{ role: "user", parts }],
      });

      const text =
        response.candidates?.[0]?.content?.parts
          ?.map((p) => p.text ?? "")
          .join("")
          .trim() ?? "";

      let scores: { match: number; lighting: number; color: number };
      try {
        const cleaned = text.replace(/^```json\s*/, "").replace(/```\s*$/, "");
        const parsed = JSON.parse(cleaned);
        scores = {
          match: clampInt(parsed.match, 1, 5),
          lighting: clampInt(parsed.lighting, 1, 5),
          color: clampInt(parsed.color, 1, 5),
        };
      } catch {
        scores = { match: 1, lighting: 1, color: 1 };
      }

      const flagged = scores.match < 4 || scores.lighting < 4 || scores.color < 4;

      return {
        id: index,
        scores,
        flagged,
      };
    }),
  );

  return results;
}

function clampInt(value: unknown, min: number, max: number): number {
  const num = typeof value === "number" ? value : NaN;
  if (Number.isNaN(num)) return min;
  return Math.max(min, Math.min(max, Math.round(num)));
}

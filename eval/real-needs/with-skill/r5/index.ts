import { GoogleGenAI } from '@google/genai';

interface ImageInput {
  base64: string;
  prompt: string;
}

interface EvaluationResult {
  id: number;
  scores: {
    match: number;
    lighting: number;
    color: number;
  };
  flagged: boolean;
}

const JUDGE_SYSTEM_PROMPT = `You are an expert image evaluator scoring product photography.

Evaluate the provided product image against the original generation prompt. Respond ONLY with a JSON object in this exact shape (no markdown fences, no extra commentary):

{
  "match": number,      // 1-5: how accurately the image depicts the requested product
  "lighting": number,   // 1-5: quality, direction, and consistency of lighting
  "color": number       // 1-5: color accuracy and fidelity to the prompt description
}

Scoring rubric (1 = poor, 3 = acceptable, 5 = excellent). Be strict: award 5 only for near-flawless results.`;

function extractJson(text: string): unknown {
  // Try parsing directly first
  try {
    return JSON.parse(text.trim());
  } catch {
    // noop
  }

  // Look for a fenced JSON block
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1].trim());
    } catch {
      // noop
    }
  }

  // Look for the first '{' and last '}' as a fallback
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1).trim());
    } catch {
      // noop
    }
  }

  throw new Error('Unable to extract valid JSON from model response');
}

function normalizeScore(value: unknown): number {
  const num = typeof value === 'number' ? value : Number(value);
  if (Number.isNaN(num)) return 1;
  return Math.max(1, Math.min(5, Math.round(num)));
}

async function evaluateSingle(
  ai: GoogleGenAI,
  image: ImageInput,
  id: number
): Promise<EvaluationResult> {
  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: [
      {
        role: 'user',
        parts: [
          {
            inlineData: {
              data: image.base64,
              mimeType: 'image/jpeg',
            },
          },
          {
            text: `${JUDGE_SYSTEM_PROMPT}\n\nOriginal prompt: "${image.prompt}"`,
          },
        ],
      },
    ],
  });

  const rawText = response.text ?? '';
  const parsed = extractJson(rawText) as Record<string, unknown>;

  const scores = {
    match: normalizeScore(parsed.match),
    lighting: normalizeScore(parsed.lighting),
    color: normalizeScore(parsed.color),
  };

  const flagged = scores.match < 4 || scores.lighting < 4 || scores.color < 4;

  return {
    id,
    scores,
    flagged,
  };
}

export async function batchEvaluate(
  images: Array<ImageInput>
): Promise<Array<EvaluationResult>> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('Missing GEMINI_API_KEY environment variable');
  }

  const ai = new GoogleGenAI({ apiKey });

  const results = await Promise.all(
    images.map((image, index) =>
      evaluateSingle(ai, image, index).catch((error): EvaluationResult => {
        // On failure, return the lowest scores so the image is flagged for regeneration
        return {
          id: index,
          scores: { match: 1, lighting: 1, color: 1 },
          flagged: true,
        };
      })
    )
  );

  return results;
}

import { GoogleGenAI, type Part, type GenerateContentConfig } from '@google/genai';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
const MODEL = 'gemini-3.1-flash-image-preview';

/** Extend Part to include the undocumented thoughtSignature field. */
type RefinePart = Part & { thoughtSignature?: string };

/** Turn 0 — original generation context for the cyberpunk character. */
const TURN0_PARTS: Part[] = [
  { text: 'A detailed cyberpunk character portrait with neon accents and futuristic gear.' },
];

function extractImageBase64(response: any): string {
  const parts: Part[] = response.candidates?.[0]?.content?.parts ?? [];
  const img = parts.find((p) => p.inlineData?.mimeType?.startsWith('image/'));
  if (!img?.inlineData?.data) {
    throw new Error('No generated image found in model response');
  }
  return img.inlineData.data;
}

/**
 * Refine an existing cyberpunk character image.
 *
 * Uses true 3-turn multi-turn Refine when thoughtSignature is available.
 * Falls back to single-turn mode (treating the previous render as a
 * reference image) when thoughtSignature is missing.
 */
export async function refineCharacter(
  prevImageBase64: string,
  thoughtSig: string | undefined,
  userFeedback: string,
): Promise<string> {
  // Build the refinement prompt from user feedback, explicitly mentioning
  // cleaner background and softer lighting.
  const refinementPrompt = `Refine this cyberpunk character image based on the following feedback: ${userFeedback}
Specifically: make the background cleaner and less cluttered, and use softer lighting that is less harsh.`;

  const turn2Parts: Part[] = [{ text: refinementPrompt }];

  let contents: Array<{ role: 'user' | 'model'; parts: Part[] }>;

  if (thoughtSig) {
    // True multi-turn: attach thoughtSignature to the previous render image
    const turn1Parts: RefinePart[] = [
      {
        inlineData: { data: prevImageBase64, mimeType: 'image/jpeg' },
        thoughtSignature: thoughtSig,
      },
    ];

    contents = [
      { role: 'user', parts: TURN0_PARTS },
      { role: 'model', parts: turn1Parts as Part[] },
      { role: 'user', parts: turn2Parts },
    ];
  } else {
    // Degradation fallback: single-turn, previous render as reference image
    contents = [
      {
        role: 'user',
        parts: [
          ...TURN0_PARTS,
          { inlineData: { data: prevImageBase64, mimeType: 'image/jpeg' } },
          ...turn2Parts,
        ],
      },
    ];
  }

  const config: GenerateContentConfig = {
    responseModalities: ['TEXT', 'IMAGE'],
    imageConfig: { aspectRatio: '1:1' },
    // No thinkingConfig for Refine — reduces latency, signature still returned
  };

  const response = await ai.models.generateContent({
    model: MODEL,
    contents,
    config,
  });

  return extractImageBase64(response);
}

import { GoogleGenAI, type Part } from "@google/genai";

const MODEL = "gemini-3.1-flash-image-preview";

/**
 * Generates a luxury product photograph of a watch using three reference images.
 *
 * @param productBase64 - Base64-encoded image of the product (watch)
 * @param moodBase64    - Base64-encoded mood reference for lighting/atmosphere
 * @param logoBase64    - Base64-encoded brand logo
 * @returns Base64-encoded generated image
 */
export async function generateProductShot(
  productBase64: string,
  moodBase64: string,
  logoBase64: string,
): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("Missing GEMINI_API_KEY environment variable");
  }

  const ai = new GoogleGenAI({ apiKey });

  const instruction = `Place the product from [pic_1] centered in the foreground on a reflective surface.
Use the mood and lighting from [pic_2] as the background environment.
Add the brand logo from [pic_3] subtly in the top-right corner, unobtrusive and watermarked.
CRITICAL COLOR FIDELITY: the watch must keep its exact original colors and metal finish.
Do NOT let the background's warm tones change how the watch looks.
Do NOT bleed background colors onto the product.
Preserve the product's exact hues, reflections, and material finish.
Style: luxury product photography, soft studio lighting, 4K detail.`;

  const picMap = new Map<number, Part>([
    [1, { inlineData: { data: productBase64, mimeType: "image/png" } }],
    [2, { inlineData: { data: moodBase64, mimeType: "image/png" } }],
    [3, { inlineData: { data: logoBase64, mimeType: "image/png" } }],
  ]);

  const parts = interleaveInstructionParts(instruction, picMap);

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: [{ role: "user", parts }],
    config: {
      responseModalities: ["TEXT", "IMAGE"],
    },
  });

  const generatedParts = response.candidates?.[0]?.content?.parts ?? [];
  const imagePart = generatedParts.find((p) =>
    p.inlineData?.mimeType?.startsWith("image/"),
  );

  if (!imagePart?.inlineData?.data) {
    throw new Error("No image returned from Gemini");
  }

  return imagePart.inlineData.data;
}

/**
 * Interleaves [pic_N] placeholders in an instruction with actual image parts.
 */
function interleaveInstructionParts(
  instruction: string,
  picMap: Map<number, Part>,
): Part[] {
  const parts: Part[] = [];
  const regex = /\[pic_(\d+)\]/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(instruction)) !== null) {
    const index = parseInt(match[1], 10);
    const pic = picMap.get(index);
    if (!pic) {
      throw new Error(`Missing image for [pic_${index}]`);
    }

    if (match.index > lastIndex) {
      parts.push({ text: instruction.slice(lastIndex, match.index) });
    }
    parts.push(pic);
    lastIndex = regex.lastIndex;
  }

  if (lastIndex < instruction.length) {
    parts.push({ text: instruction.slice(lastIndex) });
  }

  return parts;
}

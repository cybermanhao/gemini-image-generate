import { GoogleGenAI, type Part } from '@google/genai';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
const model = 'gemini-3.1-flash-image-preview';

/**
 * Generate a multi-character scene where 3 waifus wear Pokémon-themed outfits
 * in a cozy café setting. Each character's costume incorporates visual elements
 * from one Pokémon reference, while preserving their original identity.
 *
 * Parts ordering: Pokémon style refs → character refs → instruction LAST.
 */
export async function generateMultiCharacterScene(
  waifuA: string,
  waifuB: string,
  waifuC: string,
  pokemonX: string,
  pokemonY: string,
  pokemonZ: string,
): Promise<string> {
  const parts: Part[] = [
    // Style references FIRST (Pokémon costume elements)
    { inlineData: { data: pokemonX, mimeType: 'image/png' } },
    { inlineData: { data: pokemonY, mimeType: 'image/png' } },
    { inlineData: { data: pokemonZ, mimeType: 'image/png' } },
    // Character references AFTER style refs
    { inlineData: { data: waifuA, mimeType: 'image/png' } },
    { inlineData: { data: waifuB, mimeType: 'image/png' } },
    { inlineData: { data: waifuC, mimeType: 'image/png' } },
    // Detailed instruction LAST
    {
      text: `Create a warm, cozy Pokémon-themed café scene showing all 3 characters interacting naturally together.

CHARACTER A (first waifu reference): Wearing an outfit inspired by the FIRST Pokémon reference. Incorporate its color palette, texture patterns, and iconic accessory elements into her clothing. She must keep her original face shape, hair color, and body proportions exactly as shown. Do NOT turn her into the Pokémon — she remains human, wearing a Pokémon-themed costume.

CHARACTER B (second waifu reference): Wearing an outfit inspired by the SECOND Pokémon reference. Incorporate its visual motifs, signature colors, and distinctive design elements into her clothing. Preserve her original face, hairstyle, and figure completely. Do NOT transform her into the Pokémon — she is a human girl in themed attire.

CHARACTER C (third waifu reference): Wearing an outfit inspired by the THIRD Pokémon reference. Blend its characteristic colors, patterns, and recognizable accessories into her outfit. Keep her original facial features, hair style, and body shape intact. Do NOT make her the Pokémon — she stays human with themed clothing.

SCENE: All 3 characters are playing together in a cozy Pokémon café. They are laughing, holding drinks or pastries, sitting at a cute round table with Pokéball-patterned tablecloth. The background shows café interior with Pokémon decorations, warm lighting, and shelves with plushies. Each character's pose shows natural interaction — looking at each other, gesturing, enjoying the moment.

IMPORTANT GUARDRAILS:
- Preserve each character's original face, hair color, and body proportions
- Do NOT transform any character into a Pokémon creature
- Do NOT mix up which Pokémon outfit goes to which character (first Pokémon → first waifu, etc.)
- Ensure the scene feels lively and interactive, not 3 separate portraits
- Keep the art style consistent across all 3 characters`,
    },
  ];

  const response = await ai.models.generateContent({
    model,
    contents: [{ role: 'user', parts }],
    config: {
      responseModalities: ['TEXT', 'IMAGE'],
      imageConfig: { aspectRatio: '16:9', imageSize: '2K' },
    },
  });

  const parts_out = response.candidates?.[0]?.content?.parts ?? [];
  const img = parts_out.find((p: Part) => p.inlineData?.mimeType?.startsWith('image/'));
  if (!img?.inlineData?.data) {
    throw new Error('No image generated');
  }
  return img.inlineData.data;
}

import { GoogleGenAI } from "@google/genai";

const apiKey = process.env.GOOGLE_API_KEY || "";
const client = new GoogleGenAI({ apiKey });

export async function generateMultiCharacterScene(
  waifuA: string,
  waifuB: string,
  waifuC: string,
  pokemonX: string,
  pokemonY: string,
  pokemonZ: string,
): Promise<string> {
  const response = await client.models.generateContent({
    model: "gemini-2.0-flash-exp-image-generation",
    contents: [
      { role: "user", parts: [
        { inlineData: { data: waifuA, mimeType: "image/png" } },
        { inlineData: { data: pokemonX, mimeType: "image/png" } },
        { inlineData: { data: waifuB, mimeType: "image/png" } },
        { inlineData: { data: pokemonY, mimeType: "image/png" } },
        { inlineData: { data: waifuC, mimeType: "image/png" } },
        { inlineData: { data: pokemonZ, mimeType: "image/png" } },
        { text: "Create an image of 3 waifu characters wearing Pokemon-themed outfits in a cafe. Combine each character with one Pokemon's visual style. Make them look cute and playful together." },
      ]},
    ],
    config: {
      responseModalities: ["TEXT", "IMAGE"],
    },
  });

  const parts = response.candidates?.[0]?.content?.parts ?? [];
  const img = parts.find((p: any) => p.inlineData?.mimeType?.startsWith("image/"));
  if (!img?.inlineData?.data) {
    throw new Error("No image generated");
  }
  return img.inlineData.data;
}

import { GoogleGenAI } from "@google/genai";

/**
 * Generates a cosplay image where the subject character wears costume elements
 * from the reference character while preserving its own identity.
 *
 * @param subjectBase64 - Base64-encoded image of the subject (e.g., Pikachu)
 * @param costumeRefBase64 - Base64-encoded image of the costume reference (e.g., Charizard)
 * @returns Base64-encoded generated image
 */
export async function generateCosplay(
  subjectBase64: string,
  costumeRefBase64: string,
): Promise<string> {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new Error("GOOGLE_API_KEY environment variable is required");
  }

  const genAI = new GoogleGenAI({ apiKey });

  const prompt =
    "Create a cosplay transformation. " +
    "The subject character in the first image should wear the costume elements " +
    "from the reference character in the second image. " +
    "Specifically: apply the reference's wing texture and flame color scheme " +
    "to the subject's back and body. " +
    "Crucially, preserve the subject's original face, body shape, and any " +
    "unique identifying features (such as electric cheek pouches) exactly as they appear. " +
    "The result should be the subject character cosplaying as the reference character.";

  const result = await genAI.models.generateContent({
    model: "gemini-2.0-flash-exp-image-generation",
    contents: [
      {
        role: "user",
        parts: [
          { text: prompt },
          {
            inlineData: {
              mimeType: "image/png",
              data: subjectBase64,
            },
          },
          {
            text: "This is the subject character. Keep its face, body shape, and unique features exactly.",
          },
          {
            inlineData: {
              mimeType: "image/png",
              data: costumeRefBase64,
            },
          },
          {
            text: "This is the costume reference. Apply its texture, colors, and style to the subject.",
          },
        ],
      },
    ],
    config: {
      responseModalities: ["TEXT", "IMAGE"],
    },
  });

  const parts = result.candidates?.[0]?.content?.parts;
  if (!parts) {
    throw new Error("No content returned from Gemini");
  }

  for (const part of parts) {
    if (part.inlineData?.data) {
      return part.inlineData.data;
    }
  }

  throw new Error("No image generated in the response");
}

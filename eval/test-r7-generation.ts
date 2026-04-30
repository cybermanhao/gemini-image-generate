import { GoogleGenAI } from '@google/genai';
import * as fs from 'fs';
import * as path from 'path';

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error('GEMINI_API_KEY not set');
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey });
const model = 'gemini-3.1-flash-image-preview';

async function generate() {
  const response = await ai.models.generateContent({
    model,
    contents: [{
      role: 'user',
      parts: [{
        text: `Create a detailed anime-style illustration of 3 famous waifu characters playing together in a cozy Pokémon-themed café. Each character wears an outfit inspired by a different Pokémon, but they remain fully human — do NOT transform them into Pokémon creatures.

CHARACTER 1 — Rem (Re:Zero):
- Base appearance: Short blue hair covering one eye, gentle expression, maid-like figure
- Pokémon outfit theme: Pikachu
- Costume details: Yellow and brown color scheme, electric bolt patterns on her dress collar and cuffs, small Pikachu ear headband, cheek marks painted on her face like blush, lightning-shaped ribbons in her hair
- Must preserve: Her original blue hair color, eye shape, and gentle facial expression

CHARACTER 2 — Zero Two (DARLING in the FRANXX):
- Base appearance: Long pink hair with straight bangs, red horns on head, confident playful smile, athletic build
- Pokémon outfit theme: Charizard
- Costume details: Orange and cream-colored dress with flame-shaped hem, small wing-like shoulder decorations, tail-like sash flowing behind her, warm fiery color accents in her hair accessories
- Must preserve: Her original pink hair, red horns, and confident facial expression

CHARACTER 3 — Misaka Mikoto (A Certain Scientific Railgun):
- Base appearance: Short brown hair with electricity-like spiky texture, sharp determined eyes, slim athletic figure
- Pokémon outfit theme: Blastoise
- Costume details: Blue and cream naval-style uniform with shell-patterned chest plate, small backpack shaped like Blastoise's cannon shells, water ripple patterns on her skirt, blue hair ribbon
- Must preserve: Her original brown hair, determined eye expression, and athletic body proportions

SCENE: The 3 characters sit around a cute round table in a cozy Pokémon Center Café. The interior has warm ambient lighting, Pokéball-patterned tablecloth, shelves with Pokémon plushies in the background, and a counter with a Chansey nurse motif. They are laughing together, holding colorful drinks and pastries. Rem is gently smiling while holding a Pikachu-shaped cookie. Zero Two is leaning back playfully with a flame-themed latte. Mikoto is looking at her friends with a confident grin, her drink having electric-blue bubbles. The composition shows all 3 from a slightly elevated angle, capturing their natural interaction and the warm café atmosphere.

STYLE: High-quality anime illustration, vibrant colors, soft shading, detailed backgrounds, expressive faces. 16:9 widescreen composition.`,
      }],
    }],
    config: {
      responseModalities: ['TEXT', 'IMAGE'],
      imageConfig: { aspectRatio: '16:9', imageSize: '2K' },
    },
  });

  const parts = response.candidates?.[0]?.content?.parts ?? [];
  const img = parts.find((p: any) => p.inlineData?.mimeType?.startsWith('image/'));
  const text = parts.find((p: any) => p.text && !p.thought)?.text?.trim();
  const thought = parts.find((p: any) => p.thought)?.text?.trim();

  if (img?.inlineData?.data) {
    const outPath = path.join(__dirname, 'r7-generated.png');
    fs.writeFileSync(outPath, Buffer.from(img.inlineData.data, 'base64'));
    console.log(`Image saved: ${outPath} (${Math.round(img.inlineData.data.length * 0.75 / 1024)} KB)`);
  } else {
    console.log('No image in response');
  }

  if (text) {
    console.log('\n=== Description ===\n', text);
  }

  if (thought) {
    console.log('\n=== Thought ===\n', thought.slice(0, 500));
  }

  // Check for thoughtSignature
  const sig = (img as any)?.thoughtSignature;
  if (sig) {
    console.log('\n=== thoughtSignature ===\n', sig.slice(0, 100) + '...');
  }
}

generate().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});

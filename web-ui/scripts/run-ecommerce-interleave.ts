/**
 * E-commerce Complex Interleaving Scenario
 *
 * Task: Generate a luxury product shot using 3 reference images interleaved into
 * a complex instruction. Tests whether the skill's [pic_N] pattern is applied
 * correctly in a real multi-image e-commerce pipeline.
 */

import { GoogleGenAI, type Part } from '@google/genai';
import * as fs from 'fs';
import * as path from 'path';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

// Placeholder base64: a 1x1 transparent PNG (will be replaced by actual images if available)
const PLACEHOLDER_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  let lastErr: any;
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      const code = err?.error?.code ?? err?.status;
      const isRetryable = code === 503 || code === 429 || code === 'UNAVAILABLE';
      if (!isRetryable || i === maxRetries - 1) throw err;
      await new Promise(r => setTimeout(r, 2000 * Math.pow(2, i)));
    }
  }
  throw lastErr;
}

function interleaveInstructionParts(instruction: string, picMap: Map<number, Part>): Part[] {
  const parts: Part[] = [];
  const tokenRegex = /\[pic_(\d+)\]/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = tokenRegex.exec(instruction)) !== null) {
    const tokenIndex = match.index;
    const token = match[0];
    const picNumber = parseInt(match[1], 10);

    if (tokenIndex > lastIndex) {
      parts.push({ text: instruction.slice(lastIndex, tokenIndex) });
    }

    const imagePart = picMap.get(picNumber);
    if (imagePart) {
      parts.push(imagePart);
    } else {
      parts.push({ text: token }); // keep token if missing
    }

    lastIndex = tokenRegex.lastIndex;
  }

  if (lastIndex < instruction.length) {
    parts.push({ text: instruction.slice(lastIndex) });
  }

  return parts;
}

async function generateEcommerceInterleave(): Promise<void> {
  const timestamp = Date.now();
  const outDir = path.resolve(`test-results/scenarios/ecommerce-interleave/${timestamp}`);
  fs.mkdirSync(outDir, { recursive: true });

  // Simulate 3 reference images as placeholders
  // In a real scenario these would be actual product/background/logo images
  const productBase64 = PLACEHOLDER_PNG;
  const backgroundBase64 = PLACEHOLDER_PNG;
  const logoBase64 = PLACEHOLDER_PNG;

  // Complex interleaved instruction
  const instruction = `Place the product from [pic_1] centered in the foreground on a reflective surface. Use the mood and lighting from [pic_2] as the background environment. Add the brand logo from [pic_3] subtly in the top-right corner. Maintain the product's original colors and material finish. Style: luxury product photography, soft studio lighting, 4K detail.`;

  const picMap = new Map<number, Part>([
    [1, { inlineData: { data: productBase64, mimeType: 'image/png' } }],
    [2, { inlineData: { data: backgroundBase64, mimeType: 'image/png' } }],
    [3, { inlineData: { data: logoBase64, mimeType: 'image/png' } }],
  ]);

  const interleavedParts = interleaveInstructionParts(instruction, picMap);

  console.log('Interleaved parts sequence:');
  interleavedParts.forEach((p, i) => {
    if (p.text) console.log(`  [${i}] text: "${p.text.slice(0, 60)}..."`);
    if (p.inlineData) console.log(`  [${i}] image: ${p.inlineData.mimeType}`);
  });

  console.log('\nCalling Gemini API...');
  const startTime = Date.now();

  const response = await withRetry(() =>
    ai.models.generateContent({
      model: 'gemini-3.1-flash-image-preview',
      contents: [{ role: 'user', parts: interleavedParts }],
      config: {
        responseModalities: ['TEXT', 'IMAGE'],
        imageConfig: { aspectRatio: '1:1', imageSize: '2K' },
      },
    })
  );

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`Generation completed in ${elapsed}s`);

  const parts = response.candidates?.[0]?.content?.parts ?? [];
  const img = parts.find(p => p.inlineData?.mimeType?.startsWith('image/'));
  const desc = parts.find(p => p.text && !p.thought)?.text?.trim();

  if (img?.inlineData?.data) {
    const buf = Buffer.from(img.inlineData.data, 'base64');
    const imgPath = path.join(outDir, 'turn-0.png');
    fs.writeFileSync(imgPath, buf);
    console.log(`Image saved: ${imgPath} (${(buf.length / 1024).toFixed(0)}KB)`);
  } else {
    console.log('No image in response');
  }

  if (desc) {
    console.log(`Description: ${desc.slice(0, 200)}...`);
  }

  // Save metadata
  const meta = {
    timestamp,
    instruction,
    partsCount: interleavedParts.length,
    textParts: interleavedParts.filter(p => p.text).length,
    imageParts: interleavedParts.filter(p => p.inlineData).length,
    generationTimeSec: elapsed,
    thoughtSignature: img?.thoughtSignature,
  };
  fs.writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify(meta, null, 2));
}

generateEcommerceInterleave().catch(err => {
  console.error('Failed:', err.message);
  process.exit(1);
});

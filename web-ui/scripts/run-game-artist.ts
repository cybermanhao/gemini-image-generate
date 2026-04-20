import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import * as fs from 'fs';
import * as path from 'path';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
const OUT_DIR = path.resolve('test-results', 'scenarios');

interface TurnResult {
  base64: string;
  signature?: string;
  description?: string;
}

async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  let lastErr: any;
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      const code = err?.error?.code ?? err?.status;
      const msg = String(err?.error?.message ?? err?.message ?? '');
      const isRetryable = code === 503 || code === 429 || code === 'UNAVAILABLE' || code === 'RESOURCE_EXHAUSTED' || msg.includes('high demand');
      if (!isRetryable || i === maxRetries - 1) throw err;
      const delay = 2000 * Math.pow(2, i);
      console.log(`    ⚠️ Retry ${i + 1}/${maxRetries} after ${delay}ms: ${msg.slice(0, 80)}`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

async function doGenerateWithRef(params: {
  prompt: string;
  styleRefBase64: string;
  aspectRatio?: string;
  imageSize?: string;
}): Promise<TurnResult> {
  const response = await withRetry(() => ai.models.generateContent({
    model: 'gemini-3.1-flash-image-preview',
    contents: [{
      role: 'user',
      parts: [
        { inlineData: { data: params.styleRefBase64, mimeType: 'image/png' } },
        { text: 'STYLE REFERENCE — COPY ONLY: art style, color palette, rendering technique. NEVER COPY: subject, clothing, pose.' },
        { text: params.prompt },
      ],
    }],
    config: {
      responseModalities: ['TEXT', 'IMAGE'],
      imageConfig: {
        aspectRatio: (params.aspectRatio ?? '1:1') as any,
        imageSize: (params.imageSize ?? '1K') as any,
      },
    },
  }));

  const parts = response.candidates?.[0]?.content?.parts ?? [];
  const img = parts.find((p: any) => p.inlineData?.mimeType?.startsWith('image/'));
  const desc = parts.find((p: any) => p.text && !p.thought)?.text?.trim();
  return {
    base64: img?.inlineData?.data ?? '',
    signature: img?.thoughtSignature ?? undefined,
    description: desc,
  };
}

async function doRefine(params: {
  prevBase64: string;
  prevSig: string;
  instruction: string;
}): Promise<TurnResult> {
  const turn0Parts = [{ role: 'user' as const, parts: [{ text: 'original prompt placeholder' }] }];
  const turn1Parts = [
    { role: 'model' as const, parts: [
      { inlineData: { data: params.prevBase64, mimeType: 'image/png' }, thoughtSignature: params.prevSig },
    ]},
  ];
  const turn2Parts = [{ role: 'user' as const, parts: [{ text: params.instruction }] }];

  const response = await withRetry(() => ai.models.generateContent({
    model: 'gemini-3.1-flash-image-preview',
    contents: [...turn0Parts, ...turn1Parts, ...turn2Parts],
    config: { responseModalities: ['TEXT', 'IMAGE'] },
  }));

  const parts = response.candidates?.[0]?.content?.parts ?? [];
  const img = parts.find((p: any) => p.inlineData?.mimeType?.startsWith('image/'));
  const desc = parts.find((p: any) => p.text && !p.thought)?.text?.trim();
  return {
    base64: img?.inlineData?.data ?? '',
    signature: img?.thoughtSignature ?? undefined,
    description: desc,
  };
}

async function doJudge(imageBase64: string, prompt: string) {
  const judgePrompt = `Evaluate this generated image against the original prompt.\n\nOriginal prompt:\n${prompt}\n\nScore each dimension from 1 (poor) to 5 (excellent). Output ONLY valid JSON:\n{\n  "scores": {\n    "subject_fidelity": { "score": 1, "notes": "..." },\n    "instruction_following": { "score": 1, "notes": "..." },\n    "composition": { "score": 1, "notes": "..." },\n    "lighting_quality": { "score": 1, "notes": "..." },\n    "overall_quality": { "score": 1, "notes": "..." }\n  },\n  "converged": false,\n  "top_issues": [{ "issue": "...", "fix": "..." }],\n  "next_iteration_focus": "..."\n}`;
  const res = await withRetry(() => ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: [{ role: 'user', parts: [{ inlineData: { data: imageBase64, mimeType: 'image/png' } }, { text: judgePrompt }] }],
    config: { thinkingConfig: { thinkingBudget: 0 } },
  }));
  const text = (res.text ?? '').trim();
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('No JSON');
  return JSON.parse(m[0]);
}

async function main() {
  if (!process.env.GEMINI_API_KEY) { console.error('ERROR: GEMINI_API_KEY not set'); process.exit(1); }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // Use anime turn-0 as style reference
  const styleRefPath = 'test-results/scenarios/anime-enthusiast/1776696419128/turn-0.png';
  if (!fs.existsSync(styleRefPath)) {
    console.error('Style reference not found:', styleRefPath);
    process.exit(1);
  }
  const styleRefBase64 = fs.readFileSync(styleRefPath, 'base64');
  console.log('Using anime turn-0 as style reference:', Math.round(styleRefBase64.length / 1024), 'KB');

  const name = 'Game Artist';
  const ts = Date.now();
  const dir = path.join(OUT_DIR, 'game-artist', String(ts));
  fs.mkdirSync(dir, { recursive: true });

  console.log(`\n▶ ${name}`);

  // Turn 0: generate with style ref
  const prompt0 = 'A fantasy RPG character portrait, warrior class, heavy armor, epic pose';
  console.log(`  [Turn 0] generate with style ref: ${prompt0.slice(0, 60)}...`);
  const t0 = Date.now();
  const res0 = await doGenerateWithRef({ prompt: prompt0, styleRefBase64, aspectRatio: '3:4', imageSize: '2K' });
  console.log(`    → ${res0.base64 ? Math.round(res0.base64.length / 1024) + ' KB' : 'NO IMAGE'} in ${Date.now() - t0}ms`);
  if (res0.base64) {
    fs.writeFileSync(path.join(dir, 'turn-0.png'), Buffer.from(res0.base64, 'base64'));
    fs.writeFileSync(path.join(dir, 'style-ref.png'), Buffer.from(styleRefBase64, 'base64'));
  }

  // Turn 1: refine to fire mage
  if (res0.signature) {
    const instruction = 'Change the character class to a fire mage, replace armor with robes, add magical flames in hands';
    console.log(`  [Turn 1] refine: ${instruction.slice(0, 60)}...`);
    const t1 = Date.now();
    const res1 = await doRefine({ prevBase64: res0.base64, prevSig: res0.signature, instruction });
    console.log(`    → ${res1.base64 ? Math.round(res1.base64.length / 1024) + ' KB' : 'NO IMAGE'} in ${Date.now() - t1}ms`);
    if (res1.base64) {
      fs.writeFileSync(path.join(dir, 'turn-1.png'), Buffer.from(res1.base64, 'base64'));
    }
  } else {
    console.log('    ⚠️ No thoughtSignature, skipping refine');
  }

  // Judge final
  const finalBase64 = fs.existsSync(path.join(dir, 'turn-1.png'))
    ? fs.readFileSync(path.join(dir, 'turn-1.png'), 'base64')
    : res0.base64;
  console.log('  [Judge] scoring...');
  const judgeRes = await doJudge(finalBase64, prompt0 + ' → fire mage with magical flames');
  console.log(`    → converged=${judgeRes.converged}`);
  console.log(`      scores: ${Object.entries(judgeRes.scores).map(([k, v]: [string, any]) => `${k}=${v.score}`).join(', ')}`);
  fs.writeFileSync(path.join(dir, 'judge.json'), JSON.stringify(judgeRes, null, 2));

  const meta = {
    scenario: name,
    startedAt: new Date(ts).toISOString(),
    finishedAt: new Date().toISOString(),
    styleRef: styleRefPath,
    turns: [
      { prompt: prompt0, aspectRatio: '3:4', imageSize: '2K', styleRef: true },
      { prompt: 'Change the character class to a fire mage...', aspectRatio: '3:4', imageSize: '2K' },
    ],
    judge: judgeRes,
  };
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
  console.log(`  ✓ Saved to ${dir}`);
}

main().catch(e => { console.error(e); process.exit(1); });

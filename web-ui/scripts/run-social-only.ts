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

async function doGenerate(params: {
  prompt: string;
  aspectRatio?: string;
  imageSize?: string;
  thinkingLevel?: string;
}): Promise<TurnResult> {
  const response = await withRetry(() => ai.models.generateContent({
    model: 'gemini-3.1-flash-image-preview',
    contents: [{ role: 'user', parts: [{ text: params.prompt }] }],
    config: {
      responseModalities: ['TEXT', 'IMAGE'],
      imageConfig: {
        aspectRatio: (params.aspectRatio ?? '1:1') as any,
        imageSize: (params.imageSize ?? '1K') as any,
      },
      thinkingConfig: params.thinkingLevel
        ? { thinkingLevel: params.thinkingLevel as ThinkingLevel }
        : undefined,
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

  const name = 'Social Media Creator';
  const ts = Date.now();
  const dir = path.join(OUT_DIR, 'social-media-creator', String(ts));
  fs.mkdirSync(dir, { recursive: true });

  console.log(`\n▶ ${name}`);
  const prompt = 'Eye-catching thumbnail for a tech review video, bold typography space at top, futuristic gadgets on desk, neon lighting, vertical composition';
  console.log(`  [Turn 0] generate: ${prompt.slice(0, 60)}...`);
  const t0 = Date.now();
  const res = await doGenerate({ prompt, aspectRatio: '9:16', imageSize: '2K' });
  console.log(`    → ${res.base64 ? Math.round(res.base64.length / 1024) + ' KB' : 'NO IMAGE'} in ${Date.now() - t0}ms`);

  if (res.base64) {
    fs.writeFileSync(path.join(dir, 'turn-0.png'), Buffer.from(res.base64, 'base64'));
  }

  console.log('  [Judge] scoring...');
  const judgeRes = await doJudge(res.base64, prompt);
  console.log(`    → converged=${judgeRes.converged}`);
  console.log(`      scores: ${Object.entries(judgeRes.scores).map(([k, v]: [string, any]) => `${k}=${v.score}`).join(', ')}`);
  fs.writeFileSync(path.join(dir, 'judge.json'), JSON.stringify(judgeRes, null, 2));

  const meta = {
    scenario: name,
    startedAt: new Date(ts).toISOString(),
    finishedAt: new Date().toISOString(),
    turns: [{ prompt, aspectRatio: '9:16', imageSize: '2K' }],
    judge: judgeRes,
  };
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
  console.log(`  ✓ Saved to ${dir}`);
}

main().catch(e => { console.error(e); process.exit(1); });

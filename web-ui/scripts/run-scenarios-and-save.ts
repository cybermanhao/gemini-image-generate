#!/usr/bin/env tsx
/**
 * Run scenario-based integration tests against real Gemini API,
 * save generated images + prompt snapshots to disk.
 *
 * Usage:
 *   npx tsx scripts/run-scenarios-and-save.ts
 *
 * Output:
 *   test-results/scenarios/<scenario>/<timestamp>/
 *     ├── turn-0.png          # base generation
 *     ├── turn-1.png          # first refine
 *     ├── turn-2.png          # second refine (if any)
 *     ├── judge.json          # LAAJ scores & issues
 *     └── meta.json           # prompts, config, timing
 */

import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import * as fs from 'fs';
import * as path from 'path';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
const OUT_DIR = path.resolve('test-results', 'scenarios');

// ─── Types ───────────────────────────────────────────────────────────────────

interface TurnResult {
  base64: string;
  signature?: string;
  description?: string;
}

interface JudgeResult {
  scores: Record<string, { score: number; notes: string }>;
  converged: boolean;
  topIssues?: Array<{ issue: string; fix: string }>;
  nextFocus?: string;
}

interface ScenarioMeta {
  scenario: string;
  startedAt: string;
  finishedAt: string;
  turns: Array<{ prompt: string; aspectRatio: string; imageSize: string; thinkingLevel?: string }>;
  judge?: JudgeResult;
}

// ─── Core SDK wrappers (mirroring server.ts logic) ───────────────────────────

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

async function doJudge(imageBase64: string, prompt: string): Promise<JudgeResult> {
  const judgePrompt = `Evaluate this generated image against the original prompt.

Original prompt:
${prompt}

Score each dimension from 1 (poor) to 5 (excellent). Output ONLY valid JSON:
{
  "scores": {
    "subject_fidelity": { "score": 1, "notes": "..." },
    "instruction_following": { "score": 1, "notes": "..." },
    "composition": { "score": 1, "notes": "..." },
    "lighting_quality": { "score": 1, "notes": "..." },
    "overall_quality": { "score": 1, "notes": "..." }
  },
  "converged": false,
  "top_issues": [{ "issue": "...", "fix": "..." }],
  "next_iteration_focus": "single most impactful improvement direction"
}`;

  const response = await withRetry(() => ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: [{
      role: 'user',
      parts: [
        { inlineData: { data: imageBase64, mimeType: 'image/png' } },
        { text: judgePrompt },
      ],
    }],
    config: { thinkingConfig: { thinkingBudget: 0 } },
  }));

  const text = (response.text ?? '').trim();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Judge returned no JSON');
  return JSON.parse(jsonMatch[0]);
}

// ─── Scenario runner ─────────────────────────────────────────────────────────

async function runScenario(
  name: string,
  steps: Array<
    | { type: 'generate'; prompt: string; aspectRatio?: string; imageSize?: string; thinkingLevel?: string }
    | { type: 'refine'; instruction: string }
    | { type: 'judge' }
  >,
) {
  console.log(`\n▶ ${name}`);
  const ts = Date.now();
  const dir = path.join(OUT_DIR, name.replace(/\s+/g, '-').toLowerCase(), String(ts));
  fs.mkdirSync(dir, { recursive: true });

  const meta: ScenarioMeta = { scenario: name, startedAt: new Date().toISOString(), finishedAt: '', turns: [], judge: undefined };
  const images: string[] = [];
  let lastResult: TurnResult | null = null;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (step.type === 'generate') {
      console.log(`  [Turn ${images.length}] generate: ${step.prompt.slice(0, 60)}...`);
      const t0 = Date.now();
      const res = await doGenerate(step);
      console.log(`    → ${res.base64 ? Math.round(res.base64.length / 1024) + ' KB' : 'NO IMAGE'} in ${Date.now() - t0}ms`);
      if (res.base64) {
        const idx = images.length;
        fs.writeFileSync(path.join(dir, `turn-${idx}.png`), Buffer.from(res.base64, 'base64'));
        images.push(res.base64);
      }
      meta.turns.push({ prompt: step.prompt, aspectRatio: step.aspectRatio ?? '1:1', imageSize: step.imageSize ?? '1K', thinkingLevel: step.thinkingLevel });
      lastResult = res;
    } else if (step.type === 'refine') {
      console.log(`  [Turn ${images.length}] refine: ${step.instruction.slice(0, 60)}...`);
      if (!lastResult?.signature) {
        console.log('    ⚠️ No thoughtSignature, skipping refine');
        continue;
      }
      const t0 = Date.now();
      const res = await doRefine({ prevBase64: lastResult.base64, prevSig: lastResult.signature, instruction: step.instruction });
      console.log(`    → ${res.base64 ? Math.round(res.base64.length / 1024) + ' KB' : 'NO IMAGE'} in ${Date.now() - t0}ms`);
      if (res.base64) {
        const idx = images.length;
        fs.writeFileSync(path.join(dir, `turn-${idx}.png`), Buffer.from(res.base64, 'base64'));
        images.push(res.base64);
      }
      meta.turns.push({ prompt: step.instruction, aspectRatio: '1:1', imageSize: '1K' });
      lastResult = res;
    } else if (step.type === 'judge') {
      console.log(`  [Judge] scoring final image...`);
      if (!lastResult?.base64) {
        console.log('    ⚠️ No image to judge');
        continue;
      }
      const t0 = Date.now();
      const judgeRes = await doJudge(lastResult.base64, meta.turns.map(t => t.prompt).join(' → '));
      console.log(`    → converged=${judgeRes.converged} in ${Date.now() - t0}ms`);
      console.log(`      scores: ${Object.entries(judgeRes.scores).map(([k, v]) => `${k}=${v.score}`).join(', ')}`);
      meta.judge = judgeRes;
      fs.writeFileSync(path.join(dir, 'judge.json'), JSON.stringify(judgeRes, null, 2));
    }
  }

  meta.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
  console.log(`  ✓ Saved to ${dir}`);
  return { dir, meta };
}

// ─── Scenarios (mirroring e2e/scenarios/*.spec.ts) ───────────────────────────

const SCENARIOS = [
  {
    name: 'Anime Enthusiast',
    steps: [
      { type: 'generate' as const, prompt: 'Anime style portrait of a cyberpunk girl with neon blue hair, wearing a techwear jacket, sci-fi city background, detailed face, masterpiece', aspectRatio: '2:3', imageSize: '2K', thinkingLevel: 'high' },
      { type: 'refine' as const, instruction: 'Change her hair color to pastel pink and add sakura petals floating around' },
      { type: 'refine' as const, instruction: 'Change the jacket to a traditional Japanese school uniform (seifuku), keep the pink hair' },
      { type: 'judge' as const },
    ],
  },
  {
    name: 'E-commerce Operator',
    steps: [
      { type: 'generate' as const, prompt: 'Professional product photography of a minimalist ceramic coffee mug on pure white background, studio lighting, soft shadows, high detail', aspectRatio: '1:1', imageSize: '2K' },
      { type: 'refine' as const, instruction: 'Make the overall image brighter, increase exposure.' },
      { type: 'refine' as const, instruction: 'Make the product edges sharper and more defined.' },
      { type: 'judge' as const },
    ],
  },
  {
    name: 'Social Media Creator',
    steps: [
      { type: 'generate' as const, prompt: 'Eye-catching thumbnail for a tech review video, bold typography space at top, futuristic gadgets on desk, neon lighting, vertical composition', aspectRatio: '9:16', imageSize: '2K' },
    ],
  },
];

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  if (!process.env.GEMINI_API_KEY) {
    console.error('ERROR: GEMINI_API_KEY not set');
    process.exit(1);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log('Output directory:', OUT_DIR);
  console.log(`Running ${SCENARIOS.length} scenarios...`);

  const results = [];
  for (const s of SCENARIOS) {
    try {
      const r = await runScenario(s.name, s.steps);
      results.push({ name: s.name, status: 'ok', dir: r.dir });
    } catch (err: any) {
      console.error(`  ✗ Failed: ${err.message}`);
      results.push({ name: s.name, status: 'error', error: err.message });
    }
  }

  console.log('\n=== Summary ===');
  for (const r of results) {
    console.log(`${r.status === 'ok' ? '✓' : '✗'} ${r.name}${r.dir ? ' → ' + r.dir : ''}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

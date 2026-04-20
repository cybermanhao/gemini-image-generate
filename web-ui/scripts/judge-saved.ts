import { GoogleGenAI } from '@google/genai';
import * as fs from 'fs';
import * as path from 'path';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

async function judge(imageBase64: string, prompt: string) {
  const judgePrompt = `Evaluate this generated image against the original prompt.\n\nOriginal prompt:\n${prompt}\n\nScore each dimension from 1 (poor) to 5 (excellent). Output ONLY valid JSON:\n{\n  "scores": {\n    "subject_fidelity": { "score": 1, "notes": "..." },\n    "instruction_following": { "score": 1, "notes": "..." },\n    "composition": { "score": 1, "notes": "..." },\n    "lighting_quality": { "score": 1, "notes": "..." },\n    "overall_quality": { "score": 1, "notes": "..." }\n  },\n  "converged": false,\n  "top_issues": [{ "issue": "...", "fix": "..." }],\n  "next_iteration_focus": "..."\n}`;
  const res = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: [{ role: 'user', parts: [{ inlineData: { data: imageBase64, mimeType: 'image/png' } }, { text: judgePrompt }] }],
    config: { thinkingConfig: { thinkingBudget: 0 } },
  });
  const text = (res.text ?? '').trim();
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('No JSON');
  return JSON.parse(m[0]);
}

async function run() {
  const animeDir = 'test-results/scenarios/anime-enthusiast/1776696419128';
  const ecomDir = 'test-results/scenarios/e-commerce-operator/1776696598744';

  console.log('Judging Anime final...');
  const animeBase64 = fs.readFileSync(path.join(animeDir, 'turn-2.png'), 'base64');
  const animeJudge = await judge(animeBase64, 'Anime style portrait, cyberpunk girl, pink hair, school uniform, sakura petals, sci-fi city background');
  fs.writeFileSync(path.join(animeDir, 'judge.json'), JSON.stringify(animeJudge, null, 2));
  console.log('Anime scores:', Object.entries(animeJudge.scores).map(([k,v]: [string, any])=>`${k}=${v.score}`).join(', '));

  console.log('Judging E-commerce final...');
  const ecomBase64 = fs.readFileSync(path.join(ecomDir, 'turn-1.png'), 'base64');
  const ecomJudge = await judge(ecomBase64, 'Professional product photography of a minimalist ceramic coffee mug on pure white background, studio lighting, soft shadows, high detail');
  fs.writeFileSync(path.join(ecomDir, 'judge.json'), JSON.stringify(ecomJudge, null, 2));
  console.log('E-commerce scores:', Object.entries(ecomJudge.scores).map(([k,v]: [string, any])=>`${k}=${v.score}`).join(', '));
}

run().catch(e => { console.error(e.message); process.exit(1); });

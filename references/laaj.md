# LLM-as-a-Judge (LAAJ) — Prompt Evaluation Loop

## Overview

LAAJ uses a vision-capable LLM to score generated images against a rubric, producing structured feedback that directly drives prompt iteration. The loop runs until scores converge or a maximum iteration count is reached.

The judge role is **deliberately separate from the generator role**: use a smaller, cheaper vision model for judgment (e.g., `gemini-2.5-flash`) and reserve the expensive generation model for actual image creation.

---

## Judge Model Selection

The judge model is a parameter — don't hardcode it. Different contexts call for different judges:

| Judge model | When to use |
|-------------|-------------|
| `gemini-2.5-flash` | Default — fast, cheap, good vision |
| `claude-sonnet-4-5` (via Anthropic SDK) | When you want a second opinion from a different model family |
| `gemini-2.5-pro` | High-stakes evaluation where accuracy matters more than cost |
| Claude via `claude -p` subprocess | When running in CLI/script context and want Claude Code as judge |

The judge just needs to accept `[image, text_prompt]` and return structured JSON. The implementation below uses the Gemini SDK but the pattern is model-agnostic.

---

## Scoring Schema

```typescript
interface JudgeOutput {
  scores: {
    [dimension: string]: {
      score: number;      // 1–5
      notes: string;      // specific, actionable observations
    };
  };
  converged: boolean;     // true when all scores >= threshold and no blockers
  top_issues: Array<{
    issue: string;        // concise description of the problem
    fix: string;          // exact prompt language to fix it
  }>;
  next_iteration_focus: string; // single highest-impact direction
}
```

**Adapt the dimensions to your domain.** Generic starter set:

| Dimension | What it checks |
|-----------|---------------|
| `subject_fidelity` | Does the output match the intended subject? |
| `instruction_following` | Did the model follow the prompt faithfully? |
| `composition` | Layout, framing, proportions |
| `lighting_quality` | Shadows, highlights, color temperature |
| `overall_quality` | Global assessment |

---

## Judge Call Implementation

```typescript
import { GoogleGenAI } from '@google/genai';

interface JudgeConfig {
  model: string;                    // judge model ID (default: 'gemini-2.5-flash')
  dimensions: string[];             // list of dimension names to score
  convergenceThreshold: number;     // min score for "converged" (e.g., 4)
  systemPrompt?: string;            // optional domain context
}

async function judgeImage(
  ai: GoogleGenAI,
  imageBase64: string,
  originalPrompt: string,
  config: JudgeConfig,
): Promise<JudgeOutput> {
  const dimensionList = config.dimensions
    .map(d => `  "${d}": { "score": 1-5, "notes": "..." }`)
    .join(',\n');

  const judgePrompt = `${config.systemPrompt ? config.systemPrompt + '\n\n' : ''}Evaluate this generated image against the original prompt.

Original prompt:
${originalPrompt}

Score each dimension from 1 (poor) to 5 (excellent). Output only valid JSON:
{
  "scores": {
${dimensionList}
  },
  "converged": <true if all scores >= ${config.convergenceThreshold} and no critical blockers>,
  "top_issues": [
    { "issue": "...", "fix": "exact prompt language to address this" }
  ],
  "next_iteration_focus": "single most impactful improvement direction"
}`;

  const response = await ai.models.generateContent({
    model: config.model,
    contents: [{
      role: 'user',
      parts: [
        { inlineData: { data: imageBase64, mimeType: 'image/jpeg' } },
        { text: judgePrompt },
      ],
    }],
  });

  const text = (response.text ?? '').trim();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Judge returned no JSON');
  return JSON.parse(jsonMatch[0]) as JudgeOutput;
}
```

---

## The Iteration Loop

```typescript
interface IterationResult {
  prompt: string;
  imageBase64: string;
  judgment: JudgeOutput;
  iteration: number;
}

async function runLaajLoop(
  ai: GoogleGenAI,
  initialPrompt: string,
  generateFn: (prompt: string) => Promise<string>,  // returns base64 image
  judgeConfig: Partial<JudgeConfig> = {},
  maxIterations = 5,
): Promise<IterationResult[]> {
  const config: JudgeConfig = {
    model: 'gemini-2.5-flash',
    dimensions: ['subject_fidelity', 'instruction_following', 'composition', 'lighting_quality', 'overall_quality'],
    convergenceThreshold: 4,
    systemPrompt: '',
    ...judgeConfig,
  };

  const history: IterationResult[] = [];
  let currentPrompt = initialPrompt;

  for (let i = 0; i < maxIterations; i++) {
    const imageBase64 = await generateFn(currentPrompt);
    const judgment = await judgeImage(ai, imageBase64, currentPrompt, config);

    history.push({ prompt: currentPrompt, imageBase64, judgment, iteration: i });

    const allScores = Object.values(judgment.scores).map(s => s.score);
    const meetsThreshold = allScores.length > 0 && allScores.every(s => s >= config.convergenceThreshold);
    if (meetsThreshold && judgment.converged) {
      console.log(`Converged at iteration ${i}`);
      break;
    }

    // Apply top fixes to the prompt
    currentPrompt = applyFixes(currentPrompt, judgment.top_issues);
    console.log(`Iteration ${i}: focus → ${judgment.next_iteration_focus}`);
  }

  return history;
}

function applyFixes(
  prompt: string,
  issues: Array<{ issue: string; fix: string }>,
): string {
  // Simple append strategy — adapt to your prompt structure
  const fixes = issues.map(i => i.fix).join('. ');
  return `${prompt}\n\nAdditional requirements: ${fixes}`;
}
```

---

## Using Claude as Judge (subprocess / CLI)

If you're running in a script context and want Claude Code as the judge instead of a Gemini API call:

```typescript
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

async function judgeWithClaude(
  imageBase64: string,
  originalPrompt: string,
  dimensions: string[],
): Promise<JudgeOutput> {
  // Write image to temp file
  const tmpImg = path.join(os.tmpdir(), `judge_input_${Date.now()}.jpg`);
  fs.writeFileSync(tmpImg, Buffer.from(imageBase64, 'base64'));

  const dimensionList = dimensions.map(d => `- ${d}: score 1-5, notes`).join('\n');

  const claudePrompt = `Evaluate the image at ${tmpImg} against this prompt:

"${originalPrompt}"

Score dimensions:
${dimensionList}

Output JSON matching: { scores: {...}, converged: boolean, top_issues: [{issue, fix}], next_iteration_focus: string }`;

  const result = execFileSync('claude', ['-p', claudePrompt], { encoding: 'utf8' });

  fs.unlinkSync(tmpImg);

  const jsonMatch = result.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Claude returned no JSON');
  return JSON.parse(jsonMatch[0]) as JudgeOutput;
}
```

---

## Practical Notes (from production)

**Avoid absolute color/style descriptions in fixes.** A fix like "make it dark navy" breaks other inputs. Prefer relative fixes: "match the color from the source image."

**Identity Lock:** If the same issue appears unchanged across 2–3 iterations, the prompt fix isn't working. Stop iterating on that dimension and either: (a) change the framing entirely, or (b) flag for human review.

**`converged: true` ≠ user satisfied.** Users sometimes keep intermediate results mid-chain and abandon later. Convergence is a technical signal, not a subjective one.

**Score calibration:** A score of 4/5 is "good enough to ship." Scores of 5/5 are rare and shouldn't be required for convergence. Typical threshold: all dimensions >= 4.

**Judge the final output, not the diff.** Each iteration should score the absolute quality of the new image, not how much it improved relative to the previous one. Relative scoring causes the judge to reward small improvements on bad images.

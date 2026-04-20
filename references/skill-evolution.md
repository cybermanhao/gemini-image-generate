# Skill Self-Evolution — Applying LAAJ to Code & Documentation

LAAJ is not limited to image prompts. The same `generate → evaluate → feedback → refine` loop can drive the evolution of any artifact: TypeScript services, pipeline architecture, CLI workflows, and even this SKILL.md itself.

This document treats LAAJ as a **general control loop** and shows how to wire it up for skill self-improvement.

---

## The Core Insight

| LAAJ Phase | Image Pipeline | Skill/Code Pipeline |
|------------|----------------|---------------------|
| **Generate** | `generateContent({ prompt, images })` | Subagent executes a test prompt and writes code |
| **Artifact** | Base64 image | Source files + transcripts |
| **Evaluate** | Vision judge scores dimensions | Assertion checker + grader agent scores expectations |
| **Feedback** | `top_issues[].fix` | Failed assertions + human review notes |
| **Refine** | Append fixes to prompt | Edit SKILL.md, references, or bundled scripts |
| **Converged** | All scores >= 4 | All assertions pass + human signs off |

---

## Minimal Self-Evolution Workflow

### Step 1 — Fix a Test Suite

Write 2–4 eval prompts that cover the skill's core promises. For each prompt, run two configurations:

- **With skill** — subagent has the skill loaded
- **Without skill** — baseline (model's raw knowledge)

Store outputs in `workspace/iteration-N/<eval-name>/`.

### Step 2 — Automatic Grading

For each run, evaluate objectively verifiable assertions:

- File was created
- File contains expected API call
- File avoids deprecated pattern
- Output matches expected schema

Save results as `grading.json`.

### Step 3 — Aggregate & Surface Patterns

Run an aggregator to compute:

- Pass rate per configuration
- Time / token delta
- Assertions that pass in both configs (non-discriminating — remove or strengthen them)
- Assertions that only pass with skill (these are the skill's value)

### Step 4 — Human Review (Mandatory Gate)

Auto-grading catches syntax and structure, but it cannot judge:

- Whether the explanation is actually clear
- Whether the pattern generalizes beyond the test case
- Whether the subagent took an unnecessarily convoluted path

**Human review is the convergence threshold.** Empty feedback = converged. Specific complaints = `top_issues` for the next iteration.

### Step 5 — Escalation Check: Fix the Artifact, or Fix the Skill?

Not every failure means the skill is broken. Use this escalation protocol before opening `SKILL.md`:

```
Failure observed
    │
    ├── First occurrence? ──→ Fix the generated artifact / tune the test prompt
    │
    └── Repeats across 2+ runs?
            │
            ├── Subagent never reads the skill ──→ Rewrite description / frontmatter
            │
            ├── Reads it but misunderstands ──→ Clarify wording + add examples
            │
            ├── Understands but implements wrong ──→ Add complete code / bundle script
            │
            ├── Implementation correct but API errors ──→ Query official docs (see below)
            │
            ├── Runtime errors (503, 429, timeout) ──→ Add retry logic / bundle script
            │
            └── with-skill ≈ without-skill ──→ Restructure the skill
```

#### Signals to Escalate to the Skill Level

| Signal | Threshold | Fix Target |
|------|------|---------|
| **Same failure in 2+ different evals** | ≥2 times | Systemic error in a `references/*.md` |
| **Identity Lock** | Persists across 2-3 iterations | Stop text-tweaking; restructure or add a script |
| **Baseline catches up or surpasses** | with ≈ without | Skill has no incremental value; redesign |
| **Every subagent reinvents the same helper** | ≥2 independent copies | Bundle `scripts/*.ts` |
| **API error from outdated skill docs** | Any occurrence | Query docs, update references |
| **Runtime errors (503/429/timeout)** | ≥2 occurrences | Add exponential-backoff retry to bundled scripts |

> **Core principle**: Fix the artifact on a single failure; fix the skill on a repeated pattern.

### Step 6 — Mine Official Docs for API Details

When a test fails because of an API discrepancy (unexpected 400, missing field, behavior change), **do not guess the fix**. Query the source of truth:

| Source | When to use |
|--------|-------------|
| **Context7** (`@google/genai` SDK docs) | Syntax, type signatures, valid enum values, version migration |
| **Official release notes / changelogs** | Newly deprecated fields, model family behavior shifts |
| **Web search (official blog / Google AI docs)** | Undocumented edge cases, recent API rollout |
| **SDK source code** | When docs and observed behavior diverge |

**Codify the finding, don't just patch the test.** If you discover that `thinkingBudget` only exists on Gemini 2.5 while Gemini 3 uses `thinkingLevel`, write that rule into `references/models.md` with a validation snippet. This turns one-off discovery into reusable knowledge.

### Documentation-Driven Refine Mapping

| Failure Pattern | Doc Source | Fix Location |
|-----------------|------------|--------------|
| `seed` is passed but output still non-deterministic | Model architecture docs | Add warning to `SKILL.md` or `references/models.md` |
| `imageSize: '512'` causes 400 | SDK reference / changelog | Update valid sizes table in `references/models.md` |
| `thoughtSignature` absent on some responses | SDK source / release notes | Document fallback condition in `references/multiturn.md` |
| File API TTL changed from 48h to 72h | Official docs | Update cache logic in `references/file-api-cache.md` |

## Step 6 — Refine the Skill

Translate feedback + doc findings into edits:

| Complaint | Fix Location |
|-----------|--------------|
| "Missing File API fallback" | Add explicit fallback snippet to `file-api-cache.md` |
| "3-turn structure is confusing" | Rewrite `multiturn.md` with a clearer diagram |
| "Subagent invented its own interleaving logic" | Bundle `scripts/interleave-instruction.ts` and reference it from `SKILL.md` |
| "Forgot to omit thinkingConfig in Refine" | Add a red warning box to `references/multiturn.md` |

## Step 7 — Iterate

Copy the skill, apply edits, and rerun the full suite into `iteration-N+1/`. Compare against the previous iteration with `--previous-workspace`.

---

## A Reusable Script Template

```typescript
// evolve-skill.ts — minimal LAAJ loop for skill improvement
import * as fs from 'fs';
import * as path from 'path';

interface EvalCase {
  id: string;
  prompt: string;
  assertions: Array<{ name: string; check: (outputDir: string) => boolean }>;
}

interface IterationResult {
  evalId: string;
  configuration: 'with_skill' | 'without_skill';
  passed: number;
  total: number;
  outputDir: string;
}

async function runEval(evalCase: EvalCase, skillPath: string | null): Promise<IterationResult[]> {
  // Spawn subagent (pseudo-code)
  // const outputDir = await spawnSubagent({ prompt: evalCase.prompt, skillPath });
  const outputDir = '/tmp/placeholder';

  const passed = evalCase.assertions.filter(a => a.check(outputDir)).length;
  const config = skillPath ? 'with_skill' : 'without_skill';

  return [{
    evalId: evalCase.id,
    configuration: config,
    passed,
    total: evalCase.assertions.length,
    outputDir,
  }];
}

async function runEvolutionLoop(
  evals: EvalCase[],
  skillPath: string,
  maxIterations = 3,
): Promise<void> {
  for (let i = 0; i < maxIterations; i++) {
    console.log(`\n=== Iteration ${i} ===`);

    const results: IterationResult[] = [];
    for (const ev of evals) {
      results.push(...await runEval(ev, null));      // baseline
      results.push(...await runEval(ev, skillPath)); // with skill
    }

    const withSkillRate = averagePassRate(results, 'with_skill');
    const withoutSkillRate = averagePassRate(results, 'without_skill');

    console.log(`With skill:    ${withSkillRate.toFixed(2)}`);
    console.log(`Without skill: ${withoutSkillRate.toFixed(2)}`);

    if (withSkillRate === 1.0) {
      console.log('All assertions passed. Awaiting human review...');
      break;
    }

    // In a fully automated setup, you would call a judge model here to propose
    // SKILL.md edits based on the failed assertions. In practice, human review
    // produces better generalizations.
    console.log('Review failures, edit the skill, and rerun.');
  }
}

function averagePassRate(results: IterationResult[], config: 'with_skill' | 'without_skill'): number {
  const filtered = results.filter(r => r.configuration === config);
  if (filtered.length === 0) return 0;
  const totalPassed = filtered.reduce((sum, r) => sum + r.passed, 0);
  const totalAssertions = filtered.reduce((sum, r) => sum + r.total, 0);
  return totalPassed / totalAssertions;
}
```

---

## Safety Boundaries

1. **Never fully automate convergence.** The human review gate prevents overfitting to the test suite.
2. **Identity Lock applies to skills too.** If the same complaint appears across 2+ iterations, the structure of the skill is wrong — not the wording. Stop text-tweaking and redesign the reference hierarchy or add a bundled script.
3. **Beware non-discriminating assertions.** An assertion like "uses Gemini SDK" passes with and without the skill. It inflates numbers without measuring skill value. Baseline runs exist to catch these.
4. **Align the judge with the audience.** A "correct" output can still score low if the evaluation rubric mismatches the target domain. Example: an anime-style reference image used for a fantasy-realism prompt will score poorly on `subject_fidelity` and `instruction_following` even though the generation pipeline itself is correct. In self-evolution, this means the *judge prompt* needs domain-specific tuning — not the generation skill.

---

## Field Notes: A Real Evolution Iteration

This section documents an actual self-evolution run on the `gemini-imagen-patterns` skill itself.

### Iteration 0 — Results

| Eval | With Skill | Without Skill | Delta | Discriminating Failure (baseline) |
|------|-----------|---------------|-------|-----------------------------------|
| E1 Parts Array | 100% | 88% | +12% | Parts ordering wrong — subject before style ref |
| E2 Refine Loop | 100% | 88% | +12% | Missing degradation fallback when `thoughtSignature` absent |
| E3 LAAJ Eval | 100% | 78% | +22% | Flat `EvaluationResult` schema; used `GOOGLE_API_KEY` |
| **Aggregate** | **100%** | **84%** | **+16%** | |

### Lesson: Non-Discriminating Assertions Inflate Numbers

**Round 1** used only structural assertions:
- "imports `@google/genai`" — passes with and without skill
- "uses `responseModalities`" — passes with and without skill
- "references `thoughtSignature`" — passes with and without skill

Result: **100% vs 100%**. Skill appeared to have zero value.

**Round 2** added domain-specific assertions:
- Parts ordering: style reference **before** subject (not after)
- Degradation fallback: single-turn mode when `thoughtSignature` is unavailable
- Schema fidelity: nested `scores: { dimension: number }` (not flat)
- Env var convention: `GEMINI_API_KEY` (not `GOOGLE_API_KEY`)

Result: **100% vs 84%**. Skill value became measurable.

> **Rule of thumb**: If an assertion would pass on Stack Overflow code from 2024, it's non-discriminating. Good assertions encode knowledge that only appears in the skill.

### Eval Framework as Skill Infrastructure

The `eval/` directory in this repo contains the reusable framework:
- `cases/*.json` — eval prompts + assertion specs
- `grade.ts` — static assertion runner (no API calls)
- `iteration-N/` — subagent outputs (gitignored)

### Iteration 1 — Edge Case Coverage

Expanded evals to cover File API, interleaving, and abort/retry patterns.

| Eval | With Skill | Without Skill | Delta | Discriminating Failure (baseline) |
|------|-----------|---------------|-------|-----------------------------------|
| E4 File API Cache | 100% | 71% | **+29%** | No `createPartFromUri`; no TTL awareness |
| E5 [pic_N] Interleave | 100% | 100% | 0% | — (logic is intuitive; but see bug note below) |
| E6 Abort + Retry | 100% | 86% | **+14%** | `config.abortSignal` instead of `signal` param |
| **Aggregate** | **100%** | **85%** | **+15%** | |

**Bug found that assertions missed:** E5 without-skill silently skips missing `picMap` entries (drops the token entirely). With-skill preserves the token as plain text. This is a behavioral difference the current static assertions do not catch — it would require a runtime test harness.

**Lesson:** When an eval scores 100% vs 100%, dig deeper. Read the actual code. Static assertions catch structure, not semantics.

---

## Mapping to Other Artifacts

| Artifact | Generate | Evaluate | Refine |
|----------|----------|----------|--------|
| **Image prompt** | `generateContent` | Vision judge | Edit prompt text |
| **TypeScript service** | Subagent writes `.ts` | Static assertions + type check | Edit code / add scripts |
| **SKILL.md** | Subagent reads + follows instructions | Test case pass rate | Rewrite instructions / add references |
| **Web UI workflow** | Subagent builds React components | E2E or visual review | Edit component / add hooks |

---

## See Also

- `references/laaj.md` — The original image-prompt evaluation loop
- `web-ui/` — A live demo where the same generate/select/refine pattern is exposed as a UI

# Context Caching — ai.caches

`ai.caches` lets you upload large prompts (system instruction, few-shot examples, fixed contents) once and reuse them across multiple requests. Subsequent calls send only **incremental** parts, saving input tokens and time-to-first-byte.

---

## When to Use

| Scenario | Cached Content | Savings |
|----------|---------------|---------|
| LAAJ judge across multiple rounds | Judge system instruction (~500 tokens, repeated every round) | ~30–50% input tokens per round |
| Auto-refine loop | Base prompt + style context | Reused across turns |
| Fixed reference images (File API URI) | Style ref uploaded once | No re-transmission of image tokens |

---

## Minimum Cache Token Count

| Model Family | Minimum |
|-------------|---------|
| Gemini 2.5 / 2.0 | 1,024 tokens |
| Gemini 1.5 | 4,096 tokens |

A judge system instruction is typically 400–600 tokens — **not enough on its own**. Solution: bundle few-shot examples or fixed context into the cache to reach 1,024 tokens.

---

## Basic Usage

### 1. Create a Cache

```typescript
import { GoogleGenAI } from '@google/genai';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

const cache = await ai.caches.create({
  model: 'gemini-2.5-flash',
  config: {
    displayName: 'laaj-judge-v1',
    ttl: '3600s',  // 1 hour, adjust as needed
    systemInstruction: {
      parts: [{ text: JUDGE_SYSTEM_INSTRUCTION }],
    },
    // If system instruction is under 1024 tokens, append few-shot contents:
    contents: [
      { role: 'user', parts: [{ text: '/* few-shot example 1 */' }] },
      { role: 'model', parts: [{ text: '/* expected output 1 */' }] },
    ],
  },
});

const cacheName = cache.name!;  // save for reuse
```

### 2. Reference the Cache

```typescript
const response = await ai.models.generateContent({
  model: 'gemini-2.5-flash',
  contents: [{
    role: 'user',
    parts: [
      { inlineData: { data: imageBase64, mimeType: 'image/jpeg' } },
      { text: `Evaluate against: ${prompt}` },
    ],
  }],
  config: {
    cachedContent: cacheName,   // ← reference cache
    thinkingConfig: { thinkingBudget: 0 },
    abortSignal: signal,
  },
});
```

### 3. Delete the Cache (when done)

```typescript
await ai.caches.delete({ name: cacheName });
```

---

## Integration in Auto-Refine Loop

```typescript
// Create judge cache once before runAutoRefine
let judgeCache: string | undefined;
try {
  const cache = await ai.caches.create({
    model: JUDGE_MODEL,
    config: {
      displayName: `judge-session-${session.id}`,
      ttl: '1800s',
      systemInstruction: { parts: [{ text: JUDGE_SYSTEM_INSTRUCTION }] },
    },
  });
  judgeCache = cache.name ?? undefined;
} catch {
  // Cache creation failure is non-fatal; fall back to no cache
}

// Pass cache name into doJudge during the loop
judgeResult = await doJudge({
  imageBase64: currentRound.imageBase64,
  prompt: session.basePrompt ?? '',
  cachedContent: judgeCache,
  signal: sig,
});

// Clean up after loop exits (converged, error, or abort)
if (judgeCache) {
  ai.caches.delete({ name: judgeCache }).catch(() => {});
}
```

`doJudge` accepts `cachedContent?: string` and passes it to `config.cachedContent`.

---

## Cache Lifecycle Management

| Operation | Method |
|-----------|--------|
| List all caches | `ai.caches.list()` → `Pager<CachedContent>` |
| Extend TTL | `ai.caches.update({ name, config: { ttl: '7200s' } })` |
| Get by name | `ai.caches.get({ name })` |
| Delete | `ai.caches.delete({ name })` |

---

## Notes

1. **TTL does not auto-renew** — if an auto-refine loop exceeds TTL, the cache expires and requests return 404; `catch` and recreate.
2. **Cache is bound to model** — the model specified at creation must match the model at use time.
3. **Cache is scoped to API key** — valid only within the same key.
4. **Cost** — cached tokens incur storage cost (far lower than repeated inference cost).
5. **Gemini API (not Vertex) limitation** — `kmsKeyName` is unsupported; max TTL depends on quota.

---

## Current Status (Implemented)

`doJudge` is already integrated with caching. `runAutoRefine` creates a cache before the loop and deletes it on all exit paths (converged, error, abort) via `try/finally`.

- `JUDGE_SYSTEM_INSTRUCTION` includes the evaluation framework + 2 few-shot examples (~1,200 tokens, above the 1,024 minimum).
- `JudgeBody.cachedContent?: string` — when present, `config.cachedContent` is used; when absent, `config.systemInstruction` is inlined directly (fallback for manual judge path).
- `runAutoRefine`'s while loop is wrapped in `try/finally` to guarantee cache deletion on every exit path.

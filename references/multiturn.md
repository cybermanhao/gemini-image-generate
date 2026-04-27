# Multi-Turn Refine with thoughtSignature

## Overview

The 3-turn structure allows an LLM to "pick up from where it left off" on a previous generation without re-sending the full original prompt or running the generation again. The key mechanism is `thoughtSignature` — the model's internal reasoning signature for multi-turn context preservation.

> **Critical rule from [official docs](https://ai.google.dev/gemini-api/docs/image-generation?hl=zh-cn):** All responses include a `thoughtSignature` (SDK) / `thought_signature` (REST). You must pass it back **exactly as received** in the next turn. Failure to do so **may cause the request to fail**. The only exception is when a generation is blocked (safety, content filter) — in that case there is no signature and you must fall back to single-turn mode.

---

## Turn Structure

```
Turn 0 (user):  Original images + base prompt
Turn 1 (model): Previous render + thoughtSignature (injected)
Turn 2 (user):  Refinement instruction (may contain [pic_N] interleaved images)
```

```typescript
contents = [
  { role: 'user',  parts: turn0Parts },   // original context
  { role: 'model', parts: turn1Parts },   // previous output + signature
  { role: 'user',  parts: turn2Parts },   // refinement instruction
];
```

---

## Turn 0 — Original Context

Same as a standard single-turn generation: source images + optional style reference + base prompt.

```typescript
const turn0Parts: Part[] = [
  mainImagePart,          // main subject
  ...extraRefParts,       // optional additional references
  styleRefPart,           // optional style reference image
  { text: STYLE_REF_LABEL }, // optional label
  { text: basePrompt },   // prompt last
];
```

---

## Turn 1 — Previous Render + thoughtSignature

This is the critical turn. The model's previous output (image) is placed in the model role, and `thoughtSignature` is attached to it. Per [official docs](https://ai.google.dev/gemini-api/docs/image-generation?hl=zh-cn): all non-thought image parts must carry the signature; the first text part after thoughts should also carry it. Failure to pass it back may cause the request to fail.

```typescript
const prevBase64 = /* load previous render as base64 */;
const prevSig = /* retrieve from storage (see "Storage" below) */;

const turn1Parts: Part[] = [];

// Optional: model's text description from previous generation
if (prevDescription) {
  turn1Parts.push({ text: prevDescription, thoughtSignature: prevSig });
}

// The previous render image — thoughtSignature attached here too
turn1Parts.push({
  inlineData: { data: prevBase64, mimeType: 'image/jpeg' },
  thoughtSignature: prevSig,
});
```

> **REST equivalent:** use `thought_signature` (snake_case) instead of `thoughtSignature` (camelCase) in the JSON payload. The field rules are identical.

**Signature placement rules (from official docs):**
1. **All non-thought image parts** in the response must carry the signature.
2. **The first text part** after thoughts (before any non-thought image) must also carry the signature.
3. **Thought parts** (`thought: true`) do **not** have signatures — they are interim reasoning images, not part of the final output.
4. **Follow-up text parts** after the first signed text part do **not** need signatures.

Attach `thoughtSignature` to **both** the text part and the image part in Turn 1 if both are present.

---

## Turn 2 — Refinement Instruction

A natural language instruction, optionally with interleaved images using `[pic_N]` tokens (see main SKILL.md).

```typescript
// Simple case: no inline images
const turn2Parts: Part[] = [{ text: refinementInstruction }];

// With inline images
const turn2Parts = interleaveInstructionParts(refinementInstruction, picPartMap);
```

---

## Degradation: Single-Turn Fallback

If the previous render or its `thoughtSignature` is unavailable (e.g. generation blocked, or signature not stored), fall back to a single-turn call — treat the previous render as just another reference image. This fallback is required because passing an incorrect or stale signature will cause the API to reject the request.

```typescript
const hasSig = prevRenderedPath && prevThoughtSignature;

if (hasSig) {
  // True multi-turn (3-turn structure above)
  contents = [turn0, turn1, turn2];
} else {
  // Fallback: single-turn, prev render as extra reference image
  const parts: Part[] = [
    mainImagePart,
    ...extraRefParts,
    prevRenderPart,              // treated as reference, not as model output
    { text: refinementInstruction },
  ];
  contents = [{ role: 'user', parts }];
}
```

---

## Storing thoughtSignature

Store it alongside the output image, keyed by whatever identifies "this render":

```typescript
// After generation:
const { image, thoughtSignature, description } = parseResponse(response);
await saveRender({ image, thoughtSignature, description, ...metadata });
```

**Critical constraint:** Only the **most recent** render for a given (subject, view) pair should have an active `thoughtSignature`. When a new render is created, null out the previous one:

```sql
-- After inserting the new render:
UPDATE renders
SET thought_signature = NULL
WHERE subject_id = ? AND view = ? AND id != <new_id>
```

**Why:** A stale `thoughtSignature` from a superseded generation can cause the model to anchor on the wrong prior state. Only ever continue from the latest.

---

## Config for Refine Calls

Omit `thinkingConfig` in Refine calls to reduce latency. `thoughtSignature` is returned regardless.

```typescript
const config: GenerateContentConfig = {
  responseModalities: ['TEXT', 'IMAGE'],
  imageConfig: { aspectRatio: '1:1' },
  // No thinkingConfig — saves latency, signature still returned
};
```

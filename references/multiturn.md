# Multi-Turn Refine with thoughtSignature

## Overview

The 3-turn structure allows an LLM to "pick up from where it left off" on a previous generation without re-sending the full original prompt or running the generation again. The key mechanism is `thoughtSignature` — an opaque blob representing the model's internal generation state, returned alongside the output image and re-injected on the next turn.

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

This is the critical turn. The model's previous output (image) is placed in the model role, and `thoughtSignature` is attached to it. This lets the model "remember" its earlier reasoning without re-doing it.

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

**Important:** Attach `thoughtSignature` to **both** the text part and the image part if both are present. The SDK expects it on all model-turn parts that were part of the original generation.

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

If the previous render or its `thoughtSignature` is unavailable, fall back to a single-turn call — treat the previous render as just another reference image.

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

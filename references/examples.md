# Generation Examples

13 common multimodal patterns. All use `@google/genai` and `gemini-3.1-flash-image-preview` unless noted.

**Standard boilerplate (assumed in every example):**

```typescript
import { GoogleGenAI, type Part } from '@google/genai';
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

const response = await ai.models.generateContent({
  model: 'gemini-3.1-flash-image-preview',
  contents: [{ role: 'user', parts }],
  config: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: '1:1', imageSize: '1K' } },
});

const parts = response.candidates?.[0]?.content?.parts ?? [];
const img = parts.find(p => p.inlineData?.mimeType?.startsWith('image/'));
const desc = parts.find(p => p.text && !p.thought)?.text?.trim();
// img?.thoughtSignature  → store for Refine
```

---

## Table of Contents

1. [Basic Text-to-Image](#example-1-basic-text-to-image)
2. [Subject + Single Reference](#example-2-subject--single-reference)
3. [Style Reference with Guardrails](#example-3-style-reference-with-guardrails)
4. [[pic_N] Interleaving](#example-4-pic_n-interleaving)
5. [Multi-Turn Refine](#example-5-multi-turn-refine)
6. [Background Replacement](#example-6-background-replacement)
7. [Multiple References (up to 9)](#example-7-multiple-references)
8. [Pure Mode (raw prompt)](#example-8-pure-mode)
9. [File API Cache + Fallback](#example-9-file-api-cache--fallback)
10. [LAAJ-Driven Loop](#example-10-laaj-driven-loop)
11. [Pose Transfer](#example-11-pose-transfer)
12. [Aspect Ratio Control](#example-12-aspect-ratio-control)
13. [Full Pipeline](#example-13-full-pipeline)

---

## Example 1: Basic Text-to-Image

No images, just text:

```typescript
contents: 'A watercolor painting of a fox sitting in a field of lavender at golden hour'
```

## Example 2: Subject + Single Reference

Character fusion — apply visual traits from a reference while keeping subject identity:

```typescript
const parts: Part[] = [
  { inlineData: { data: subjectBase64, mimeType: 'image/png' } },
  { inlineData: { data: refBase64, mimeType: 'image/png' } },
  { text: 'A cosplay illustration where the subject wears the reference\'s signature colors and accessories.' },
];
```

## Example 3: Style Reference with Guardrails

Copy **composition, lighting, background** from a reference, but **NOT** the product/color/labels. The guardrail text immediately follows its image to anchor the constraint:

```typescript
const parts: Part[] = [
  { inlineData: { data: styleRefBase64, mimeType: 'image/jpeg' } },
  { text: `STYLE REFERENCE — COPY ONLY: COMPOSITION, LIGHTING, BACKGROUND.
NEVER COPY: SUBJECT, COLOR, LABELS, PACKAGING.
KEEP ALL characteristics of the subject in the NEXT image.
The subject's colors must match the ORIGINAL, NOT the reference.` },

  { inlineData: { data: subjectBase64, mimeType: 'image/jpeg' } },
  { text: 'Render the subject above in a professional studio shot matching the style reference composition and lighting.' },
];
```

## Example 4: [pic_N] Interleaving

When instruction text references images at specific positions. Read `references/interleaving.md` for the full `interleaveInstructionParts()` implementation.

```typescript
const instruction = 'Place [pic_1] in the background, then put [pic_2] in the foreground wearing the outfit from [pic_1].';
const picMap = new Map<number, Part>([
  [1, { inlineData: { data: backgroundBase64, mimeType: 'image/png' } }],
  [2, { inlineData: { data: characterBase64, mimeType: 'image/png' } }],
]);

const parts = interleaveInstructionParts(instruction, picMap);
// → [{ text: 'Place ' }, image1, { text: ' in the background...' }, image2, { text: '...' }]
```

### Complex E-commerce Interleaving (3+ images)

Multi-image product shots with guardrails. Images are interleaved into a long instruction so the model sees each visual reference at the exact point it is mentioned:

```typescript
const instruction = `Place the product from [pic_1] centered in the foreground on a reflective surface.
Use the mood and lighting from [pic_2] as the background environment.
Add the brand logo from [pic_3] subtly in the top-right corner.
Maintain the product's original colors and material finish.
Style: luxury product photography, soft studio lighting, 4K detail.`;

const picMap = new Map<number, Part>([
  [1, { inlineData: { data: productBase64, mimeType: 'image/png' } }],
  [2, { inlineData: { data: moodRefBase64, mimeType: 'image/png' } }],
  [3, { inlineData: { data: logoBase64, mimeType: 'image/png' } }],
]);

const parts = interleaveInstructionParts(instruction, picMap);
// → [{ text: 'Place the product from ' }, productImage, { text: ' centered...' },
//     moodImage, { text: '...logo from ' }, logoImage, { text: ' subtly...' }]
```

**Guardrails are critical in multi-image calls** — without explicit "preserve original colors / do NOT copy background colors onto the product" constraints, the model often bleeds reference colors into the subject.

---

## Example 5: Multi-Turn Refine

3-turn structure with `thoughtSignature`. Read `references/multiturn.md` for Turn 0/1/2 construction, storage, and single-turn fallback.

```typescript
const contents = [
  { role: 'user',  parts: turn0Parts },   // original images + prompt
  { role: 'model', parts: turn1Parts },   // prev render + thoughtSignature
  { role: 'user',  parts: turn2Parts },   // refinement instruction
];
```

## Example 6: Background Replacement

Keep subject exact, place in new environment:

```typescript
const parts: Part[] = [
  { inlineData: { data: newBackgroundBase64, mimeType: 'image/jpeg' } },
  { text: 'This is the TARGET background style. Copy ONLY the background, lighting, and atmosphere.' },

  { inlineData: { data: subjectBase64, mimeType: 'image/jpeg' } },
  { text: `Place the subject above into the target background style.
CRITICAL: Preserve the subject's exact shape, colors, text, and markings.
Do NOT alter, redraw, or blur any details on the subject.
Match the lighting direction of the background so the composite looks natural.` },
];
```

## Example 7: Multiple References

Up to ~9 context images before fidelity drops:

```typescript
const MAX_REFS = 9;
const parts: Part[] = [
  { inlineData: { data: subjectBase64, mimeType: 'image/jpeg' } },
  ...refBase64s.slice(0, MAX_REFS).map(r => ({ inlineData: { data: r, mimeType: 'image/jpeg' } })),
  { text: 'Render the character wearing an outfit that combines all the fabric textures and colors shown in the reference swatches.' },
];
```

## Example 8: Pure Mode

Send user's raw prompt without factory-built segments:

```typescript
const parts: Part[] = [
  { inlineData: { data: subjectBase64, mimeType: 'image/png' } },
  { text: 'Turn this into a 1980s synthwave album cover. Neon grid floor. Purple sunset. Keep the person recognizable.' },
];
```

## Example 9: File API Cache + Fallback

Upload once, reuse URI, fallback to inline on 403. Read `references/file-api-cache.md` for the cache layer and retry logic.

```typescript
const inlinePart: Part = { inlineData: { data: imageBase64, mimeType: 'image/jpeg' } };
const filePart: Part | null = fileUri
  ? { fileData: { fileUri, mimeType: 'image/jpeg' } }
  : null;

const parts: Part[] = [filePart ?? inlinePart];
parts.push({ text: prompt });

// On 403 PERMISSION_DENIED + "File" in message:
//   invalidate cache, swap parts[0] = inlinePart, retry
```

## Example 10: LAAJ-Driven Loop

Generate → judge → fix → repeat until convergence. Read `references/laaj.md` for the full `judgeImage()`, scoring schema, and iteration loop.

```typescript
// Judge call
const judgePrompt = `Evaluate this generated image against the prompt.
Score 1-5 on: subject_fidelity, lighting_quality, composition.
Output ONLY JSON: { "scores": {...}, "converged": boolean, "top_issues": [{"issue","fix"}], "next_iteration_focus": "..." }`;

const res = await ai.models.generateContent({
  model: 'gemini-2.5-flash',
  contents: [{ role: 'user', parts: [{ inlineData: { data: imageBase64, mimeType: 'image/png' } }, { text: judgePrompt }] }],
});

// Loop
for (let i = 0; i < maxIterations; i++) {
  const image = await generate(prompt);
  const judgment = await judgeImage(image, prompt);
  if (converged(judgment)) break;
  prompt += `\nAdditional requirements: ${judgment.top_issues.map(x => x.fix).join('. ')}`;
}
```

## Example 11: Pose Transfer

Keep character appearance, redraw in new pose:

```typescript
const parts: Part[] = [
  { inlineData: { data: poseRefBase64, mimeType: 'image/png' } },
  { text: 'This is the TARGET POSE. Copy ONLY the pose, body angle, and limb positions.' },

  { inlineData: { data: characterBase64, mimeType: 'image/png' } },
  { text: 'This is the CHARACTER. Preserve their exact appearance: face, hair, outfit colors, and accessories.' },

  { text: `Redraw the character in the target pose.
MATCH the pose exactly. KEEP the character's original design.
Do NOT merge the pose reference's clothing or colors into the character.` },
];
```

## Example 12: Aspect Ratio Control

Prevent distortion by telling the model how to fill non-square canvases:

```typescript
function canvasPrompt(ratio: string, fillPct: number): string {
  const [w, h] = ratio.split(':').map(Number);
  const r = w / h;
  if (r > 1.15) return `Canvas: ${ratio} (wider). Fill ${fillPct}% of WIDTH. Allow natural whitespace above/below — do NOT stretch vertically.`;
  if (r < 0.87) return `Canvas: ${ratio} (taller). Fill ${fillPct}% of HEIGHT. Allow natural whitespace left/right — do NOT force perspective.`;
  return `Canvas: ${ratio} (square). Subject fills ${fillPct}% of frame, centered symmetrically.`;
}

const parts: Part[] = [
  { inlineData: { data: subjectBase64, mimeType: 'image/jpeg' } },
  { text: canvasPrompt('3:4', 72) + '\n\nRender as a clean product shot on pure white.' },
];
```

## Example 13: Full Pipeline

Capstone: File API cache + multi-reference + `[pic_N]` interleaving + multi-turn Refine + LAAJ in one workflow. This combines patterns from Examples 3, 4, 5, 9, 10. See individual reference files for each subsystem's full implementation.

```typescript
// 1) File API cache (see file-api-cache.md)
const cache = new Map<string, string>();
const [charUri, styleUri, poseUri] = await Promise.all([
  getCachedUri(characterBase64, cache),
  getCachedUri(styleBase64, cache),
  getCachedUri(poseBase64, cache),
]);

// 2) Turn 0 — parts ordering (style → guardrail → pose → guardrail → subject → prompt)
const turn0Parts: Part[] = [
  { fileData: { fileUri: styleUri!, mimeType: 'image/png' } },
  { text: 'STYLE REF — COPY ONLY: art style, color palette, rendering technique. NEVER COPY: subject, clothing, pose.' },
  { fileData: { fileUri: poseUri!, mimeType: 'image/png' } },
  { text: 'POSE REF — COPY ONLY: body angle, limb positions, posture.' },
  { fileData: { fileUri: charUri!, mimeType: 'image/png' } },
  { text: 'Render the character above in the target art style and pose. Canvas: 3:4 portrait. Subject fills 75% of canvas height.' },
];

// 3) Generate base
const base = await generateContent(turn0Parts);

// 4) Refine Turn 1 — add accessory via [pic_1] interleaving (see interleaving.md)
const turn1 = await refineImage(
  turn0Parts, base.base64, base.signature!, base.description,
  'Add the magical accessory from [pic_1] to the character\'s hand.',
  new Map([[1, { inlineData: { data: accessoryBase64, mimeType: 'image/png' } }]]),
);

// 5) Refine Turn 2 — atmosphere
const turn2 = await refineImage(turn0Parts, turn1.base64, turn1.signature!, undefined,
  'Make the background a starry night sky and add soft rim lighting.'
);

// 6) LAAJ evaluation (see laaj.md)
const judgment = await judgeImage(turn2.base64, /* prompt */ '...');
```

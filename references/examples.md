# Generation Examples

Complete, runnable examples for common multimodal image generation patterns.
All examples use `@google/genai` and `gemini-3.1-flash-image-preview` unless noted.

---

## Example 1: Basic Text-to-Image

The simplest case — no images, just a text prompt.

```typescript
import { GoogleGenAI } from '@google/genai';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

async function generateFromText(prompt: string) {
  const response = await ai.models.generateContent({
    model: 'gemini-3.1-flash-image-preview',
    contents: prompt,
    config: {
      responseModalities: ['TEXT', 'IMAGE'],
      imageConfig: { aspectRatio: '1:1', imageSize: '1K' },
    },
  });

  const parts = response.candidates?.[0]?.content?.parts ?? [];
  const img = parts.find(p => p.inlineData?.mimeType?.startsWith('image/'));
  if (img?.inlineData?.data) {
    return Buffer.from(img.inlineData.data, 'base64');
  }
  throw new Error('No image returned');
}

// Usage
const imageBuffer = await generateFromText(
  'A watercolor painting of a fox sitting in a field of lavender at golden hour'
);
```

---

## Example 2: Subject + Single Reference (Character Fusion)

Send a subject image plus a style/target reference image. The model applies visual characteristics from the reference while keeping the subject identity.

```typescript
import { GoogleGenAI, type Part } from '@google/genai';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

async function fuseCharacter(
  subjectBase64: string,
  refBase64: string,
  prompt: string,
) {
  const parts: Part[] = [
    { inlineData: { data: subjectBase64, mimeType: 'image/png' } },
    { inlineData: { data: refBase64, mimeType: 'image/png' } },
    { text: prompt },
  ];

  const response = await ai.models.generateContent({
    model: 'gemini-3.1-flash-image-preview',
    contents: [{ role: 'user', parts }],
    config: {
      responseModalities: ['TEXT', 'IMAGE'],
      imageConfig: { aspectRatio: '1:1', imageSize: '1K' },
    },
  });

  const img = response.candidates?.[0]?.content?.parts
    ?.find(p => p.inlineData?.mimeType?.startsWith('image/'));
  return img?.inlineData?.data;
}

// Usage
const result = await fuseCharacter(
  pikachuBase64,
  gardevoirBase64,
  'A cosplay illustration where Pikachu wears the target Pokemon\'s signature colors and accessories, while clearly remaining Pikachu.'
);
```

---

## Example 3: Style Reference with Strict Guardrails

When you want the model to copy **composition, lighting, and background** from a reference, but **NOT** the product, color, or labels. Common in product photography and controlled art pipelines.

```typescript
const parts: Part[] = [];

// 1) Style reference comes FIRST
parts.push({ inlineData: { data: styleRefBase64, mimeType: 'image/jpeg' } });

// 2) IMMEDIATELY follow with strong negative constraints
parts.push({
  text: `STYLE REFERENCE — COPY ONLY: COMPOSITION, LIGHTING, BACKGROUND.
NEVER COPY: SUBJECT, COLOR, LABELS, PACKAGING.
Rules:
- KEEP ALL characteristics of the subject in the NEXT image
- ONLY COPY from this reference: composition, lighting, background style, camera angle
- The subject's colors must match the ORIGINAL, NOT the reference`
});

// 3) Main subject
parts.push({ inlineData: { data: subjectBase64, mimeType: 'image/jpeg' } });

// 4) Final instruction
parts.push({
  text: 'Render the subject above in a professional studio shot matching the style reference composition and lighting.'
});

const response = await ai.models.generateContent({
  model: 'gemini-3.1-flash-image-preview',
  contents: [{ role: 'user', parts }],
  config: {
    responseModalities: ['TEXT', 'IMAGE'],
    imageConfig: { aspectRatio: '3:4', imageSize: '2K' },
  },
});
```

**Why this order matters:** The style reference image is followed instantly by a text block that "locks" what should and should not be copied. This prevents the model from blending the reference product into the main subject.

---

## Example 4: [pic_N] Text-Image-Text Interleaving

When your instruction needs to refer to multiple images at specific positions in a sentence.

```typescript
function interleaveInstructionParts(
  instruction: string,
  picMap: Map<number, Part>,
): Part[] {
  const parts: Part[] = [];
  const regex = /\[pic_(\d+)\]/g;
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(instruction)) !== null) {
    const index = match.index;
    const picIndex = parseInt(match[1], 10);
    const picPart = picMap.get(picIndex);

    if (index > lastIndex) {
      parts.push({ text: instruction.slice(lastIndex, index) });
    }
    if (picPart) {
      parts.push(picPart);
    }
    lastIndex = index + match[0].length;
  }

  if (lastIndex < instruction.length) {
    parts.push({ text: instruction.slice(lastIndex) });
  }

  return parts;
}

// Usage
const instruction = 'Place [pic_1] in the background, then put [pic_2] in the foreground wearing the outfit from [pic_1].';
const picMap = new Map<number, Part>([
  [1, { inlineData: { data: backgroundBase64, mimeType: 'image/png' } }],
  [2, { inlineData: { data: characterBase64, mimeType: 'image/png' } }],
]);

const interleaved = interleaveInstructionParts(instruction, picMap);
// Result parts:
// [{ text: 'Place ' }, { image1 }, { text: ' in the background, then put ' }, { image2 }, { text: ' in the foreground wearing the outfit from ' }, { image1 }, { text: '.' }]
```

---

## Example 5: Multi-Turn Refine Chain (3-Turn)

Build a conversation where each generation "remembers" the previous one via `thoughtSignature`.

```typescript
import { GoogleGenAI, type Part } from '@google/genai';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

// Turn 0: generate base image
async function turn0Generate(subject: string, refs: string[], prompt: string) {
  const parts: Part[] = [
    { inlineData: { data: subject, mimeType: 'image/png' } },
    ...refs.map(r => ({ inlineData: { data: r, mimeType: 'image/png' } })),
    { text: prompt },
  ];

  const res = await ai.models.generateContent({
    model: 'gemini-3.1-flash-image-preview',
    contents: [{ role: 'user', parts }],
    config: { responseModalities: ['TEXT', 'IMAGE'] },
  });

  const img = res.candidates?.[0]?.content?.parts
    ?.find(p => p.inlineData?.mimeType?.startsWith('image/'));
  return {
    base64: img?.inlineData?.data!,
    signature: img?.thoughtSignature,
    description: res.candidates?.[0]?.content?.parts
      ?.find(p => p.text && !p.thought)?.text,
  };
}

// Turn 1 & 2: refine with thoughtSignature
async function refine(
  turn0Parts: Part[],
  prevBase64: string,
  prevSig: string,
  prevDesc: string | undefined,
  instruction: string,
) {
  const modelParts: Part[] = [];
  if (prevDesc) {
    modelParts.push({ text: prevDesc, thoughtSignature: prevSig });
  }
  modelParts.push({
    inlineData: { data: prevBase64, mimeType: 'image/png' },
    thoughtSignature: prevSig,
  });

  const contents = [
    { role: 'user',  parts: turn0Parts },
    { role: 'model', parts: modelParts },
    { role: 'user',  parts: [{ text: instruction }] },
  ];

  const res = await ai.models.generateContent({
    model: 'gemini-3.1-flash-image-preview',
    contents,
    config: { responseModalities: ['TEXT', 'IMAGE'] },
  });

  const img = res.candidates?.[0]?.content?.parts
    ?.find(p => p.inlineData?.mimeType?.startsWith('image/'));
  return {
    base64: img?.inlineData?.data!,
    signature: img?.thoughtSignature,
  };
}

// Full chain
const turn0 = await turn0Generate(
  pikachuBase64,
  [gardevoirBase64],
  'A cosplay illustration where Pikachu wears the target Pokemon\'s signature colors.'
);

const turn1 = await refine(
  /* turn0Parts */ [
    { inlineData: { data: pikachuBase64, mimeType: 'image/png' } },
    { inlineData: { data: gardevoirBase64, mimeType: 'image/png' } },
    { text: 'A cosplay illustration where Pikachu wears the target Pokemon\'s signature colors.' },
  ],
  turn0.base64,
  turn0.signature!,
  turn0.description,
  'Make the costume more elegant and flowing, like a ballroom dress.'
);

const turn2 = await refine(
  /* turn0Parts */ [
    { inlineData: { data: pikachuBase64, mimeType: 'image/png' } },
    { inlineData: { data: gardevoirBase64, mimeType: 'image/png' } },
    { text: 'A cosplay illustration where Pikachu wears the target Pokemon\'s signature colors.' },
  ],
  turn1.base64,
  turn1.signature!,
  undefined, // description optional on subsequent turns if you didn't store it
  'Add glowing magical sparkles around the character and make the background dreamy pastel.'
);
```

---

## Example 6: Background Replacement (Subject Preservation)

A common task: keep the subject exactly as-is, but place it in a new environment.

```typescript
const parts: Part[] = [
  // New background style
  { inlineData: { data: newBackgroundBase64, mimeType: 'image/jpeg' } },
  { text: 'This is the TARGET background style. Copy ONLY the background, lighting, and atmosphere.' },

  // Subject to preserve
  { inlineData: { data: subjectBase64, mimeType: 'image/jpeg' } },
  {
    text: `Place the subject above into the target background style.
CRITICAL: Preserve the subject's exact shape, colors, text, and markings.
Do NOT alter, redraw, or blur any details on the subject.
Match the lighting direction of the background so the composite looks natural.`
  },
];

const response = await ai.models.generateContent({
  model: 'gemini-3.1-flash-image-preview',
  contents: [{ role: 'user', parts }],
  config: {
    responseModalities: ['TEXT', 'IMAGE'],
    imageConfig: { aspectRatio: '1:1', imageSize: '2K' },
  },
});
```

---

## Example 7: Multiple Reference Images (Up to 9)

Gemini Flash has an object fidelity cap around 9–10 context images (plus the main subject). This example shows how to pack them efficiently.

```typescript
async function generateWithManyRefs(
  subjectBase64: string,
  refBase64s: string[],
  prompt: string,
) {
  const MAX_REFS = 9;
  const cappedRefs = refBase64s.slice(0, MAX_REFS);

  const parts: Part[] = [
    { inlineData: { data: subjectBase64, mimeType: 'image/jpeg' } },
    ...cappedRefs.map(r => ({ inlineData: { data: r, mimeType: 'image/jpeg' } })),
    { text: prompt },
  ];

  const response = await ai.models.generateContent({
    model: 'gemini-3.1-flash-image-preview',
    contents: [{ role: 'user', parts }],
    config: {
      responseModalities: ['TEXT', 'IMAGE'],
      imageConfig: { aspectRatio: '1:1', imageSize: '1K' },
    },
  });

  const img = response.candidates?.[0]?.content?.parts
    ?.find(p => p.inlineData?.mimeType?.startsWith('image/'));
  return img?.inlineData?.data;
}

// Usage: costume design with 6 fabric swatches
const result = await generateWithManyRefs(
  characterSketchBase64,
  [swatch1, swatch2, swatch3, swatch4, swatch5, swatch6],
  'Render the character wearing an outfit that combines all the fabric textures and colors shown in the reference swatches.'
);
```

---

## Example 8: Pure Mode (Bypass All Prompt Engineering)

Sometimes you want to send the user's raw prompt directly to the model without any factory-built prompt segments.

```typescript
async function generateRaw(
  subjectBase64: string,
  rawPrompt: string,
) {
  const parts: Part[] = [
    { inlineData: { data: subjectBase64, mimeType: 'image/png' } },
    { text: rawPrompt },
  ];

  const response = await ai.models.generateContent({
    model: 'gemini-3.1-flash-image-preview',
    contents: [{ role: 'user', parts }],
    config: {
      responseModalities: ['TEXT', 'IMAGE'],
      imageConfig: { aspectRatio: '1:1', imageSize: '1K' },
    },
  });

  const img = response.candidates?.[0]?.content?.parts
    ?.find(p => p.inlineData?.mimeType?.startsWith('image/'));
  return img?.inlineData?.data;
}

// Usage: the user wrote exactly what they want
const result = await generateRaw(
  photoBase64,
  'Turn this into a 1980s synthwave album cover. Neon grid floor. Purple sunset. Keep the person recognizable.'
);
```

---

## Example 9: File API Cache + Inline Fallback

Upload a large image once, reuse the File API URI, and fall back to inline base64 if the URI goes stale.

```typescript
import { GoogleGenAI, type Part } from '@google/genai';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

async function uploadOnce(imageBase64: string): Promise<string> {
  const buffer = Buffer.from(imageBase64, 'base64');
  const blob = new Blob([buffer], { type: 'image/jpeg' });
  const uploaded = await ai.files.upload({ file: blob, config: { mimeType: 'image/jpeg' } });
  return uploaded.uri!;
}

async function generateWithCachedUri(
  imageBase64: string,
  fileUri: string | null,
  prompt: string,
) {
  const inlinePart: Part = { inlineData: { data: imageBase64, mimeType: 'image/jpeg' } };
  const filePart: Part | null = fileUri
    ? { fileData: { fileUri, mimeType: 'image/jpeg' } }
    : null;

  const parts: Part[] = [filePart ?? inlinePart];
  const mainPartIdx = 0;
  parts.push({ text: prompt });

  try {
    const res = await ai.models.generateContent({
      model: 'gemini-3.1-flash-image-preview',
      contents: [{ role: 'user', parts }],
      config: { responseModalities: ['TEXT', 'IMAGE'] },
    });
    return { data: res, usedFileApi: !!filePart };
  } catch (err: any) {
    const code = err?.error?.code ?? err?.status;
    const msg = String(err?.error?.message ?? err?.message ?? '');
    const isStaleFile = (code === 403 || code === 'PERMISSION_DENIED') && msg.includes('File');

    if (filePart && isStaleFile) {
      // Retry with inline data
      parts[mainPartIdx] = inlinePart;
      const res = await ai.models.generateContent({
        model: 'gemini-3.1-flash-image-preview',
        contents: [{ role: 'user', parts }],
        config: { responseModalities: ['TEXT', 'IMAGE'] },
      });
      return { data: res, usedFileApi: false, fallback: true };
    }
    throw err;
  }
}

// Usage
let uri = await db.getCachedUri(productId); // your cache layer
if (!uri) {
  uri = await uploadOnce(productImageBase64);
  await db.setCachedUri(productId, uri);
}

const result = await generateWithCachedUri(productImageBase64, uri, prompt);
```

---

## Example 10: LAAJ-Driven Iterative Improvement

A complete end-to-end loop: generate → judge → fix → repeat until convergence.

```typescript
import { GoogleGenAI } from '@google/genai';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

interface JudgeOutput {
  scores: Record<string, { score: number; notes: string }>;
  converged: boolean;
  top_issues: Array<{ issue: string; fix: string }>;
  next_iteration_focus: string;
}

async function judgeImage(
  imageBase64: string,
  prompt: string,
): Promise<JudgeOutput> {
  const judgePrompt = `Evaluate this generated image against the prompt.
Prompt: ${prompt}
Score from 1-5 on: subject_fidelity, lighting_quality, composition.
Output ONLY JSON like:
{
  "scores": { "subject_fidelity": { "score": 4, "notes": "..." }, ... },
  "converged": false,
  "top_issues": [{ "issue": "...", "fix": "..." }],
  "next_iteration_focus": "..."
}`;

  const res = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: [{
      role: 'user',
      parts: [
        { inlineData: { data: imageBase64, mimeType: 'image/png' } },
        { text: judgePrompt },
      ],
    }],
  });

  const text = (res.text || '').trim();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON from judge');
  return JSON.parse(jsonMatch[0]);
}

async function improveLoop(
  generateFn: (prompt: string) => Promise<string>,
  initialPrompt: string,
  maxIterations = 3,
) {
  let prompt = initialPrompt;

  for (let i = 0; i < maxIterations; i++) {
    console.log(`\n=== Iteration ${i + 1} ===`);
    const imageBase64 = await generateFn(prompt);

    const judgment = await judgeImage(imageBase64, prompt);
    console.log('Scores:', Object.fromEntries(
      Object.entries(judgment.scores).map(([k, v]) => [k, v.score])
    ));

    const allScores = Object.values(judgment.scores).map(s => s.score);
    const meetsThreshold = allScores.every(s => s >= 4);
    if (meetsThreshold && judgment.converged) {
      console.log('Converged!');
      return { imageBase64, prompt, iteration: i };
    }

    const fixes = judgment.top_issues.map(x => x.fix).join('. ');
    prompt = `${prompt}\n\nAdditional requirements: ${fixes}`;
  }

  return { prompt, iteration: maxIterations - 1 };
}

// Usage
const final = await improveLoop(
  async (prompt) => {
    // your generation call here
    return await myGenerateFunction(prompt);
  },
  'A cinematic photo of a leather messenger bag on a wooden desk, soft window light from the left.'
);
```

---

## Example 11: Pose Transfer (Character + Pose Reference)

Keep a character's appearance but redraw them in a new pose from a reference image.

```typescript
const parts: Part[] = [
  // Pose reference
  { inlineData: { data: poseRefBase64, mimeType: 'image/png' } },
  { text: 'This is the TARGET POSE. Copy ONLY the pose, body angle, and limb positions.' },

  // Character reference
  { inlineData: { data: characterBase64, mimeType: 'image/png' } },
  { text: 'This is the CHARACTER. Preserve their exact appearance: face, hair, outfit colors, and accessories.' },

  // Final instruction
  {
    text: `Redraw the character in the target pose.
Rules:
- MATCH the pose exactly (same angle, limb positions, posture)
- KEEP the character's original design, colors, and facial features
- Do NOT merge the pose reference's clothing or colors into the character`
  },
];

const response = await ai.models.generateContent({
  model: 'gemini-3.1-flash-image-preview',
  contents: [{ role: 'user', parts }],
  config: { responseModalities: ['TEXT', 'IMAGE'] },
});
```

---

## Example 12: Aspect Ratio Control

Different canvases need different framing instructions to prevent the model from distorting the subject.

```typescript
function canvasPrompt(aspectRatio: string, displayRangePct: number): string {
  const [w, h] = aspectRatio.split(':').map(Number);
  const ratio = w / h;

  if (ratio > 1.15) {
    return `Canvas: ${aspectRatio} (wider than tall).
Fill ${displayRangePct}% of the canvas WIDTH with the subject.
Allow natural whitespace above and below — do NOT stretch or tilt the subject to fill vertical space.`;
  } else if (ratio < 0.87) {
    return `Canvas: ${aspectRatio} (taller than wide).
Fill ${displayRangePct}% of the canvas HEIGHT with the subject.
Allow natural whitespace on left and right — do NOT add forced perspective to fill horizontal space.`;
  } else {
    return `Canvas: ${aspectRatio} (square).
Subject fills ${displayRangePct}% of the frame, centered symmetrically.
Maintain equal whitespace on all four sides.`;
  }
}

const parts: Part[] = [
  { inlineData: { data: subjectBase64, mimeType: 'image/jpeg' } },
  { text: canvasPrompt('3:4', 72) + '\n\nRender as a clean product shot on pure white.' },
];

const response = await ai.models.generateContent({
  model: 'gemini-3.1-flash-image-preview',
  contents: [{ role: 'user', parts }],
  config: {
    responseModalities: ['TEXT', 'IMAGE'],
    imageConfig: { aspectRatio: '3:4', imageSize: '2K' },
  },
});
```

---

## Example 13: Full Pipeline — Character Design Studio

A **capstone example** that combines File API caching, multi-reference generation, `[pic_N]` interleaving, multi-turn Refine with `thoughtSignature`, and LAAJ evaluation in one end-to-end workflow.

**Scenario:** You run a character design pipeline. Users upload:
- A character sketch
- A style reference (anime, watercolor, etc.)
- A pose reference

The system generates a base illustration, refines it twice with user feedback, and runs LAAJ to verify quality before returning the final asset.

```typescript
import { GoogleGenAI, type Part } from '@google/genai';
import * as fs from 'fs';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

// ─── File API Cache Layer ───────────────────────────────────────────────────

async function uploadOnce(imageBase64: string): Promise<string> {
  const buffer = Buffer.from(imageBase64, 'base64');
  const blob = new Blob([buffer], { type: 'image/png' });
  const uploaded = await ai.files.upload({ file: blob, config: { mimeType: 'image/png' } });
  return uploaded.uri!;
}

async function getCachedUri(imageBase64: string, cache: Map<string, string>): Promise<string | null> {
  const hash = Buffer.from(imageBase64.slice(0, 200)).toString('base64'); // simple fingerprint
  if (cache.has(hash)) return cache.get(hash)!;
  const uri = await uploadOnce(imageBase64);
  cache.set(hash, uri);
  return uri;
}

// ─── [pic_N] Interleaving ───────────────────────────────────────────────────

function interleaveInstructionParts(instruction: string, picMap: Map<number, Part>): Part[] {
  const parts: Part[] = [];
  const regex = /\[pic_(\d+)\]/g;
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(instruction)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ text: instruction.slice(lastIndex, match.index) });
    }
    const picPart = picMap.get(parseInt(match[1], 10));
    if (picPart) parts.push(picPart);
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < instruction.length) {
    parts.push({ text: instruction.slice(lastIndex) });
  }
  return parts;
}

// ─── Generation ─────────────────────────────────────────────────────────────

async function generateBase(
  characterBase64: string,
  styleBase64: string,
  poseBase64: string,
  cache: Map<string, string>,
) {
  const [charUri, styleUri, poseUri] = await Promise.all([
    getCachedUri(characterBase64, cache),
    getCachedUri(styleBase64, cache),
    getCachedUri(poseBase64, cache),
  ]);

  const parts: Part[] = [
    // Style reference first + guardrails
    { fileData: { fileUri: styleUri!, mimeType: 'image/png' } },
    { text: 'STYLE REFERENCE — COPY ONLY: art style, color palette, rendering technique. NEVER COPY: subject, clothing, pose.' },

    // Pose reference
    { fileData: { fileUri: poseUri!, mimeType: 'image/png' } },
    { text: 'POSE REFERENCE — COPY ONLY: body angle, limb positions, posture.' },

    // Main subject
    { fileData: { fileUri: charUri!, mimeType: 'image/png' } },
    {
      text: `Render the character above in the target art style and pose.
Rules:
- KEEP the character's original design, face, hair, and outfit colors
- MATCH the pose reference's body angle and limb positions
- USE the style reference's rendering technique and color mood
- Canvas: 3:4 portrait. Subject fills 75% of canvas height.`,
    },
  ];

  const res = await ai.models.generateContent({
    model: 'gemini-3.1-flash-image-preview',
    contents: [{ role: 'user', parts }],
    config: {
      responseModalities: ['TEXT', 'IMAGE'],
      imageConfig: { aspectRatio: '3:4', imageSize: '2K' },
    },
  });

  const img = res.candidates?.[0]?.content?.parts
    ?.find(p => p.inlineData?.mimeType?.startsWith('image/'));

  return {
    base64: img?.inlineData?.data!,
    signature: img?.thoughtSignature,
    description: res.candidates?.[0]?.content?.parts
      ?.find(p => p.text && !p.thought)?.text,
  };
}

// ─── Multi-Turn Refine ──────────────────────────────────────────────────────

async function refineImage(
  turn0Parts: Part[],
  prevBase64: string,
  prevSig: string,
  prevDesc: string | undefined,
  instruction: string,
  picMap: Map<number, Part>,
) {
  const modelParts: Part[] = [];
  if (prevDesc) modelParts.push({ text: prevDesc, thoughtSignature: prevSig });
  modelParts.push({
    inlineData: { data: prevBase64, mimeType: 'image/png' },
    thoughtSignature: prevSig,
  });

  const contents = [
    { role: 'user',  parts: turn0Parts },
    { role: 'model', parts: modelParts },
    { role: 'user',  parts: interleaveInstructionParts(instruction, picMap) },
  ];

  const res = await ai.models.generateContent({
    model: 'gemini-3.1-flash-image-preview',
    contents,
    config: { responseModalities: ['TEXT', 'IMAGE'] },
  });

  const img = res.candidates?.[0]?.content?.parts
    ?.find(p => p.inlineData?.mimeType?.startsWith('image/'));

  return {
    base64: img?.inlineData?.data!,
    signature: img?.thoughtSignature,
  };
}

// ─── LAAJ Evaluation ────────────────────────────────────────────────────────

interface JudgeOutput {
  scores: Record<string, { score: number; notes: string }>;
  converged: boolean;
  top_issues: Array<{ issue: string; fix: string }>;
}

async function judgeImage(imageBase64: string, prompt: string): Promise<JudgeOutput> {
  const judgePrompt = `Evaluate this generated image against the prompt.
Prompt: ${prompt}
Score 1-5 on: pose_accuracy, style_fidelity, character_preservation, composition.
Output ONLY JSON:
{
  "scores": { "pose_accuracy": { "score": 4, "notes": "..." }, ... },
  "converged": false,
  "top_issues": [{ "issue": "...", "fix": "..." }]
}`;

  const res = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: [{
      role: 'user',
      parts: [
        { inlineData: { data: imageBase64, mimeType: 'image/png' } },
        { text: judgePrompt },
      ],
    }],
  });

  const text = (res.text || '').trim();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Judge returned no JSON');
  return JSON.parse(jsonMatch[0]);
}

// ─── Full Pipeline ──────────────────────────────────────────────────────────

async function runCharacterDesignPipeline(
  characterBase64: string,
  styleBase64: string,
  poseBase64: string,
  accessoryBase64: string, // used in Turn 2 via [pic_1]
) {
  const cache = new Map<string, string>();

  // Step 1: Generate base
  console.log('Step 1: Generating base illustration...');
  const base = await generateBase(characterBase64, styleBase64, poseBase64, cache);
  fs.writeFileSync('output-turn0.png', Buffer.from(base.base64, 'base64'));

  // Build Turn 0 parts (reused for every refine)
  const [charUri, styleUri, poseUri] = await Promise.all([
    getCachedUri(characterBase64, cache),
    getCachedUri(styleBase64, cache),
    getCachedUri(poseBase64, cache),
  ]);

  const turn0Parts: Part[] = [
    { fileData: { fileUri: styleUri!, mimeType: 'image/png' } },
    { text: 'STYLE REFERENCE — COPY ONLY: art style, color palette, rendering technique.' },
    { fileData: { fileUri: poseUri!, mimeType: 'image/png' } },
    { text: 'POSE REFERENCE — COPY ONLY: body angle, limb positions, posture.' },
    { fileData: { fileUri: charUri!, mimeType: 'image/png' } },
    { text: 'Render the character above in the target art style and pose. Canvas: 3:4 portrait.' },
  ];

  // Step 2: Refine Turn 1 — add accessory from reference
  console.log('Step 2: Refining — add accessory...');
  const turn1 = await refineImage(
    turn0Parts,
    base.base64,
    base.signature!,
    base.description,
    'Add the magical accessory from [pic_1] to the character\'s hand. Match its color and glow style.',
    new Map([[1, { inlineData: { data: accessoryBase64, mimeType: 'image/png' } }]]),
  );
  fs.writeFileSync('output-turn1.png', Buffer.from(turn1.base64, 'base64'));

  // Step 3: Refine Turn 2 — atmosphere adjustment
  console.log('Step 3: Refining — adjust atmosphere...');
  const turn2 = await refineImage(
    turn0Parts,
    turn1.base64,
    turn1.signature!,
    undefined,
    'Make the background a starry night sky and add soft rim lighting from behind.',
    new Map(),
  );
  fs.writeFileSync('output-turn2.png', Buffer.from(turn2.base64, 'base64'));

  // Step 4: LAAJ evaluation
  console.log('Step 4: Running LAAJ evaluation...');
  const judgment = await judgeImage(
    turn2.base64,
    'Character illustration matching target style and pose, with magical accessory and starry night background.'
  );

  console.log('Final scores:', Object.fromEntries(
    Object.entries(judgment.scores).map(([k, v]) => [k, v.score])
  ));

  const allScores = Object.values(judgment.scores).map(s => s.score);
  const converged = allScores.every(s => s >= 4) && judgment.converged;
  console.log('Converged:', converged);

  return {
    finalImage: turn2.base64,
    judgment,
    converged,
    files: ['output-turn0.png', 'output-turn1.png', 'output-turn2.png'],
  };
}

// Usage
// const result = await runCharacterDesignPipeline(
//   characterSketchBase64,
//   animeStyleBase64,
//   actionPoseBase64,
//   glowingOrbBase64,
// );
```

**What this pipeline demonstrates:**

| Step | Patterns combined |
|------|-------------------|
| File API upload + caching | Avoid re-uploading the same sketch/style/pose on every call |
| Parts ordering | Style ref → guardrail text → pose ref → guardrail text → subject → final prompt |
| `[pic_N]` interleaving | Turn 1 instruction references the accessory image inline |
| Multi-turn Refine (3-turn) | `thoughtSignature` injected on both text and image model parts |
| LAAJ evaluation | Separate `gemini-2.5-flash` judge scores the final output against the goal |
| Aspect ratio control | 3:4 portrait with explicit fill-height framing |

**Production notes:**
- In a real app, replace the `Map<string, string>` cache with a persistent store (DB/Redis) keyed by image content hash.
- If File API returns 403, fall back to `inlineData` (see Example 9 for the full fallback pattern).
- Store `thoughtSignature` alongside each turn's output so users can resume the chain hours later.


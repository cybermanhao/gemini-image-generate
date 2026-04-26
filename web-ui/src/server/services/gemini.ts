import { ThinkingLevel } from '@google/genai';
import type { GenerateContentConfig, Part } from '@google/genai';
import { ai, GENERATION_MODEL, JUDGE_MODEL, GEMINI_TIMEOUT_MS } from '../config.js';
import type {
  GenerateResult,
  JudgeResult,
  ReverseResult,
  JudgeBody,
  PartSnapshot,
  TurnSnapshot,
} from '../types.js';
import { interleaveInstructionParts } from '../utils/helpers.js';

// ─── Timeout wrapper ──────────────────────────────────────────────────────────

export function withGeminiCall<T>(
  factory: (signal: AbortSignal) => Promise<T>,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<T> {
  const { signal: externalSignal, timeoutMs = GEMINI_TIMEOUT_MS } = options;
  const timeoutCtrl = new AbortController();
  const timer = setTimeout(() => {
    timeoutCtrl.abort(
      Object.assign(new Error(`Gemini call timed out after ${timeoutMs / 1000}s`), { code: 'ETIMEDOUT' }),
    );
  }, timeoutMs);
  const onAbort = () => timeoutCtrl.abort(externalSignal!.reason);
  externalSignal?.addEventListener('abort', onAbort, { once: true });
  return factory(timeoutCtrl.signal).finally(() => {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', onAbort);
  });
}

// ─── Judge system instruction ─────────────────────────────────────────────────

const JUDGE_SYSTEM_INSTRUCTION = `You are an expert quality evaluator for AI-generated images. Your role is to provide rigorous, actionable assessments that guide iterative refinement.

## Scoring Scale
- 5 (Excellent): Fully meets the standard; no meaningful issues
- 4 (Good): Meets standard with minor, non-distracting imperfections
- 3 (Acceptable): Partially meets standard; noticeable but tolerable issues
- 2 (Poor): Falls notably short; significant issues affecting usability
- 1 (Unacceptable): Fails to meet the standard; must be regenerated

## Common Evaluation Dimensions
- **subject_fidelity**: Accuracy of subject identity, shape, details, and visual characteristics vs. prompt
- **instruction_following**: Adherence to all explicit instructions (quantity, pose, placement, attributes)
- **composition**: Framing, balance, negative space, rule-of-thirds, visual hierarchy
- **lighting_quality**: Lighting realism, shadow accuracy, highlight handling, atmospheric consistency
- **overall_quality**: Technical execution — sharpness, artifact-free, professional standard

## Output Format
Always respond with ONLY valid JSON — no markdown, no prose, no code fences:
{
  "scores": {
    "<dimension_name>": {
      "score": <integer 1–5>,
      "notes": "<specific, actionable observation — what exactly is right or wrong>"
    }
  },
  "converged": <boolean — true ONLY when ALL dimension scores >= the stated threshold>,
  "topIssues": [
    {
      "issue": "<concise problem statement>",
      "fix": "<exact prompt language or technique to address this — be specific>"
    }
  ],
  "nextFocus": "<single highest-impact improvement direction for the next generation>"
}

## Example 1 — Product Photography

User message:
Evaluate this image. Original prompt: "A ceramic coffee mug on pure white background, professional studio lighting, product photography"
Dimensions: subject_fidelity, instruction_following, composition, lighting_quality, overall_quality
Convergence threshold: 4

Expected output:
{
  "scores": {
    "subject_fidelity": { "score": 4, "notes": "Mug shape and ceramic glaze well rendered; handle slightly thick compared to reference" },
    "instruction_following": { "score": 3, "notes": "Background has visible light grey cast instead of pure white" },
    "composition": { "score": 5, "notes": "Centered composition with generous negative space; excellent product framing" },
    "lighting_quality": { "score": 4, "notes": "Soft diffused studio light; slight hot-spot on handle upper edge" },
    "overall_quality": { "score": 4, "notes": "Sharp, professional quality; background issue is main detractor" }
  },
  "converged": false,
  "topIssues": [
    {
      "issue": "Background is light grey instead of pure white",
      "fix": "Add to prompt: 'absolutely pure white background, #ffffff, no grey tones, no gradients, no shadows on background'"
    }
  ],
  "nextFocus": "Enforce pure white background rendering"
}

## Example 2 — Character Art

User message:
Evaluate this image. Original prompt: "Anime girl with silver hair and blue eyes, wearing a red hoodie, standing in a park at sunset"
Dimensions: subject_fidelity, instruction_following, composition, lighting_quality, overall_quality
Convergence threshold: 4

Expected output:
{
  "scores": {
    "subject_fidelity": { "score": 5, "notes": "Silver hair, blue eyes, and red hoodie all correctly rendered with anime style" },
    "instruction_following": { "score": 4, "notes": "Park and sunset present; character is slightly off-center but park is clearly identifiable" },
    "composition": { "score": 4, "notes": "Three-quarter view works well; slight crowding at bottom edge" },
    "lighting_quality": { "score": 5, "notes": "Warm golden-hour backlighting with accurate rim light on hair" },
    "overall_quality": { "score": 4, "notes": "Clean anime style, good line quality, minor composition crop issue" }
  },
  "converged": true,
  "topIssues": [
    {
      "issue": "Subject slightly off-center and tight at bottom frame edge",
      "fix": "Add to prompt: 'centered composition, full body visible, generous space around character'"
    }
  ],
  "nextFocus": "Improve character framing and centering"
}`;

// ─── Generate Image ───────────────────────────────────────────────────────────

export async function doGenerate(params: {
  imageBase64?: string;
  prompt: string;
  aspectRatio: string;
  imageSize: string;
  thinkingLevel: 'minimal' | 'high';
  extraImagesBase64?: string[];
  styleRefBase64?: string;
  signal?: AbortSignal;
}): Promise<GenerateResult> {
  const parts: Part[] = [];
  const userParts: PartSnapshot[] = [];

  if (params.styleRefBase64) {
    parts.push({ inlineData: { data: params.styleRefBase64, mimeType: 'image/jpeg' } });
    parts.push({ text: `STYLE REFERENCE — COPY ONLY: COMPOSITION, LIGHTING, BACKGROUND. NEVER COPY: SUBJECT, COLOR, LABELS, PACKAGING.` });
    userParts.push({ type: 'image', content: '(base64)', label: '风格参考', detail: 'STYLE REFERENCE' });
    userParts.push({ type: 'text', content: 'STYLE REFERENCE — COPY ONLY: COMPOSITION, LIGHTING, BACKGROUND...', label: '风格说明' });
  }

  if (params.imageBase64) {
    parts.push({ inlineData: { data: params.imageBase64, mimeType: 'image/jpeg' } });
    userParts.push({ type: 'image', content: '(base64)', label: '原图', detail: '主体图' });
  }

  const extras = (params.extraImagesBase64 ?? []).slice(0, 9);
  for (let i = 0; i < extras.length; i++) {
    parts.push({ inlineData: { data: extras[i], mimeType: 'image/jpeg' } });
    userParts.push({ type: 'image', content: '(base64)', label: `额外参考 ${i + 1}`, detail: `extra-${i}` });
  }

  parts.push({ text: params.prompt });
  userParts.push({ type: 'text', content: params.prompt, label: '生成指令', detail: 'prompt' });

  const thinkingLevelEnum = params.thinkingLevel === 'high' ? ThinkingLevel.HIGH : ThinkingLevel.MINIMAL;
  const config: GenerateContentConfig = {
    responseModalities: ['TEXT', 'IMAGE'],
    imageConfig: { aspectRatio: params.aspectRatio, imageSize: params.imageSize },
    thinkingConfig: { thinkingLevel: thinkingLevelEnum, includeThoughts: true },
    abortSignal: params.signal,
  };

  const response = await ai.models.generateContent({
    model: GENERATION_MODEL,
    contents: [{ role: 'user', parts }],
    config,
  });

  const responseParts: Part[] = response.candidates?.[0]?.content?.parts ?? [];
  const imageParts = responseParts.filter(p => p.inlineData?.mimeType?.startsWith('image/'));
  const img = imageParts.find(p => p.thoughtSignature) ?? imageParts[0];
  if (!img?.inlineData?.data) throw new Error('Model did not return an image');

  const thoughtSignature = img.thoughtSignature ?? undefined;
  const descPart = responseParts.find(p => p.text && !p.thought);
  const modelDescription = descPart?.text?.trim()
    ? (descPart.text.startsWith('RENDER:') ? descPart.text.slice(7).trim() : descPart.text.trim()).slice(0, 500)
    : undefined;

  const modelParts: PartSnapshot[] = [
    { type: 'image', content: '(base64)', label: '生成结果', detail: thoughtSignature ? `thoughtSignature: ${thoughtSignature.slice(0, 16)}...` : '无 thoughtSignature' },
  ];
  if (modelDescription) {
    modelParts.push({ type: 'text', content: modelDescription, label: '模型自描述', detail: 'RENDER' });
  }

  const contextSnapshot: TurnSnapshot[] = [
    { turn: 0, type: 'user', role: 'generate', parts: userParts, metadata: { timestamp: Date.now() } },
    { turn: 1, type: 'model', role: 'model-response', parts: modelParts, metadata: { thoughtSignature, modelDescription, timestamp: Date.now() } },
  ];

  return { imageBase64: img.inlineData.data, thoughtSignature, modelDescription, contextSnapshot };
}

// ─── Refine Image ─────────────────────────────────────────────────────────────

export async function doRefine(params: {
  baseImageBase64?: string;
  basePrompt?: string;
  prevImageBase64: string;
  prevThoughtSignature?: string;
  prevModelDescription?: string;
  instruction: string;
  newImagesBase64?: Record<number, string>;
  aspectRatio?: string;
  imageSize?: string;
  signal?: AbortSignal;
}): Promise<GenerateResult> {
  const hasSig = !!params.prevThoughtSignature;

  const turn0Parts: Part[] = [];
  const turn0Snapshots: PartSnapshot[] = [];
  if (params.baseImageBase64) {
    turn0Parts.push({ inlineData: { data: params.baseImageBase64, mimeType: 'image/jpeg' } });
    turn0Snapshots.push({ type: 'image', content: '(base64)', label: '原图', detail: 'base image' });
  }
  turn0Parts.push({ text: params.basePrompt ?? '' });
  turn0Snapshots.push({ type: 'text', content: params.basePrompt ?? '', label: '基础 Prompt', detail: 'base prompt' });

  const turn1Parts: Part[] = [];
  const turn1Snapshots: PartSnapshot[] = [];
  if (params.prevModelDescription) {
    turn1Parts.push({ text: params.prevModelDescription, thoughtSignature: params.prevThoughtSignature });
    turn1Snapshots.push({ type: 'text', content: params.prevModelDescription, label: '模型自描述', detail: 'thoughtSignature present' });
  }
  turn1Parts.push({
    inlineData: { data: params.prevImageBase64, mimeType: 'image/jpeg' },
    thoughtSignature: params.prevThoughtSignature,
  });
  turn1Snapshots.push({ type: 'image', content: '(base64)', label: '上次渲染结果', detail: hasSig ? `thoughtSignature: ${params.prevThoughtSignature!.slice(0, 16)}...` : '无 thoughtSignature' });

  let turn2Text = params.instruction;
  const picMap = new Map<number, Part>();
  const picMapSnapshots = new Map<number, PartSnapshot>();
  if (params.newImagesBase64) {
    for (const [idx, b64] of Object.entries(params.newImagesBase64)) {
      picMap.set(Number(idx), { inlineData: { data: b64, mimeType: 'image/jpeg' } });
      picMapSnapshots.set(Number(idx), { type: 'image', content: '(base64)', label: `新图 [pic_${idx}]`, detail: `user-uploaded-${idx}` });
    }
  }
  const turn2Parts = interleaveInstructionParts(turn2Text, picMap);

  const turn2Snapshots: PartSnapshot[] = [];
  const regex = /\[pic_(\d+)\]/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(turn2Text)) !== null) {
    if (match.index > lastIndex) {
      turn2Snapshots.push({ type: 'text', content: turn2Text.slice(lastIndex, match.index), label: '指令文本', detail: 'instruction' });
    }
    const picSnap = picMapSnapshots.get(parseInt(match[1], 10));
    if (picSnap) turn2Snapshots.push(picSnap);
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < turn2Text.length) {
    turn2Snapshots.push({ type: 'text', content: turn2Text.slice(lastIndex), label: '指令文本', detail: 'instruction' });
  }

  const contents = hasSig
    ? [
        { role: 'user' as const, parts: turn0Parts },
        { role: 'model' as const, parts: turn1Parts },
        { role: 'user' as const, parts: turn2Parts },
      ]
    : [
        { role: 'user' as const, parts: [...turn0Parts, { inlineData: { data: params.prevImageBase64, mimeType: 'image/jpeg' } }, ...turn2Parts] },
      ];

  const config: GenerateContentConfig = {
    responseModalities: ['TEXT', 'IMAGE'],
    imageConfig: { aspectRatio: params.aspectRatio ?? '1:1', imageSize: params.imageSize ?? '1K' },
    abortSignal: params.signal,
  };

  const response = await ai.models.generateContent({ model: GENERATION_MODEL, contents, config });
  const responseParts: Part[] = response.candidates?.[0]?.content?.parts ?? [];
  const imageParts = responseParts.filter(p => p.inlineData?.mimeType?.startsWith('image/'));
  const img = imageParts.find(p => p.thoughtSignature) ?? imageParts[0];
  if (!img?.inlineData?.data) throw new Error('Model did not return an image');

  const thoughtSignature = img.thoughtSignature ?? undefined;
  const descPart = responseParts.find(p => p.text && !p.thought);
  const modelDescription = descPart?.text?.trim()
    ? (descPart.text.startsWith('RENDER:') ? descPart.text.slice(7).trim() : descPart.text.trim()).slice(0, 500)
    : undefined;

  const modelParts: PartSnapshot[] = [
    { type: 'image', content: '(base64)', label: '精调结果', detail: thoughtSignature ? `thoughtSignature: ${thoughtSignature.slice(0, 16)}...` : '无 thoughtSignature' },
  ];
  if (modelDescription) {
    modelParts.push({ type: 'text', content: modelDescription, label: '模型自描述', detail: 'RENDER' });
  }

  const contextSnapshot: TurnSnapshot[] = [];
  if (hasSig) {
    contextSnapshot.push(
      { turn: 0, type: 'user', role: 'refine', parts: turn0Snapshots, metadata: { timestamp: Date.now() } },
      { turn: 1, type: 'model', role: 'model-response', parts: turn1Snapshots, metadata: { timestamp: Date.now() } },
      { turn: 2, type: 'user', role: 'refine', parts: turn2Snapshots, metadata: { timestamp: Date.now() } },
      { turn: 3, type: 'model', role: 'model-response', parts: modelParts, metadata: { thoughtSignature, modelDescription, timestamp: Date.now() } },
    );
  } else {
    const fallbackUserParts = [
      ...turn0Snapshots,
      { type: 'image', content: '(base64)', label: '上次渲染（降级参考）', detail: '无 thoughtSignature，作为普通参考图' } as PartSnapshot,
      ...turn2Snapshots,
    ];
    contextSnapshot.push(
      { turn: 0, type: 'user', role: 'refine', parts: fallbackUserParts, metadata: { timestamp: Date.now() } },
      { turn: 1, type: 'model', role: 'model-response', parts: modelParts, metadata: { thoughtSignature, modelDescription, timestamp: Date.now() } },
    );
  }

  return { imageBase64: img.inlineData.data, thoughtSignature, modelDescription, contextSnapshot };
}

// ─── Edit Image ───────────────────────────────────────────────────────────────

export async function doEdit(params: {
  imageBase64: string;
  prompt: string;
  signal?: AbortSignal;
}): Promise<{ imageBase64: string }> {
  const fullPrompt = `${params.prompt}\n\nEdit the provided image according to the instruction above. Preserve the overall composition and main subjects as much as possible while applying the requested change.`;
  const response = await ai.models.generateContent({
    model: GENERATION_MODEL,
    contents: [
      { role: 'user', parts: [
        { text: fullPrompt },
        { inlineData: { data: params.imageBase64, mimeType: 'image/jpeg' } },
      ]},
    ],
    config: {
      responseModalities: ['TEXT', 'IMAGE'],
      thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL, includeThoughts: true },
      abortSignal: params.signal,
    },
  });
  const responseParts: Part[] = response.candidates?.[0]?.content?.parts ?? [];
  const imageParts = responseParts.filter(p => p.inlineData?.mimeType?.startsWith('image/'));
  const img = imageParts.find(p => p.thoughtSignature) ?? imageParts[0];
  if (!img?.inlineData?.data) throw new Error('Edit did not return an image');
  return { imageBase64: img.inlineData.data };
}

// ─── Reverse Prompt ───────────────────────────────────────────────────────────

export async function doReversePrompt(
  imageBase64: string,
  mode: 'text-to-image' | 'image-to-image',
): Promise<ReverseResult> {
  if (mode === 'text-to-image') {
    const response = await ai.models.generateContent({
      model: JUDGE_MODEL,
      contents: [{
        role: 'user',
        parts: [
          { inlineData: { data: imageBase64, mimeType: 'image/jpeg' } },
          { text: `Analyze this image and write a detailed text-to-image prompt that could reproduce it.
Focus on: subject, style, lighting, composition, color palette, background, mood.
Output ONLY the prompt text, no explanations.` },
        ],
      }],
    });
    return { textPrompt: response.text ?? '' };
  }

  const response = await ai.models.generateContent({
    model: JUDGE_MODEL,
    contents: [{
      role: 'user',
      parts: [
        { inlineData: { data: imageBase64, mimeType: 'image/jpeg' } },
        { text: `Analyze this image as if it were generated by a structured image-generation pipeline.
Map its visual properties to the following prompt segments and output valid JSON:

{
  "identity": "What is the subject? What are its key visual characteristics?",
  "canvas": "Aspect ratio, framing, how much of the frame the subject fills",
  "environment": "Background style, shadow type, lighting setup",
  "view": "Camera angle, composition, perspective",
  "material": "Surface textures, material types, finish quality",
  "style": "Overall art style, color palette, rendering technique",
  "quality": "Sharpness, clarity, professional standards observed"
}

Output ONLY the JSON. No markdown, no explanations.` },
      ],
    }],
  });

  const text = (response.text ?? '').trim();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Model did not return valid JSON segments');
  try {
    const segments = JSON.parse(jsonMatch[0]) as Record<string, string>;
    return { segments };
  } catch (e: any) {
    throw new Error(`Failed to parse reverse segments JSON: ${e.message}`);
  }
}

// ─── Judge (LAAJ) ─────────────────────────────────────────────────────────────

export async function doJudge(
  params: JudgeBody,
  onProgress?: (partial: string) => void,
): Promise<JudgeResult> {
  const dimensions = params.dimensions ?? ['subject_fidelity', 'instruction_following', 'composition', 'lighting_quality', 'overall_quality'];
  const threshold = params.threshold ?? 4;

  const userText = `Evaluate this image. Original prompt: "${params.prompt}"
Dimensions: ${dimensions.join(', ')}
Convergence threshold: ${threshold}`;

  const requestParams: Parameters<typeof ai.models.generateContent>[0] = {
    model: JUDGE_MODEL,
    contents: [{
      role: 'user' as const,
      parts: [
        { inlineData: { data: params.imageBase64, mimeType: 'image/jpeg' } },
        { text: userText },
      ],
    }],
    config: {
      thinkingConfig: { thinkingBudget: 0 },
      abortSignal: params.signal,
      ...(params.cachedContent
        ? { cachedContent: params.cachedContent }
        : { systemInstruction: { parts: [{ text: JUDGE_SYSTEM_INSTRUCTION }] } }),
    },
  };

  let text: string;
  if (onProgress) {
    const stream = await ai.models.generateContentStream(requestParams);
    let accumulated = '';
    for await (const chunk of stream) {
      const delta = chunk.text ?? '';
      if (delta) {
        accumulated += delta;
        onProgress(accumulated);
      }
    }
    text = accumulated.trim();
  } else {
    const response = await ai.models.generateContent(requestParams);
    text = (response.text ?? '').trim();
  }

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Judge returned no JSON');
  let raw: any;
  try {
    raw = JSON.parse(jsonMatch[0]);
  } catch (e: any) {
    throw new Error(`Failed to parse judge JSON: ${e.message}`);
  }

  const allScores = Object.values(raw.scores as Record<string, { score: number }>).map(s => s.score);
  const converged = allScores.length > 0 && allScores.every(s => s >= threshold) && !!raw.converged;

  return {
    scores: raw.scores,
    converged,
    topIssues: raw.topIssues ?? [],
    nextFocus: raw.nextFocus ?? '',
  };
}

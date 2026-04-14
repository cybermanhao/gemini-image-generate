# Gemini Model Selection for Image Pipelines

## Recommended Pattern: Use `gemini-2.5-flash` for Evaluation

Not a hard rule, but a strong default: use a lighter vision model for LAAJ evaluation, and reserve image-generation models for actual generation.

```
Generation:  input + prompt → [gemini-3.x-flash-image-preview] → output image
Evaluation:  output image   → [gemini-2.5-flash]               → JSON scores
```

**Why this works well:**

| Reason | Detail |
|--------|--------|
| Cost | Evaluation calls are text-only output — no IMAGE quota consumed. `gemini-2.5-flash` is significantly cheaper than image-generation models per call. |
| Speed | Flash text models return in < 2s. In a LAAJ loop you call evaluation once per generation (or more), so latency compounds. |
| Volume | You might evaluate dozens of images in one session. Flash handles this without quota pressure. |
| Sufficient quality | For scoring dimensions like composition or color fidelity, `gemini-2.5-flash` vision is accurate enough. Upgrade to `gemini-2.5-pro` only when subtle differences matter. |

**When using the same model is fine:**
- Quick one-off visual check (not in a loop)
- You only have one API key and one quota pool
- The generation model supports text-only output (e.g., `gemini-2.5-flash-image` can do both)

---

## Request Parameter Quick Reference

## Generation Models (produce IMAGE output)

These models require `responseModalities: ['TEXT', 'IMAGE']` and support `imageConfig`.

| Model | Speed | Quality | Notes |
|-------|-------|---------|-------|
| `gemini-3.1-flash-image-preview` | Fast | Good | Workhorse for batch and Refine; supports `thoughtSignature` |
| `gemini-3-pro-image-preview` | Slower | Higher | High-res output; supports `imageConfig.imageSize` up to 4K |
| `gemini-2.5-flash-image` | Fast | Good | Newer alternative; simpler chat API available |

### imageConfig parameters (generation models only)

```typescript
config: {
  responseModalities: ['TEXT', 'IMAGE'],
  imageConfig: {
    aspectRatio: '1:1',   // '1:1' | '2:3' | '3:2' | '3:4' | '4:3' | '4:5' | '5:4' | '9:16' | '16:9' | '21:9'
    imageSize: '2K',      // '1K' | '2K' | '4K'  (model-dependent, Pro supports all three)
  },
}
```

⚠️ `imageSize` is only supported on models that explicitly expose this option (e.g., `gemini-3-pro-image-preview`). Using it on flash models may be ignored or cause errors.

### thinkingConfig for generation models

See main SKILL.md. Summary:
- Gemini 2.5 family: `thinkingBudget` (number)
- Gemini 3 family: `thinkingLevel` (MINIMAL / LOW / MEDIUM / HIGH)

---

## Evaluation / LAAJ Models (text output only)

These models receive an image and return structured JSON scores. They **do not need** `responseModalities` and **do not support** `imageConfig`.

| Model | Speed | Vision Quality | When to Use |
|-------|-------|----------------|-------------|
| `gemini-2.5-flash` | Fast, cheap | Good | Default LAAJ judge; batch evaluation |
| `gemini-2.5-pro` | Slower, expensive | High | High-stakes evaluation, subtle quality differences |
| Claude Sonnet (`claude-sonnet-4-5` via Anthropic SDK) | Medium | Good | Cross-model second opinion; avoid same-family bias |

### Why separate models for generation vs evaluation?

1. **Cost:** evaluation calls are cheap text-only calls; using Pro image models for scoring wastes quota
2. **Bias:** a model tends to score its own outputs generously; a different model family (e.g., Claude) provides a more independent signal
3. **Latency:** flash text models respond in < 2s; generation calls take 10–30s

### Minimal evaluation call

```typescript
const response = await ai.models.generateContent({
  model: 'gemini-2.5-flash',
  contents: [{
    role: 'user',
    parts: [
      { inlineData: { data: imageBase64, mimeType: 'image/jpeg' } },
      { text: scoringPrompt },
    ],
  }],
  // No responseModalities, no imageConfig, no thinkingConfig needed
});
const text = response.text ?? '';
```

### thinkingConfig for evaluation models

Gemini 2.5 flash: thinking is on by default. For evaluation tasks (structured JSON output), turning it off reduces latency and cost with minimal quality loss:

```typescript
config: {
  thinkingConfig: { thinkingBudget: 0 }, // off
}
```

For nuanced comparisons where you want the model to reason carefully, leave it on or set a modest budget:

```typescript
config: {
  thinkingConfig: { thinkingBudget: 512 },
}
```

---

## Pure Text-to-Image (No Reference Input)

For text-prompt-only generation (no input images), the Imagen family is an alternative:

```typescript
const response = await ai.models.generateImages({
  model: 'imagen-4.0-generate-001',
  prompt: 'A futuristic city at sunset',
  config: {
    numberOfImages: 2,
    aspectRatio: '16:9',
    includeRaiReason: true,
  },
});
// response.generatedImages[].image.imageBytes  → base64
```

**Limitation:** Imagen does not support reference images in the same call, and does not return `thoughtSignature`. Use Gemini generation models when you need multi-turn Refine or reference-image conditioning.

---

## Chat API Alternative for Multi-Turn Editing

The `ai.chats` API is a simpler alternative to manually managing the `contents` array for multi-turn:

```typescript
const chat = ai.chats.create({ model: 'gemini-2.5-flash-image' });

const response = await chat.sendMessage({
  message: [
    { inlineData: { mimeType: 'image/png', data: prevImageBase64 } },
    'Make the background darker and add a shadow',
  ],
});
```

**Trade-off:** The chat API is simpler but you lose explicit control over `thoughtSignature` injection. Use manual `contents` array construction (see `references/multiturn.md`) when you need the full Refine pattern.

---

## Parameter Validation

Common mistakes caught early save an API round-trip.

```typescript
const VALID_ASPECT_RATIOS = new Set([
  '1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9',
]);
const VALID_IMAGE_SIZES = new Set(['1K', '2K', '4K']);
// Note: '512' and '0.5K' are NOT valid in current SDK — use '1K' as minimum
const VALID_THINKING_LEVELS = new Set(['MINIMAL', 'LOW', 'MEDIUM', 'HIGH']);

function validateGenerationParams(params: {
  aspectRatio?: string;
  imageSize?: string;
  thinkingLevel?: string;
  thinkingBudget?: number;
}) {
  if (params.aspectRatio && !VALID_ASPECT_RATIOS.has(params.aspectRatio)) {
    throw new Error(`Invalid aspectRatio "${params.aspectRatio}". Valid: ${[...VALID_ASPECT_RATIOS].join(', ')}`);
  }
  if (params.imageSize && !VALID_IMAGE_SIZES.has(params.imageSize)) {
    throw new Error(`Invalid imageSize "${params.imageSize}". Valid: 1K | 2K | 4K`);
  }
  if (params.thinkingLevel && !VALID_THINKING_LEVELS.has(params.thinkingLevel)) {
    throw new Error(`Invalid thinkingLevel "${params.thinkingLevel}". Valid: MINIMAL | LOW | MEDIUM | HIGH`);
  }
  if (params.thinkingBudget !== undefined && params.thinkingBudget < -1) {
    throw new Error(`thinkingBudget must be -1 (auto), 0 (off), or a positive integer`);
  }
}
```

**Common mistakes:**
- `imageSize: '512'` or `'0.5K'` → use `'1K'` (minimum valid value)
- `thinkingLevel` on a Gemini 2.5 model → use `thinkingBudget` instead
- `thinkingBudget` on a Gemini 3 model → use `thinkingLevel` instead  
- `aspectRatio: '16/9'` (slash) → must be colon `'16:9'`

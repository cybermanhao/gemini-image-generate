# Advanced API — editImage / countTokens / upscaleImage / personGeneration

SDK APIs related to image generation that are not currently used in the main pipeline.

---

## editImage() — Local Editing / Inpainting

`ai.models.editImage()` uses Imagen 3's dedicated editing capabilities via mask for precise range control. Unlike `generateContent()` refinement (semantic-level), `editImage()` is **pixel-level**.

### Available Edit Modes

| Mode | Description |
|------|-------------|
| `EDIT_MODE_DEFAULT` | General edit, model decides |
| `EDIT_MODE_INPAINT_INSERTION` | Insert new content inside mask region |
| `EDIT_MODE_INPAINT_REMOVAL` | Remove content inside mask region and fill background |
| `EDIT_MODE_OUTPAINT` | Extend canvas outward |
| `EDIT_MODE_BGSWAP` | Replace background, preserve subject |
| `EDIT_MODE_PRODUCT_IMAGE` | Place product into scene |
| `EDIT_MODE_STYLE` | Style transfer |
| `EDIT_MODE_CONTROLLED_EDITING` | Structured control editing (requires ControlReferenceImage) |

### Usage

```typescript
import { GoogleGenAI, EditMode, MaskReferenceImage, RawReferenceImage } from '@google/genai';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

// SDK v1.50.1+ breaking change: RawReferenceImage/MaskReferenceImage constructors
// no longer accept arguments. Use Object.assign() instead.
const rawRef = Object.assign(new RawReferenceImage(), {
  referenceImage: { imageBytes: imageBase64, mimeType: 'image/jpeg' },
  referenceId: 1,
});

const maskRef = Object.assign(new MaskReferenceImage(), {
  referenceId: 2,
  config: {
    maskMode: 'MASK_MODE_BACKGROUND',  // auto-detect background as mask
  },
});

const response = await ai.models.editImage({
  model: 'imagen-3.0-capability-001',   // editImage-specific model
  prompt: 'Replace the background with a soft studio gradient',
  referenceImages: [rawRef, maskRef],
  config: {
    editMode: EditMode.EDIT_MODE_BGSWAP,
    numberOfImages: 1,
  },
});

const edited = response.generatedImages?.[0]?.image?.imageBytes;
```

### editImage vs generateContent Refine

| Scenario | Recommendation |
|----------|---------------|
| Change overall style, lighting, composition | `generateContent()` multi-turn refine |
| Precise "edit only this region" control | `editImage()` + mask |
| Background replacement (preserve subject outline) | `editImage()` + `EDIT_MODE_BGSWAP` |
| Remove unwanted elements | `editImage()` + `EDIT_MODE_INPAINT_REMOVAL` |

**Note:** `editImage()` does not return `thoughtSignature` and cannot join a multi-turn refine chain.

---

## countTokens() — Estimate Token Consumption

Estimate token count before sending the request, for budget control or user feedback.

```typescript
const tokenCount = await ai.models.countTokens({
  model: 'gemini-3.1-flash-image-preview',
  contents: [{ role: 'user', parts }],
});

console.log(tokenCount.totalTokens);              // total tokens
console.log(tokenCount.cachedContentTokenCount);  // cached tokens (if using cache)
```

### Usage in Auto-Refine

```typescript
// Check context size before refine
const estimate = await ai.models.countTokens({
  model: GENERATION_MODEL,
  contents: buildRefineContents(session, instruction),
});

if (estimate.totalTokens > 32_000) {
  console.warn(`[refine] context too large (${estimate.totalTokens} tokens), falling back to single-turn`);
}
```

### Notes

- `countTokens` itself consumes negligible resources (10–100x faster than `generateContent`).
- Image token count is determined by resolution (~258 tokens for a 1K image).
- `thoughtSignature` injection does not increase token count (internal state, not billed).

---

## upscaleImage() — Super-Resolution

Upscale generated images by 2x or 4x. **Vertex AI only — Gemini API does not support this.**

```typescript
const response = await ai.models.upscaleImage({
  model: 'imagen-3.0-generate-002',
  image: {
    imageBytes: Buffer.from(imageBase64, 'base64'),
    mimeType: 'image/png',
  },
  upscaleFactor: 'x2',   // 'x2' | 'x4'
  config: {
    outputMimeType: 'image/png',
  },
});

const upscaled = response.generatedImages?.[0]?.image?.imageBytes;
```

### Workflow Integration

```
generate (1K) → LAAJ converged → upscaleImage (2K/4K) → final output
```

Ideal for a single upscale pass after auto-refine converges, before delivering the final image.

---

## personGeneration — Person Generation Policy

`imageConfig.personGeneration` controls whether Imagen models generate faces/human figures:

```typescript
import { PersonGeneration } from '@google/genai';

config: {
  imageConfig: {
    aspectRatio: '1:1',
    imageSize: '1K',
    personGeneration: PersonGeneration.ALLOW_ADULT,  // ALLOW_ALL | ALLOW_ADULT | DONT_ALLOW
  },
}
```

| Value | Description |
|-------|-------------|
| `ALLOW_ALL` | Allow all persons (including children) |
| `ALLOW_ADULT` | Allow adults only (default) |
| `DONT_ALLOW` | Disallow all person generation |

**Note:** This field applies to `generateImages()` and `editImage()`. It has no effect on `generateContent()` (person content in `generateContent` is controlled by safety filters).

---

## API-to-Model Mapping

| API | Recommended Model | Platform Support |
|-----|------------------|------------------|
| `generateContent()` | `gemini-3.1-flash-image-preview` | Gemini API + Vertex |
| `generateImages()` | `imagen-4.0-generate-001` | Gemini API + Vertex |
| `editImage()` | `imagen-3.0-capability-001` | Gemini API + Vertex |
| `upscaleImage()` | `imagen-3.0-generate-002` | **Vertex only** |
| `countTokens()` | any model | Gemini API + Vertex |

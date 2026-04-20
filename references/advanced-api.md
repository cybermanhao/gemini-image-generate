# Advanced API — editImage / countTokens / upscaleImage / personGeneration

SDK 中与图像生成相关但当前未使用的 API。

---

## editImage() — 局部编辑 / Inpainting

`ai.models.editImage()` 使用 Imagen 3 的专用编辑能力，通过 mask 精确控制编辑范围。
与 `generateContent()` 的精调不同：editImage 是**像素级操作**，精调是**语义级操作**。

### 可用编辑模式（EditMode）

| 模式 | 说明 |
|------|------|
| `EDIT_MODE_DEFAULT` | 通用编辑，模型自行决定 |
| `EDIT_MODE_INPAINT_INSERTION` | mask 区域内插入新内容 |
| `EDIT_MODE_INPAINT_REMOVAL` | 移除 mask 区域内的内容并填充背景 |
| `EDIT_MODE_OUTPAINT` | 向外扩展画布 |
| `EDIT_MODE_BGSWAP` | 替换背景，保留主体 |
| `EDIT_MODE_PRODUCT_IMAGE` | 将产品放入场景 |
| `EDIT_MODE_STYLE` | 风格迁移 |
| `EDIT_MODE_CONTROLLED_EDITING` | 结构化控制编辑（需要 ControlReferenceImage） |

### 用法

```typescript
import { GoogleGenAI, EditMode, MaskReferenceImage, RawReferenceImage } from '@google/genai';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

const response = await ai.models.editImage({
  model: 'imagen-3.0-capability-001',   // editImage 专用模型
  prompt: 'Replace the background with a soft studio gradient',
  referenceImages: [
    // 原图
    new RawReferenceImage({
      referenceImage: { imageBytes: Buffer.from(imageBase64, 'base64') },
      referenceId: 1,
    }),
    // Mask（白色区域 = 编辑范围）
    new MaskReferenceImage({
      referenceId: 2,
      config: {
        maskMode: 'MASK_MODE_BACKGROUND',  // 自动检测背景区域作为 mask
      },
    }),
  ],
  config: {
    editMode: EditMode.EDIT_MODE_BGSWAP,
    numberOfImages: 1,
  },
});

const edited = response.generatedImages?.[0]?.image?.imageBytes;
```

### 与 generateContent refine 的选择

| 场景 | 推荐 |
|------|------|
| 改变整体风格、光照、构图 | `generateContent()` multi-turn refine |
| 精确控制"只改这块区域" | `editImage()` + mask |
| 背景替换（保留主体轮廓） | `editImage()` + `EDIT_MODE_BGSWAP` |
| 移除不需要的元素 | `editImage()` + `EDIT_MODE_INPAINT_REMOVAL` |

**注意：** `editImage()` 不返回 `thoughtSignature`，无法接入 multi-turn refine 链路。

---

## countTokens() — 预估 Token 消耗

在实际发送请求前估算 token 数，用于预算控制或用户提示。

```typescript
const tokenCount = await ai.models.countTokens({
  model: 'gemini-3.1-flash-image-preview',
  contents: [{ role: 'user', parts }],
  config: {
    // 与 generateContent 相同的 config（可选）
  },
});

console.log(tokenCount.totalTokens);   // 总 tokens
console.log(tokenCount.cachedContentTokenCount);  // 已缓存的 tokens（如果使用 cache）
```

### 在 auto-refine 中的用途

```typescript
// refine 前检查上下文大小
const estimate = await ai.models.countTokens({
  model: GENERATION_MODEL,
  contents: buildRefineContents(session, instruction),
});

if (estimate.totalTokens > 32_000) {
  // 上下文过大，降级为 single-turn（不带历史）
  console.warn(`[refine] context too large (${estimate.totalTokens} tokens), falling back to single-turn`);
}
```

### 注意事项

- `countTokens` 本身消耗极少（比 `generateContent` 快 10-100x）
- 图像的 token 数由分辨率决定（1K 图 ≈ 258 tokens）
- `thoughtSignature` 注入不增加 token 计数（内部状态，不计费）

---

## upscaleImage() — 超分辨率

将生成的图像放大 2x 或 4x。**仅 Vertex AI 可用，Gemini API 不支持。**

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

### 工作流集成

```
generate (1K) → LAAJ 收敛 → upscaleImage (2K/4K) → 最终输出
```

适合在 auto-refine 完成后、交付最终图像前做一次超分。

---

## personGeneration — 人物生成策略

`imageConfig.personGeneration` 控制 Imagen 模型是否生成人脸/人体：

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

| 值 | 说明 |
|----|------|
| `ALLOW_ALL` | 允许所有人物（包括儿童形象） |
| `ALLOW_ADULT` | 仅允许成人形象（默认） |
| `DONT_ALLOW` | 完全禁止人物生成 |

**注意：** 此字段作用于 `generateImages()` 和 `editImage()`，对 `generateContent()` 无效（generateContent 的人物内容由安全过滤器控制）。

---

## 各 API 的适用模型

| API | 推荐模型 | 支持平台 |
|-----|---------|---------|
| `generateContent()` | `gemini-3.1-flash-image-preview` | Gemini API + Vertex |
| `generateImages()` | `imagen-4.0-generate-001` | Gemini API + Vertex |
| `editImage()` | `imagen-3.0-capability-001` | Gemini API + Vertex |
| `upscaleImage()` | `imagen-3.0-generate-002` | **仅 Vertex** |
| `countTokens()` | 任何模型 | Gemini API + Vertex |

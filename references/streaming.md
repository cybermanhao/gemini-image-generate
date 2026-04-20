# Streaming — generateContentStream

`ai.models.generateContentStream()` 接受与 `generateContent()` 完全相同的参数，返回 `AsyncGenerator<GenerateContentResponse>`。每个 chunk 结构与非流式响应相同。

---

## 基本用法

```typescript
const stream = await ai.models.generateContentStream({
  model: 'gemini-3.1-flash-image-preview',
  contents: [{ role: 'user', parts }],
  config: {
    responseModalities: ['TEXT', 'IMAGE'],
    imageConfig: { aspectRatio: '1:1', imageSize: '1K' },
    thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
    abortSignal: signal,   // abort 同样适用
  },
});

for await (const chunk of stream) {
  const parts = chunk.candidates?.[0]?.content?.parts ?? [];
  // 处理每个 chunk
}
```

---

## 图像生成时流式的实际行为

图像数据不会逐像素流式传输。实际顺序是：

```
chunk 1…N  →  { text: "...", thought: true }   ← thought 文本（如果 includeThoughts: true）
chunk N+1  →  { text: "RENDER: ..." }           ← 模型自描述（可能分多 chunk）
chunk N+2  →  { inlineData: { data: "..." } }   ← 完整图像（单个 chunk，不分片）
```

**结论：** 流式对图像生成的主要价值是**提前拿到 thought 和描述文本**，让 UI 能在图像出来前就显示"模型正在思考…"。

---

## 推荐模式：流式转 SSE 推送

在 server.ts 中，将 thought 流式 broadcast 给 Web UI：

```typescript
async function doGenerateStream(params: {
  prompt: string;
  aspectRatio: string;
  imageSize: string;
  signal?: AbortSignal;
}, onThought: (text: string) => void): Promise<GenerateResult> {
  const parts: Part[] = [{ text: params.prompt }];

  const stream = await ai.models.generateContentStream({
    model: GENERATION_MODEL,
    contents: [{ role: 'user', parts }],
    config: {
      responseModalities: ['TEXT', 'IMAGE'],
      imageConfig: { aspectRatio: params.aspectRatio, imageSize: params.imageSize },
      thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL, includeThoughts: true },
      abortSignal: params.signal,
    },
  });

  const allParts: Part[] = [];
  for await (const chunk of stream) {
    const chunkParts = chunk.candidates?.[0]?.content?.parts ?? [];
    for (const p of chunkParts) {
      if (p.thought && p.text) {
        onThought(p.text);   // 实时推送 thought 给前端
      }
      allParts.push(p);
    }
  }

  const img = allParts.find(p => p.inlineData?.mimeType?.startsWith('image/'));
  if (!img?.inlineData?.data) throw new Error('Model did not return an image');

  return {
    imageBase64: img.inlineData.data,
    thoughtSignature: img.thoughtSignature ?? undefined,
    modelDescription: allParts.find(p => p.text && !p.thought)?.text?.trim(),
    contextSnapshot: [],
  };
}

// 调用方，把 thought 通过 SSE 推给前端
await doGenerateStream(params, (thought) => {
  broadcast(sessionId, { type: 'thought', text: thought });
});
```

前端监听 `thought` 事件显示进度气泡。

---

## Judge 的流式场景（更有用）

LAAJ judge 是纯文字输出，流式效果更明显——用户能看到 JSON 逐渐填充：

```typescript
const stream = await ai.models.generateContentStream({
  model: JUDGE_MODEL,
  contents: [{ role: 'user', parts: [imageP, textP] }],
  config: {
    thinkingConfig: { thinkingBudget: 0 },
    abortSignal: signal,
  },
});

let accumulated = '';
for await (const chunk of stream) {
  accumulated += chunk.text ?? '';
  // 每 chunk 推一次，前端实时显示评估进度
  broadcast(sessionId, { type: 'judge-progress', partial: accumulated });
}
// 最终解析 JSON
const jsonMatch = accumulated.match(/\{[\s\S]*\}/);
```

---

## 与 abort 集成

`abortSignal` 在流式场景同样有效——abort 后 `for await` 立刻抛出 `AbortError`，不会再收到后续 chunk：

```typescript
try {
  for await (const chunk of stream) { ... }
} catch (err) {
  if (isAbortError(err)) return; // 用户中断，正常退出
  throw err;
}
```

---

## 当前状态

本项目的 `doGenerate` / `doRefine` / `doJudge` 目前使用非流式 `generateContent()`。
流式版本是可选升级，不影响现有功能，优先做 judge 流式（用户等待感知最强）。

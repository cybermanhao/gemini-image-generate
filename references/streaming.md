# Streaming — generateContentStream

`ai.models.generateContentStream()` accepts the same parameters as `generateContent()` and returns `AsyncGenerator<GenerateContentResponse>`. Each chunk has the same structure as the non-streaming response.

---

## Basic Usage

```typescript
const stream = await ai.models.generateContentStream({
  model: 'gemini-3.1-flash-image-preview',
  contents: [{ role: 'user', parts }],
  config: {
    responseModalities: ['TEXT', 'IMAGE'],
    imageConfig: { aspectRatio: '1:1', imageSize: '1K' },
    thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
    abortSignal: signal,
  },
});

for await (const chunk of stream) {
  const parts = chunk.candidates?.[0]?.content?.parts ?? [];
  // process each chunk
}
```

---

## Actual Streaming Behavior for Image Generation

Image data is **not** streamed pixel-by-pixel. The actual chunk sequence is:

```
chunk 1…N  →  { text: "...", thought: true }   ← thought text (if includeThoughts: true)
chunk N+1  →  { text: "RENDER: ..." }           ← model self-description (may span chunks)
chunk N+2  →  { inlineData: { data: "..." } }   ← complete image (single chunk, not split)
```

**Takeaway:** The main value of streaming for image generation is **early access to thought and description text**, letting the UI show "model is thinking…" before the image arrives.

---

## Recommended Pattern: Stream-to-SSE Push

In `server.ts`, broadcast thought chunks to the Web UI via SSE:

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
        onThought(p.text);   // push thought to frontend in real time
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

// Caller pushes thoughts through SSE
await doGenerateStream(params, (thought) => {
  broadcast(sessionId, { type: 'thought', text: thought });
});
```

The frontend listens for `thought` events to show progress bubbles.

---

## Streaming for Judge (More Impactful)

LAAJ judge is text-only output, so streaming is more visible — the user sees JSON filling in gradually:

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
  // push each chunk; frontend shows live evaluation progress
  broadcast(sessionId, { type: 'judge-progress', partial: accumulated });
}
// final JSON parse
const jsonMatch = accumulated.match(/\{[\s\S]*\}/);
```

---

## Integration with Abort

`abortSignal` works with streaming too — after abort, `for await` throws `AbortError` immediately and no further chunks are received:

```typescript
try {
  for await (const chunk of stream) { ... }
} catch (err) {
  if (isAbortError(err)) return; // user interrupt, clean exit
  throw err;
}
```

---

## Current Status

This project's `doGenerate` / `doRefine` / `doJudge` currently use non-streaming `generateContent()`. Streaming is an optional upgrade that does not affect existing functionality; prioritize judge streaming first (strongest user-perceived latency improvement).

# Context Caching — ai.caches

`ai.caches` 允许将大段 prompt（system instruction、few-shot 示例、固定 contents）上传一次、复用多次。后续请求只发送**增量部分**，节省 token 消耗和首包延迟。

---

## 适用场景

| 场景 | 被缓存的内容 | 节省 |
|------|------------|------|
| LAAJ judge 多轮评估 | judge system instruction（~500 tokens，每轮重复） | 每轮节省 ~30-50% input tokens |
| auto-refine 循环 | base prompt + style context | 跨轮复用 |
| 固定参考图（File API URI） | 上传一次的 style ref 图 | 不重传图像 tokens |

---

## 最低缓存 token 数

| 模型系列 | 最低 |
|---------|------|
| Gemini 2.5 / 2.0 | 1,024 tokens |
| Gemini 1.5 | 4,096 tokens |

judge system instruction 大约 400-600 tokens，**单独缓存不够**。解决方案：把 few-shot 示例或固定上下文一起打包进缓存，凑够 1024 tokens。

---

## 基本用法

### 1. 创建缓存

```typescript
import { GoogleGenAI } from '@google/genai';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

// 缓存 judge 的 system instruction（+ few-shot 示例）
const cache = await ai.caches.create({
  model: 'gemini-2.5-flash',
  config: {
    displayName: 'laaj-judge-v1',
    ttl: '3600s',  // 1 小时，按需调整
    systemInstruction: {
      parts: [{ text: JUDGE_SYSTEM_INSTRUCTION }],
    },
    // 如果 system instruction 不够 1024 tokens，追加 few-shot contents：
    contents: [
      {
        role: 'user',
        parts: [{ text: '/* few-shot example 1 */' }],
      },
      {
        role: 'model',
        parts: [{ text: '/* expected output 1 */' }],
      },
    ],
  },
});

const cacheName = cache.name!;  // 保存，后续请求复用
```

### 2. 引用缓存

```typescript
const response = await ai.models.generateContent({
  model: 'gemini-2.5-flash',
  contents: [{
    role: 'user',
    parts: [
      { inlineData: { data: imageBase64, mimeType: 'image/jpeg' } },
      { text: `Evaluate against: ${prompt}` },
    ],
  }],
  config: {
    cachedContent: cacheName,   // ← 引用缓存
    thinkingConfig: { thinkingBudget: 0 },
    abortSignal: signal,
  },
});
```

### 3. 删除缓存（用完即删）

```typescript
await ai.caches.delete({ name: cacheName });
```

---

## auto-refine 循环中的集成模式

```typescript
// 在 runAutoRefine 开始前创建一次 judge cache
let judgeCache: string | undefined;
try {
  const cache = await ai.caches.create({
    model: JUDGE_MODEL,
    config: {
      displayName: `judge-session-${session.id}`,
      ttl: '1800s',
      systemInstruction: { parts: [{ text: JUDGE_SYSTEM_INSTRUCTION }] },
    },
  });
  judgeCache = cache.name ?? undefined;
} catch {
  // Cache 创建失败不阻断流程，降级为无缓存
}

// 在循环内 doJudge 时传入 cache name
judgeResult = await doJudge({
  imageBase64: currentRound.imageBase64,
  prompt: session.basePrompt ?? '',
  cachedContent: judgeCache,
  signal: sig,
});

// 循环结束后清理
if (judgeCache) {
  ai.caches.delete({ name: judgeCache }).catch(() => {});
}
```

`doJudge` 需要增加 `cachedContent?: string` 参数并传给 `config.cachedContent`。

---

## 缓存生命周期管理

| 操作 | 方法 |
|------|------|
| 查看所有缓存 | `ai.caches.list()` → `Pager<CachedContent>` |
| 延长 TTL | `ai.caches.update({ name, config: { ttl: '7200s' } })` |
| 按名称获取 | `ai.caches.get({ name })` |
| 删除 | `ai.caches.delete({ name })` |

---

## 注意事项

1. **TTL 不自动续期** — auto-refine 循环如果超过 TTL，缓存过期后请求会报 404，需要 `catch` 重建。
2. **缓存与模型绑定** — 创建时指定的 model 必须与使用时一致。
3. **缓存不跨 API key** — 同一 key 内有效。
4. **费用** — 缓存 token 有存储费用（远低于重复发送的推理费用）。
5. **Gemini API（非 Vertex）限制** — 不支持 `kmsKeyName`，TTL 上限视配额而定。

---

## 当前状态（已实现）

`doJudge` 已接入缓存，`runAutoRefine` 在循环开始前创建 cache，结束后（包括收敛、错误、abort 所有路径）自动删除。

- `JUDGE_SYSTEM_INSTRUCTION` 包含评估框架 + 2 个 few-shot 示例，约 1200 tokens（超过 1024 最低要求）
- `JudgeBody.cachedContent?: string` — 有值时使用 `config.cachedContent`；无值时 `config.systemInstruction` 直接内联（手动 judge 路径降级）
- `runAutoRefine` 的 while 循环包裹在 try/finally 中，确保 cache 在所有退出路径都被删除

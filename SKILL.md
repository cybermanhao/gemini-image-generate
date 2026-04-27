---
name: gemini-imagen-patterns
description: Gemini image generation SDK patterns and best practices
tags: ["gemini", "image-generation", "multimodal", "refine", "judge"]
model: kimi-k2.6
rootUrl: https://raw.githubusercontent.com/cybermanhao/gemini-image-generate/main/SKILL.md
---

# Gemini Image Studio

Visual web UI + MCP Server for multimodal image generation with `@google/genai`.

Pick your scenario:

| If you are... | Go to |
|---------------|-------|
| CLI agent, **fully automate** generate→judge→refine | **Scenario 1** |
| CLI agent, need **human** A/B choices or input | **Scenario 2** |
| Calling Gemini API **directly** in code | **Scenario 3** |
| **Human** using browser without CLI | **Scenario 4** |

## Scenario 1: Auto-Refine Loop

```
generate_image(autoRefine=true, maxRounds=3)
    ↓
poll get_session_status until done|error
    ↓
export_session (optional)
```

Orchestrator: generate → judge → refine → ... → converged or maxRounds. Uses `thoughtSignature` for multi-turn consistency and `ai.caches` for judge prompt caching. Call `abort_session` to stop.

**Tools:** `generate_image` · `get_session_status` · `abort_session` · `export_session`

## Scenario 2: Human-in-the-Loop

```
open_image_studio() → browser opens
    ↓
generate_image() → SSE pushes result to browser
    ↓
choose_best(A, B) → browser popup → user clicks → returns choice
await_input(hint) → browser input → user types → returns instruction
    ↓
refine_image() / judge_image() / edit_image()
```

**Tools:** `open_image_studio` · `generate_image` · `refine_image` · `edit_image` · `judge_image` · `choose_best` · `await_input` · `abort_session` · `export_session`

## Scenario 3: Pure SDK

Direct `@google/genai` usage, no server.

```typescript
import { GoogleGenAI, ThinkingLevel, createPartFromUri } from '@google/genai';
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
```

**Models:** `gemini-3-pro-image-preview` (generation), `gemini-2.5-flash` (LAAJ).

**Parts:** `{text}` · `{inlineData}` · `{fileData}` / `createPartFromUri`

**Ordering:** start with image → extra refs → instruction LAST. Guardrail text immediately follows its image.

**Response parsing:**
```typescript
const parts = response.candidates?.[0]?.content?.parts ?? [];
const img = parts.find(p => p.inlineData?.mimeType?.startsWith('image/'));
// img?.thoughtSignature → store for Refine (may be undefined)
```

**[pic_N] interleaving** — project-defined helper (not SDK syntax). `interleaveInstructionParts()` expands `[pic_1]` tokens into `text / image / text` parts before the API call. See `references/interleaving.md`.

## Scenario 4: Pure Web

```bash
cd web-ui && cp .env.example .env && npm install && npm start
# open http://localhost:3456
```

- **Generate:** upload subject/style refs, write prompt, pick ratio/size
- **Refine:** select round → judge / edit / refine with `[pic_N]` drag-and-drop
- **Reverse:** upload image → reverse-engineer prompt or segments

## Usage Examples

### Example 1
**User:** 我想用 Gemini 生成一张产品图，但怎么传参考图？

**AI:** Gemini 支持两种传参考图的方式：

**1. inlineData（base64 直接嵌入）**
```typescript
const parts = [
  { inlineData: { data: base64String, mimeType: 'image/jpeg' } },
  { text: 'Generate a product photo with this style...' }
];
```

**2. File API（推荐大文件 / 多轮复用）**
```typescript
const file = await ai.files.upload({ file: blob, config: { mimeType: 'image/jpeg' } });
const parts = [
  createPartFromUri(file.uri, 'image/jpeg'),
  { text: 'Generate a product photo...' }
];
```

**关键顺序规则**：当有参考图时，第一个 part 必须是图片，指令文本放在最后。这样模型先看到所有视觉参考，再读取任务描述。

### Example 2
**User:** 我的 refine 多轮对话里 thoughtSignature 变成了 undefined，怎么办？

**AI:** `thoughtSignature` 是 **未文档化字段**，可能因以下原因缺失：

| 原因 | 表现 | 处理 |
|------|------|------|
| 安全过滤 | 图片生成但无 signature | 单轮降级模式 |
| 模型版本 | 旧版模型不支持 | 升级到 gemini-3-pro-image-preview |
| 多图片返回 | 只取了第一个 part | 用 `parts.filter(p=>p.inlineData).find(p=>p.thoughtSignature)` |

**降级策略**：当 thoughtSignature 缺失时，将上一轮图片作为普通参考图传入（非 signature 关联），退化为单轮生成模式。详见 `references/multiturn.md`。

## References

| Topic | File |
|-------|------|
| 13 runnable examples (text-to-image to LAAJ) | `references/examples.md` |
| Model selection, imageConfig, thinkingConfig | `references/models.md` |
| [pic_N] implementation | `references/interleaving.md` |
| Multi-turn Refine + thoughtSignature | `references/multiturn.md` |
| File API cache / fallback / error codes | `references/file-api-cache.md` |
| LAAJ evaluation loop | `references/laaj.md` |
| Skill self-evolution framework | `references/skill-evolution.md` |
| Web UI + MCP Server | `web-ui/` |

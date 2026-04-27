---
name: gemini-imagen-patterns
description: Gemini image generation SDK patterns and best practices
tags: ["gemini", "image-generation", "multimodal", "refine", "judge"]
model: kimi-k2.6
rootUrl: https://raw.githubusercontent.com/cybermanhao/gemini-image-generate/main/SKILL.md
---

# Gemini Multimodal Image Generation — Patterns

## SDK

```typescript
import { GoogleGenAI, ThinkingLevel, createPartFromUri } from '@google/genai';
// SDK: @google/genai v1.46.0+  (NOT @google-cloud/aiplatform)
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
```

| Model | Use |
|-------|-----|
| `gemini-3.1-flash-image-preview` | Image generation — workhorse; supports `thoughtSignature` |
| `gemini-3-pro-image-preview` | Image generation — higher quality; `imageSize` up to 4K |
| `gemini-2.5-flash-image` | Image generation + editing via chat API; simpler but no manual `thoughtSignature` control |
| `gemini-2.5-flash` / `gemini-2.5-pro` | Vision analysis, scoring, LAAJ evaluation (text output only) |

**Generation and evaluation always use different models** — see `references/models.md` for selection criteria, `imageConfig` params, and thinkingConfig per model family.

## Parts — Three Types

```typescript
{ text: string }
{ inlineData: { data: string /* base64 */, mimeType: 'image/jpeg' } }
createPartFromUri(fileUri, 'image/jpeg')   // official SDK helper for File API URIs
// or: { fileData: { fileUri, mimeType } }
```

## Parts Ordering (matters for attention)

```
[style ref image] [style ref guardrail text]  ← guardrail text follows its image immediately
[main subject image]                           ← File API URI preferred
[extra ref image 1…N]                          ← optional
[main instruction text]                        ← instruction LAST
```

Three rules:
- **When reference images are present, start with an image** — if you have any reference or subject images, the first part should be an image, not introductory text. Placing text before the first image dilutes its association with the images that follow. (Pure text-to-image calls with no input images are fine starting with text.)
- **Instruction text goes last** — the main "do X" prompt follows all images so the model sees all visuals before reading the task.
- **Guardrail text follows its image immediately** — if you need to constrain what the model copies from a reference (e.g., "copy ONLY composition, NOT the subject"), place that text right after its image. This anchors the constraint before the model sees the next image. See Example 3 in `references/examples.md` for the full pattern.

## [pic_N] Interleaving (Project Convention)

> ⚠️ `[pic_1]`, `[pic_2]` etc. are **not** Google GenAI SDK syntax. They are a project-defined token convention.
>
> The helper `interleaveInstructionParts()` (see `references/interleaving.md`) replaces these tokens with actual image parts **before** calling the API.
>
> The Web UI's `InstructionComposer` supports drag-and-drop insertion of `[pic_N]` tokens for convenience.

Replace `[pic_1]`, `[pic_2]` tokens in instruction strings with actual image parts at call time → `text / image / text / image / text`. Read `references/interleaving.md` for the implementation.

## thinkingConfig — Model-Dependent

**Gemini 2.5** → `thinkingBudget: number` (0=off, -1=auto, N=token limit)
- `gemini-2.5-pro` minimum is 128 and cannot be turned off

**Gemini 3** → `thinkingLevel: ThinkingLevel` (MINIMAL / LOW / MEDIUM / HIGH)
- Omit `thinkingConfig` entirely in multi-turn Refine to reduce latency

`includeThoughts: true` returns extra `{ thought: true }` parts — debug only.

## ⚠️ Seed Has No Reproducibility Guarantee

Gemini is autoregressive. `seed` does not reliably reproduce the same output. Only use it as a trace/correlation ID for debugging.

## Response Parsing

```typescript
const parts = response.candidates?.[0]?.content?.parts ?? [];
const img = parts.find(p => p.inlineData?.mimeType?.startsWith('image/'));
// img.inlineData.data    → base64 image
// img.thoughtSignature   → undocumented field, store for Refine (see references/multiturn.md)
//                           May be absent (content filtered, model version, or safety block).
//                           Always type as `string | undefined`. If absent, fall back to
//                           single-turn mode — see "Degradation" in references/multiturn.md
const desc = parts.find(p => p.text && !p.thought)?.text?.trim();
```

`thoughtSignature` is **not in official docs** — undocumented field on image-gen models.

---

## MCP Server & Image Studio

A built-in MCP Server (`web-ui/server.ts`) exposes:
- **MCP HTTP transport** (`/mcp/sse`) for CLI agents
- **Web UI** (`http://localhost:3456`) for visual interaction

**Start:**
```bash
cd web-ui
cp .env.example .env  # add GEMINI_API_KEY
npm install
npm start             # starts on port 3456
```

**CLI + SSE mode:** Human-in-the-loop tools (`choose_best`, `await_input`) push choice panels to the browser via SSE and block until the user responds.

**Pure web mode:** Open `http://localhost:3456` directly as a standalone visual playground.

### MCP Tools

| Tool | Mode | Description |
|------|------|-------------|
| `open_image_studio` | both | Returns the studio URL for a session |
| `generate_image` | both | Text-to-image or image-to-image. Set `autoRefine=true` to start the full `generate → judge → refine` loop; poll with `get_session_status` |
| `refine_image` | both | Multi-turn refine with thoughtSignature |
| `edit_image` | both | Imagen 3 pixel-level editing: BGSWAP, INPAINT_REMOVAL, INPAINT_INSERTION, STYLE |
| `judge_image` | both | LAAJ evaluation (scores + improvement suggestions) |
| `get_session_status` | both | Poll session status — essential when `autoRefine=true` |
| `abort_session` | both | Abort active auto-refine loop, return to manual mode |
| `export_session` | both | Export all rounds and metadata as JSON |
| `choose_best` | CLI+SSE | Ask user to pick between two rounds |
| `await_input` | CLI+SSE | Wait for user refinement instruction |

---

## References

| Topic | File |
|-------|------|
| **Runnable generation examples** (13 patterns from text-to-image to LAAJ) | `references/examples.md` |
| Model selection, imageConfig, thinkingConfig per family | `references/models.md` |
| [pic_N] interleaving implementation | `references/interleaving.md` |
| Multi-turn Refine + thoughtSignature + single-turn fallback | `references/multiturn.md` |
| File API upload / cache / fallback / **error classification (429/503/403/400)** | `references/file-api-cache.md` |
| AbortSignal / timeout / user interrupt / soft-takeover pattern | `references/abort.md` |
| LLM-as-a-Judge evaluation loop (default judge: `gemini-2.5-flash`) | `references/laaj.md` |
| Using LAAJ to evolve skills, code, and docs | `references/skill-evolution.md` |
| Streaming (`generateContentStream`) — thought progress, judge live output | `references/streaming.md` |
| Context caching (`ai.caches`) — reuse judge prompts across refine rounds | `references/caching.md` |
| editImage / countTokens / upscaleImage / personGeneration | `references/advanced-api.md` |
| Interactive web UI + MCP Server (Generate / Refine / LAAJ / Human-in-the-loop) | `web-ui/` |

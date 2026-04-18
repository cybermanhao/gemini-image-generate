---
name: gemini-imagen-patterns
description: >
  Patterns for building multimodal image generation pipelines with the @google/genai SDK.
  Use for any image generation domain (product renders, anime, character art, game assets,
  video pipeline materials, concept art). Covers: parts array construction, text-image-text
  interleaving, File API caching, multi-turn Refine with thoughtSignature, thinkingConfig,
  response parsing, and LLM-as-a-Judge evaluation loops. Invoke when building Gemini image
  generation, implementing multi-turn Refine, designing LAAJ evaluation, or figuring out
  how to interleave images into prompts.
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
| `gemini-3.1-flash-image-preview` / `gemini-3-pro-image-preview` | Image generation (IMAGE modality) |
| `gemini-2.5-flash` / `gemini-2.5-pro` | Vision analysis, scoring, LAAJ evaluation |

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
[style ref image] [style ref label text]   ← optional
[main subject image]                        ← File API URI preferred
[extra ref image 1…N]                      ← optional
[main prompt text]                          ← text LAST
```

Text last: model sees all visuals before processing the instruction.

## [pic_N] Interleaving

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
const desc = parts.find(p => p.text && !p.thought)?.text?.trim();
```

`thoughtSignature` is **not in official docs** — undocumented field on image-gen models.

---

## MCP Server & Image Studio

This skill ships with a built-in MCP Server (`web-ui/server.ts`) that exposes both:
- **MCP HTTP transport** (`/mcp/sse`) for CLI agents
- **Web UI** (`http://localhost:3456`) for visual interaction

### CLI + SSE Mode (Human-in-the-loop)

When a CLI agent needs human judgment (e.g. "Which of these two images is better?"), the MCP Server pushes a `choice-request` event via SSE to the browser. The user clicks in the web UI, and the result flows back to the CLI.

**Blocking tools:**
- `choose_best(sessionId, roundA, roundB, question)` — A/B comparison, blocks until user picks
- `await_input(sessionId, hint)` — Wait for user to type a refinement instruction

### Pure Web Mode (Visual Simulator)

Open `http://localhost:3456` directly. No CLI needed. Use it as a standalone visual playground for Gemini image generation, refinement, and LAAJ evaluation.

**Start the server:**
```bash
cd web-ui
cp .env.example .env  # add GEMINI_API_KEY
npm install
npm start             # starts on port 3456
```

### MCP Tools

| Tool | Mode | Description |
|------|------|-------------|
| `open_image_studio` | both | Returns the studio URL for a session |
| `generate_image` | both | Text-to-image or image-to-image generation |
| `refine_image` | both | Multi-turn refine with thoughtSignature |
| `judge_image` | both | LAAJ evaluation (scores + improvement suggestions) |
| `choose_best` | CLI+SSE | Ask user to pick between two rounds |
| `await_input` | CLI+SSE | Wait for user refinement instruction |

---

## References

| Topic | File |
|-------|------|
| **Runnable generation examples** (12 patterns from text-to-image to LAAJ) | `references/examples.md` |
| Model selection, imageConfig, thinkingConfig per family | `references/models.md` |
| [pic_N] interleaving implementation | `references/interleaving.md` |
| Multi-turn Refine + thoughtSignature | `references/multiturn.md` |
| File API upload / cache / fallback | `references/file-api-cache.md` |
| LLM-as-a-Judge evaluation loop (default judge: `gemini-2.5-flash`) | `references/laaj.md` |
| Using LAAJ to evolve skills, code, and docs | `references/skill-evolution.md` |
| Interactive web UI + MCP Server (Generate / Refine / LAAJ / Human-in-the-loop) | `web-ui/` |
| 用户场景故事 (动漫 / 游戏美术 / 电商美术) | `references/user-personas.md` |

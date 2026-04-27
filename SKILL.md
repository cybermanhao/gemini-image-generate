---
name: gemini-imagen-patterns
description: Gemini image generation SDK patterns and best practices
tags: ["gemini", "image-generation", "multimodal", "refine", "judge"]
model: kimi-k2.6
rootUrl: https://raw.githubusercontent.com/cybermanhao/gemini-image-generate/main/SKILL.md
---

# Gemini Image Studio — Usage Scenarios

A visual web UI + MCP Server for building multimodal image generation pipelines with the `@google/genai` SDK.

Supports four distinct usage scenarios. Pick the one that matches your context:

| If you are... | Scenario | Key mechanism |
|---------------|----------|---------------|
| A CLI agent that wants to **fully automate** generate → judge → refine | **Scenario 1** | `autoRefine=true` + polling |
| A CLI agent that needs a **human** to make choices or type instructions | **Scenario 2** | MCP tools + SSE to browser |
| Writing code that **calls the Gemini API directly** (no server) | **Scenario 3** | `@google/genai` SDK patterns |
| A **human** using the browser directly without any CLI | **Scenario 4** | Web UI at `http://localhost:3456` |

---

## Scenario 1: CLI Agent — Auto-Refine Loop

**When to use:** Your agent wants to generate an image and then automatically refine it based on LAAJ evaluation, without any human intervention. The loop runs until the image converges or hits a max round limit.

**Flow:**

```
generate_image(sessionId="abc", prompt="...", autoRefine=true, maxRounds=3)
    ↓
← "Auto-refine started. Poll status with get_session_status."
    ↓
[get_session_status] → [get_session_status] → ... (poll every few seconds)
    ↓
status = done | error | idle
    ↓
export_session (optional) → JSON with all rounds + scores
```

**What happens under the hood:**

```
generate → judge → refine → judge → refine → ... → converged or maxRounds reached
```

The orchestrator (`web-ui/src/server/orchestrators/autoRefine.ts`):
1. Creates a **judge context cache** (`ai.caches`) for the evaluation prompt to reduce latency
2. Runs LAAJ on the latest round
3. If not converged, takes `topIssues[0].fix` as the refinement instruction
4. Calls `doRefine()` with `thoughtSignature` from the previous round
5. Repeats until converged or `maxRounds` reached
6. Cleans up the judge cache

**Key tools:** `generate_image` · `get_session_status` · `abort_session` · `export_session`

**Abort / takeover:** Call `abort_session` at any time to stop the loop and return to manual mode.

---

## Scenario 2: CLI Agent + Human-in-the-Loop

**When to use:** Your agent generates images but needs a human to make A/B comparisons or type refinement instructions. The browser becomes the human interface; SSE pushes choice panels and blocks until the user responds.

**Typical flow:**

```
open_image_studio() → http://localhost:3456?session=abc
    ↓
generate_image(session="abc", prompt="A watercolor painting of a fox")
    ↓ SSE → browser shows Round 0
    ↓
generate_image(session="abc", prompt="Same fox, but at golden hour")
    ↓ SSE → browser shows Round 1
    ↓
choose_best(session="abc", roundA="<id>", roundB="<id>", question="Which lighting is better?")
    ↓ SSE choice-request → browser popup A/B
    ← POST /api/choice ← user clicks A
    ↓
← "User chose: A (no reason given)"
    ↓
refine_image(session="abc", roundId="<id>", instruction="Add lavender field background")
    ↓ SSE → browser shows Round 2
    ↓
judge_image(session="abc", imageBase64="...", prompt="...")
    ↓
← LAAJ scores: composition 4/5, lighting 5/5, overall 4/5
```

**Other tools in this scenario:**

| Tool | What it does |
|------|-------------|
| `await_input` | Blocks until the user types a refinement instruction in the browser |
| `edit_image` | Pixel-level editing (BGSWAP, INPAINT_REMOVAL, INPAINT_INSERTION, STYLE) |
| `abort_session` | Interrupt an active auto-refine loop and return to manual mode |
| `export_session` | Export all rounds and metadata as JSON |

---

## Scenario 3: Pure SDK Call (No Server)

**When to use:** You are calling the Gemini API directly in your own code. No MCP Server, no Web UI, no SSE — just the `@google/genai` SDK.

### SDK Setup

```typescript
import { GoogleGenAI, ThinkingLevel, createPartFromUri } from '@google/genai';
// SDK: @google/genai v1.46.0+  (NOT @google-cloud/aiplatform)
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
```

### Model Selection

| Model | Use |
|-------|-----|
| `gemini-3.1-flash-image-preview` | Image generation — workhorse; supports `thoughtSignature` |
| `gemini-3-pro-image-preview` | Image generation — higher quality; `imageSize` up to 4K |
| `gemini-2.5-flash-image` | Image generation + editing via chat API; simpler but no manual `thoughtSignature` control |
| `gemini-2.5-flash` / `gemini-2.5-pro` | Vision analysis, scoring, LAAJ evaluation (text output only) |

**Generation and evaluation always use different models.**

### Parts — Three Types

```typescript
{ text: string }
{ inlineData: { data: string /* base64 */, mimeType: 'image/jpeg' } }
createPartFromUri(fileUri, 'image/jpeg')   // official SDK helper for File API URIs
// or: { fileData: { fileUri, mimeType } }
```

### Parts Ordering (matters for attention)

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

### [pic_N] Interleaving (Project Convention)

> ⚠️ `[pic_1]`, `[pic_2]` etc. are **not** Google GenAI SDK syntax. They are a project-defined token convention.
>
> The helper `interleaveInstructionParts()` (see `references/interleaving.md`) replaces these tokens with actual image parts **before** calling the API.

Replace `[pic_1]`, `[pic_2]` tokens in instruction strings with actual image parts at call time → `text / image / text / image / text`.

### thinkingConfig — Model-Dependent

**Gemini 2.5** → `thinkingBudget: number` (0=off, -1=auto, N=token limit)
- `gemini-2.5-pro` minimum is 128 and cannot be turned off

**Gemini 3** → `thinkingLevel: ThinkingLevel` (MINIMAL / LOW / MEDIUM / HIGH)
- Omit `thinkingConfig` entirely in multi-turn Refine to reduce latency

`includeThoughts: true` returns extra `{ thought: true }` parts — debug only.

### ⚠️ Seed Has No Reproducibility Guarantee

Gemini is autoregressive. `seed` does not reliably reproduce the same output. Only use it as a trace/correlation ID for debugging.

### Response Parsing

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

## Scenario 4: Pure Web — Human Direct Use

**When to use:** You want to use the Image Studio as a standalone visual playground without any CLI agent.

```bash
cd web-ui
cp .env.example .env   # add GEMINI_API_KEY
npm install
npm start              # starts on http://localhost:3456
```

**Generate Tab:** Upload a subject image (optional) and/or style reference (optional), write a prompt, pick aspect ratio and size, then generate.

**Refine Tab:** After generating, select any round from the timeline. You can:
- **Judge** — Run LAAJ evaluation (scores + improvement suggestions)
- **Edit** — Pixel-level editing with a natural-language prompt
- **Refine** — Multi-turn refinement with `thoughtSignature`; use quick instruction chips or drag-and-drop `[pic_N]` tokens from the image pool into the instruction editor

**Reverse Tab:** Upload an image to reverse-engineer its prompt. Mode A returns a plain text-to-image prompt; Mode B returns structured segments (identity, canvas, environment, view, material, style, quality).

---

## MCP Tools Quick Reference

| Tool | Scenario | Description |
|------|----------|-------------|
| `open_image_studio` | 2, 4 | Returns the studio URL for a session |
| `generate_image` | 1, 2 | Text-to-image or image-to-image. Set `autoRefine=true` to start Scenario 1 |
| `refine_image` | 2 | Multi-turn refine with thoughtSignature |
| `edit_image` | 2 | Imagen 3 pixel-level editing: BGSWAP, INPAINT_REMOVAL, INPAINT_INSERTION, STYLE |
| `judge_image` | 2 | LAAJ evaluation (scores + improvement suggestions) |
| `get_session_status` | 1 | Poll session status — essential when `autoRefine=true` |
| `abort_session` | 1, 2 | Abort active auto-refine loop, return to manual mode |
| `export_session` | 1, 2 | Export all rounds and metadata as JSON |
| `choose_best` | 2 | Ask user to pick between two rounds (CLI+SSE only) |
| `await_input` | 2 | Wait for user refinement instruction (CLI+SSE only) |

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

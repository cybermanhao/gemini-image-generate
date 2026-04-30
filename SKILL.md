---
name: gemini-imagen-patterns
description: Gemini image generation integration guide and reference implementation using @google/genai. Covers SDK/REST direct integration, MCP Server workflows, and Web UI for multimodal image pipelines. Use when: (1) integrating Gemini image generation into an application, (2) building multi-turn refine pipelines with thoughtSignature, (3) setting up auto-refine or LAAJ evaluation loops, (4) implementing human-in-the-loop image generation with A/B choices or user input, (5) working with reference images, style transfer, or parts array construction, (6) configuring imageConfig parameters (aspect ratios, image sizes, thinking levels) for Gemini 3 image models.
tags: ["gemini", "image-generation", "multimodal", "refine", "judge"]
model: kimi-k2.6
rootUrl: https://raw.githubusercontent.com/cybermanhao/gemini-image-generate/main/SKILL.md
---

# Gemini Image Studio

> **Dual purpose:** (1) **Integration guide** — how to add Gemini image generation to your own application. (2) **Reference implementation** — a production-ready MCP Server + Web UI built with `@google/genai`.
>
> The `references/` directory contains the deep technical docs (parts ordering, thought signatures, model configs, interleaving, caching, LAAJ) needed for any integration. The `web-ui/` directory is one possible consumer of those patterns.

## Pick Your Path

This skill covers two layers. Pick based on what you're building:

**Layer A — Integrate into your own app** (most developers start here)
| If you are building... | Go to |
|------------------------|-------|
| Your own app/service with Gemini image generation | **Scenario 1** |
| A CLI agent that automates generate→judge→refine | **Scenario 2** |
| A CLI agent that needs human A/B choices or input | **Scenario 3** |

**Layer B — Use the reference implementation** (this repo's out-of-box tools)
| If you want... | Go to |
|----------------|-------|
| A ready-made browser UI without writing code | **Scenario 4** |

**Default behavior for end-user requests:**

When a user says something like *"帮我生成一张图"* without specifying mode, the agent should **not** assume CLI or Web UI. Use this default flow:

```
User: "帮我生成一张XX"
    ↓
Agent: generate_image(session="x", prompt="XX")  ← direct generation first
    ↓
Agent: "Generated. [Save] or [Open Studio to refine]?"
    ↓
User clicks [Open Studio]
    ↓
Agent: open_image_studio(session="x")  ← lazy-load Web UI only when needed
```

> **When you don't need this skill:** If you only need a single text-to-image call **and have no MCP Server loaded**, use Imagen or `generateContent` directly. If you only need a quick one-off edit, use the Chat API (see `references/models.md`). This skill is for pipelines that involve reference images, multi-turn refinement, evaluation loops, or human-in-the-loop orchestration.

## Scenario 1: Integrate into Your Application

The most common starting point: calling Gemini directly from your own code.

### SDK path (TypeScript / Node)

```typescript
import { GoogleGenAI, createPartFromUri } from '@google/genai';
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
```

**Models:**
| API ID | Marketing name | When to choose |
|--------|---------------|----------------|
| `gemini-3.1-flash-image-preview` | Nano Banana 2 | **Default** for most work. Fast, supports 14 refs, 512 res, 1:4/4:1/1:8/8:1 ratios. Best for batch, refine loops, speed-critical pipelines. |
| `gemini-3-pro-image-preview` | Nano Banana Pro | When **text rendering quality** matters (infographics, menus, logos) or you need **4K output**. Slower but higher fidelity. Only 11 refs total (6 obj + 5 char). |
| `gemini-2.5-flash` | — | **Never for generation.** Only for LAAJ evaluation (cheap text-only scoring). |

> **All generated images include a SynthID watermark.**

**When to pass reference images vs text-only:**

| Situation | Pass refs? | Why |
|-----------|-----------|-----|
| "Make this character wear X" — user provides character + style images | ✅ Yes | Model needs visual anchor for identity preservation |
| "Generate 3 characters in a café" — only text descriptions | ❌ No | Text-only works if descriptions are detailed enough (see Example 1) |
| "Keep this face but change outfit" — user provides face photo | ✅ Yes | Face consistency requires visual reference |
| "Make this logo in a different style" — user provides logo | ✅ Yes | Text rendering accuracy needs visual anchor |
| "Batch generate 50 product photos" — user provides product images | ✅ Yes | Batch consistency requires refs |

Rule of thumb: if the user cares about **visual consistency** with a specific real-world object/person/character, pass refs. If they only want a **generic scene or character archetype**, text-only is faster and sufficient.

**Core integration checklist:**
1. **Parts ordering:** image → extra refs → instruction LAST. Guardrail text immediately follows its image.
2. **Response parsing:** extract image, `thoughtSignature`, and description from parts.
3. **Multi-turn refine:** build 3-turn contents `[turn0, turn1 + sig, turn2]` — see `references/multiturn.md` for full rules.
4. **Parameter validation:** aspect ratios, image sizes, thinking levels — see `references/models.md`.

```typescript
const parts = response.candidates?.[0]?.content?.parts ?? [];
const img = parts.find(p => p.inlineData?.mimeType?.startsWith('image/'));
const sig = img?.thoughtSignature;  // ← store for Refine (see official docs)
// Filter out thought parts when reading final output:
const desc = parts.find(p => p.text && !p.thought)?.text?.trim();
```

### REST path (any language)

```bash
curl -s -X POST \
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image-preview:generateContent" \
  -H "x-goog-api-key: $GEMINI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "contents": [{"parts": [
      {"inline_data": {"mime_type": "image/png", "data": "<BASE64>"}},
      {"text": "Render this subject as a watercolor painting."}
    ]}],
    "generationConfig": {
      "responseModalities": ["TEXT", "IMAGE"],
      "imageConfig": {"aspectRatio": "1:1", "imageSize": "2K"}
    }
  }'
```

**Field name difference:**
- `Part`-level fields (inside `contents[].parts[]`): SDK uses camelCase (`thoughtSignature`, `inlineData`, `mimeType`); REST uses snake_case (`thought_signature`, `inline_data`, `mime_type`).
- `Config`-level fields (inside `generationConfig`): **both SDK and REST use camelCase** (`imageConfig`, `aspectRatio`, `imageSize`, `thinkingConfig`).

The SDK handles the `Part`-level mapping automatically.

> **For Python/Go/Java:** Translate the curl payload into your HTTP client. The field naming rules above apply regardless of language — `Part` fields are snake_case in JSON, `Config` fields are camelCase.

**Thinking constraints:**
- Thinking is **always on** for Gemini 3 image models and cannot be disabled via the API.
- With **Gemini 3.1 Flash Image**, `thinkingLevel` accepts only `'minimal'` (default, lowest latency) and `'high'` (better quality). Gemini 3 Pro Image does not expose thinking level control.
- Thinking tokens are **always billed** regardless of `includeThoughts` setting.
- For evaluation models (e.g. `gemini-2.5-flash`), use `thinkingBudget` instead.

**[pic_N] interleaving** — project-defined helper (not SDK syntax). `interleaveInstructionParts()` expands `[pic_1]` tokens into `text / image / text` parts before the API call. See `references/interleaving.md`.

**Multi-turn Refine with `thoughtSignature`:**
```
generateContent(turn0Parts) → response
    ↓
parse → image + thoughtSignature + description
    ↓
store signature alongside image
    ↓
build 3-turn contents: [turn0, turn1 + sig, turn2 instruction]
    ↓
generateContent(3-turn contents) → refined image
```
Read the full 3-turn construction, signature storage rules, and single-turn fallback in `references/multiturn.md`.

**Officially recommended shortcut:** For simple conversational editing, the `ai.chats` API handles `thoughtSignature` automatically. Use manual `contents` array construction only when you need explicit control over every part. See Chat API in `references/models.md`.

## Scenario 2: MCP Auto-Refine Loop

Use the **reference MCP Server** when you want a pre-built orchestrator instead of writing your own loop.

```
generate_image(autoRefine=true, maxRounds=3)
    ↓
poll get_session_status until done|error
    ↓
export_session (optional)
```

Orchestrator: generate → judge → refine → ... → converged or maxRounds. Uses [`thoughtSignature`](https://ai.google.dev/gemini-api/docs/image-generation?hl=zh-cn) for multi-turn consistency and `ai.caches` for judge prompt caching. Call `abort_session` to stop.

**Tools:** `generate_image` · `get_session_status` · `abort_session` · `export_session`

> This is the **same auto-refine logic** you would build in Scenario 1, but wrapped as reusable MCP tools with SSE progress broadcasts and session management.

## Scenario 3: MCP Human-in-the-Loop

Use the **reference MCP Server** when your workflow needs a human in the decision loop.

> `open_image_studio()` opens the **same Web UI** as Scenario 4. The difference is who drives it: here the CLI agent orchestrates the steps and blocks on human input.

```
open_image_studio() → browser opens (same UI as Scenario 4)
    ↓
generate_image() → SSE pushes result to browser
    ↓
choose_best(A, B) → browser popup → user clicks → returns choice
await_input(hint) → browser input → user types → returns instruction
    ↓
refine_image() / judge_image() / edit_image()
```

**Tools:** `open_image_studio` · `generate_image` · `refine_image` · `edit_image` · `judge_image` · `choose_best` · `await_input` · `abort_session` · `export_session`

## Scenario 4: Pure Web

Standalone browser UI — no CLI, no MCP, no code.

```bash
cd web-ui && cp .env.example .env && npm install && npm start
# open http://localhost:3456
```

- **Generate:** upload subject/style refs, write prompt, pick ratio/size
- **Refine:** select round → judge / edit / refine with `[pic_N]` drag-and-drop
- **Reverse:** upload image → reverse-engineer prompt or segments
- **Auto-Refine:** toggle auto-refine, set max rounds, watch it iterate

> This is the **same UI** that `open_image_studio()` (Scenario 3) launches. The web UI can also be used independently.

## Usage Examples

### Default Flow: Generate First, Then Offer Interactive Mode
**User:** 帮我生成一张宝可梦风格的美少女。

**AI:** 先直接生成，然后让用户选择下一步：

```
# 1) Generate directly (no Web UI yet)
generate_image(session="demo", prompt="A beautiful girl in Pokemon-style outfit, pastel colors, anime illustration")
← image returned to chat

# 2) Offer choice
"Image generated. What would you like to do next?
  [A] Save it — I'm done
  [B] Open Image Studio to refine, edit, or judge"

# If user chooses B:
open_image_studio(session="demo")  # opens browser with the generated image loaded
← user can now drag-and-drop refs, refine with [pic_N], judge, or edit
```

**Rule of thumb:**
- **Default:** generate → show → offer interactive mode
- **Exception — user already implies human participation:** If the user says things like *"generate a few options for me to choose from"*, *"let me pick the best one"*, or *"I want to compare and decide"* → **skip the offer and go directly to Scenario 3 (MCP HITL)** with `choose_best`. Do not generate first and then ask "do you want to choose?" — the user already asked for it.
- **Exception — user explicitly wants automation:** *"auto-refine until perfect"* → Scenario 2 (MCP Auto-Refine)
- **Exception — user explicitly wants a standalone UI:** *"give me a web interface"* → Scenario 4 (Pure Web)
- Never assume the user wants a browser without asking.

---

### Example 1: SDK Integration — Generate + Store Signature + Refine
**User:** 在自己的应用里集成 Gemini 图像生成，生成一张图，拿到 thoughtSignature，再精调。

**AI:** 用 Scenario 1 —— 直接集成 SDK：

```typescript
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
const model = 'gemini-3.1-flash-image-preview';

// 1) Generate
const gen = await ai.models.generateContent({
  model,
  contents: [{ role: 'user', parts: [
    { inlineData: { data: subjectBase64, mimeType: 'image/png' } },
    { text: 'A red fox in a snowy forest, watercolor style.' },
  ]}],
  config: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: '1:1' } },
});
const parts = gen.candidates?.[0]?.content?.parts ?? [];
const img = parts.find(p => p.inlineData?.mimeType?.startsWith('image/'));
const sig = img?.thoughtSignature;        // ← must store for Refine
const desc = parts.find(p => p.text && !p.thought)?.text?.trim();

// 2) Refine (3-turn structure)
const refine = await ai.models.generateContent({
  model,
  contents: [
    { role: 'user',  parts: turn0Parts },   // same as generation
    { role: 'model', parts: [
      { inlineData: img!.inlineData!, thoughtSignature: sig },
    ]},
    { role: 'user',  parts: [{ text: 'Add falling snowflakes and make the sky overcast.' }] },
  ],
  config: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: '1:1' } },
});
```

`thoughtSignature` 必须原样传回，否则 API 可能拒绝请求。如果签名缺失（如安全过滤），回退到单轮模式——把之前的渲染当作参考图，重新构造单轮 prompt：

```typescript
const sig = img?.thoughtSignature;
if (!sig) {
  // Fallback: treat previous render as a reference image
  const fallbackParts: Part[] = [
    ...turn0Parts,                    // original subject + refs
    { inlineData: img!.inlineData! }, // previous render as reference
    { text: 'Apply the same refinement instruction to this reference image.' },
  ];
  // single-turn generateContent(fallbackParts)
}
```

详见 `references/multiturn.md` 中的完整 fallback 逻辑。

### Example 2: MCP Auto-Refine — Product Photo Iteration
**User:** 用 MCP 工具全自动生成一张产品图，让它自动根据质量评分迭代到合格为止。

**AI:** 用 Scenario 2 —— MCP Auto-Refine Loop：

```
# 1) Start generation with auto-refine enabled
generate_image(
  sessionId="product-42",
  prompt="Professional studio photo of a matte black ceramic coffee cup on polished concrete. Three-point softbox lighting, 45° elevated angle, steam rising.",
  autoRefine=true,
  maxRounds=4,
  aspectRatio="1:1",
  imageSize="2K"
)
← "Auto-refine started."

# 2) Poll until done or error
while (true) {
  status = get_session_status(sessionId="product-42");
  if (status.state === 'done') break;
  if (status.state === 'error') { abort_session(sessionId="product-42"); throw; }
  await sleep(8000);
}

# 3) Export full history with LAAJ scores
export_session(sessionId="product-42")
→ {
  rounds: [
    { id: "r0", scores: { subject_fidelity: 3, lighting_quality: 2, composition: 4 },
      converged: false, topIssue: "lighting too flat" },
    { id: "r1", scores: { subject_fidelity: 4, lighting_quality: 4, composition: 4 },
      converged: true }
  ]
}
```

底层自动跑：generate → LAAJ judge → refine with fix → judge → ... → 所有维度 ≥ 4 或达到 maxRounds。

### Example 3: MCP Human-in-the-Loop — Style A/B + Directed Refine
**User:** 生成两张不同风格的图，让用户选一张，再根据用户输入的指令精修。

**AI:** 用 Scenario 3 —— MCP Human-in-the-Loop：

```
# 1) Generate two style variants in the same session
generate_image(session="style-pick", prompt="A cyberpunk street scene, neon pink and cyan palette, rain-slicked asphalt")
generate_image(session="style-pick", prompt="A cyberpunk street scene, warm amber and deep purple palette, foggy atmosphere")
← Both pushed to browser via SSE

# 2) Get round IDs from status
status = get_session_status(session="style-pick")
# status.rounds[0].id = "r0", status.rounds[1].id = "r1"

# 3) A/B choice — blocks until browser user clicks
choice = choose_best(
  session="style-pick",
  roundA="r0", roundB="r1",
  question="Which color palette fits the brand better?"
)
← "User chose: B (foggy atmosphere)"

# 4) Ask user for specific refinement — blocks until input
instruction = await_input(
  session="style-pick",
  hint="What should change in the selected image?"
)
← "Add a holographic billboard in the background and make the street wetter."

# 5) Refine the chosen round with user's instruction
refine_image(session="style-pick", roundId="r1", instruction=instruction)
← Refined image pushed to browser

# 6) Optional: judge the final result
judge_image(session="style-pick", roundId="r2")
← { scores: { ... }, converged: true }
```

`choose_best` 和 `await_input` 会阻塞直到浏览器端用户响应。SSE 实时推送每个步骤的状态到前端面板。

## References — When to Read What

Don't read all references upfront. Load them based on what you're building right now:

| When you need to... | Read this reference |
|---------------------|---------------------|
| Build parts arrays with images, style refs, guardrails, or `[pic_N]` | `references/examples.md` |
| Choose models, validate aspect ratios/image sizes/thinking levels, or compare 3.1 Flash vs 3 Pro | `references/models.md` |
| Implement multi-turn Refine with `thoughtSignature`, storage rules, or single-turn fallback | `references/multiturn.md` |
| Interleave `[pic_1]` tokens into `text/image/text` parts | `references/interleaving.md` |
| Handle images too large for inlineData (File API caching, TTL, 403 fallback) | `references/file-api-cache.md` |
| Build an automated judge → score → refine loop (LAAJ) | `references/laaj.md` |
| Use `editImage()` with `RawReferenceImage`, `outpainting`, or `upscaleImage()` | `references/advanced-api.md` |
| Stream responses with parts accumulation | `references/streaming.md` |
| Improve this skill itself through eval-driven iteration | `references/skill-evolution.md` |
| Run or modify the Web UI / MCP Server code | `web-ui/` |

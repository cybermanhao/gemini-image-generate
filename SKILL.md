---
name: gemini-imagen-patterns
description: Gemini Image Studio — MCP Server + Web UI for multimodal image generation. Four usage scenarios: auto-refine loop, human-in-the-loop, pure SDK, and pure web.
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
**User:** 我想全自动生成一张图并让它自己迭代优化，该怎么做？

**AI:** 用 Scenario 1 —— Auto-Refine Loop：

```
generate_image(sessionId="abc", prompt="a red fox in snow", autoRefine=true, maxRounds=3)
    ↓
← "Auto-refine started. Poll status with get_session_status."
    ↓
while (status !== 'done') {
  await get_session_status(sessionId="abc");
  await sleep(5000);
}
    ↓
export_session(sessionId="abc") → JSON with all rounds + LAAJ scores
```

底层会自动跑：generate → judge → refine → judge → refine → converged。

### Example 2
**User:** 生成两张图后想让用户选一张更好的，怎么实现？

**AI:** 用 Scenario 2 —— Human-in-the-Loop：

```
roundA = generate_image(session="abc", prompt="fox at noon")
roundB = generate_image(session="abc", prompt="fox at golden hour")
    ↓
choice = choose_best(session="abc", roundA=roundA.id, roundB=roundB.id,
                     question="Which lighting is better?")
    ↓ SSE pushes A/B panel to browser
← user clicks A
← "User chose: A (no reason given)"
    ↓
refine_image(session="abc", roundId=roundA.id, instruction="Add snow background")
```

`choose_best` 和 `await_input` 会阻塞直到浏览器端用户响应。

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

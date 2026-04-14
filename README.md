# gemini-imagen-patterns

A Claude skill for building multimodal image generation pipelines with the `@google/genai` SDK.

## What it covers

- **Parts array construction** — `text`, `inlineData`, `fileData` / `createPartFromUri`
- **Text-image-text interleaving** — `[pic_1]` / `[pic_N]` pattern
- **File API caching** — upload, 47h TTL, 403 fallback to inlineData
- **Multi-turn Refine** — 3-turn structure with `thoughtSignature` injection
- **Thinking config** — `ThinkingLevel` for Gemini 3, `thinkingBudget` for Gemini 2.5
- **LAAJ evaluation loop** — LLM-as-a-Judge with `gemini-2.5-flash`

## Quick start

Install the skill into your Claude skills directory:

```bash
# Clone into your Claude skills path
git clone https://github.com/cybermanhao/gemini-image-generate.git gemini-imagen-patterns
```

Then reference `SKILL.md` as the main entry point when working with Gemini image generation.

## Directory structure

```
├── SKILL.md                      # Main entry point
├── README.md                     # This file
├── references/
│   ├── examples.md               # 13 runnable TypeScript examples
│   ├── models.md                 # Model selection & thinkingConfig
│   ├── interleaving.md           # [pic_N] implementation
│   ├── multiturn.md              # Refine 3-turn + thoughtSignature
│   ├── file-api-cache.md         # File API upload / cache / fallback
│   ├── laaj.md                   # LAAJ loop
│   └── skill-evolution.md        # Using LAAJ to evolve skills
└── web-ui/                       # Demo React + Express UI
```

## Models

| Task | Model |
|------|-------|
| Image generation | `gemini-3.1-flash-image-preview` |
| Vision analysis / LAAJ | `gemini-2.5-flash` |

## License

MIT

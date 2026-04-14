# [pic_N] Text-Image-Text Interleaving

## Why

When a refinement instruction references specific images ("use [pic_1]'s style on [pic_2]"), placing images immediately adjacent to the text that references them reduces ambiguity. The model associates each image with its nearest descriptive text.

Scattered images + one long text block → model may attribute the wrong image to the wrong instruction.
Interleaved text/image/text → unambiguous.

## Implementation

```typescript
/**
 * Expands [pic_1], [pic_2] ... tokens in an instruction string into
 * an interleaved array of text and image Parts.
 *
 * Example:
 *   instruction: "Apply [pic_1]'s palette to [pic_2]'s pose"
 *   picPartMap:  { 1 → imagePartA, 2 → imagePartB }
 *   result:      [{ text: "Apply " }, imagePartA, { text: "'s palette to " }, imagePartB, { text: "'s pose" }]
 */
function interleaveInstructionParts(
  instruction: string,
  picPartMap: Map<number, Part>,
): Part[] {
  const parts: Part[] = [];
  let lastIndex = 0;
  const regex = /\[pic_(\d+)\]/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(instruction)) !== null) {
    const idx = parseInt(match[1], 10);
    const part = picPartMap.get(idx);
    if (!part) continue;  // unknown index → skip, leave token as text

    const before = instruction.slice(lastIndex, match.index);
    if (before) parts.push({ text: before });
    parts.push(part);
    lastIndex = regex.lastIndex;
  }

  const after = instruction.slice(lastIndex);
  if (after) parts.push({ text: after });

  return parts;
}
```

## Building the picPartMap

```typescript
// Inline base64 images (e.g., uploaded by user in the same request)
const picPartMap = new Map<number, Part>();
attachedImages.forEach((b64, i) => {
  picPartMap.set(i + 1, { inlineData: { data: b64, mimeType: 'image/jpeg' } });
});

// File API URIs (e.g., previously uploaded reference images)
picPartMap.set(3, createPartFromUri(cachedUri, 'image/jpeg'));
```

## Edge Cases

- `[pic_0]` — index 0 is valid if you put it in the map; convention is 1-indexed but not enforced
- Unknown index (e.g., `[pic_5]` not in map) — token is silently dropped; text around it is preserved
- Repeated index (e.g., `[pic_1]` twice) — same image part is inserted twice, which is fine
- Empty instruction — returns `[]`
- No tokens in instruction — returns `[{ text: instruction }]`

## Usage in Multi-Turn Refine

In a Refine turn, the user's refinement instruction becomes Turn 2. Build the picPartMap from whatever additional images the user attached to their refinement message:

```typescript
const turn2Parts = interleaveInstructionParts(userRefinementText, picPartMap);
contents = [turn0, turn1, { role: 'user', parts: turn2Parts }];
```

See `references/multiturn.md` for the full 3-turn structure.

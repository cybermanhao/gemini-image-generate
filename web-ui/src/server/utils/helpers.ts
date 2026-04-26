import type { Part } from '@google/genai';

export function interleaveInstructionParts(instruction: string, picMap: Map<number, Part>): Part[] {
  const parts: Part[] = [];
  const regex = /\[pic_(\d+)\]/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(instruction)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ text: instruction.slice(lastIndex, match.index) });
    }
    const picPart = picMap.get(parseInt(match[1], 10));
    if (picPart) parts.push(picPart);
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < instruction.length) {
    parts.push({ text: instruction.slice(lastIndex) });
  }
  return parts;
}

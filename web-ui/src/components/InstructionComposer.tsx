/**
 * Simplified InstructionComposer migrated from importer project.
 * Supports clicking pool items or dragging them into the textarea.
 */
import { useRef, useState } from 'react';

export interface PoolItem {
  id: string;
  label: string;
  src: string;
}

export interface InstructionPart {
  id: string;
  label: string;
  src: string;
  picIndex: number;
}

interface Props {
  instruction: string;
  onInstructionChange: (v: string) => void;
  parts: InstructionPart[];
  onPartsChange: (parts: InstructionPart[]) => void;
  pool: PoolItem[];
  onPoolChange?: (pool: PoolItem[]) => void;
  disabled?: boolean;
  placeholder?: string;
}

export function InstructionComposer({
  instruction,
  onInstructionChange,
  parts,
  onPartsChange,
  pool,
  onPoolChange,
  disabled,
  placeholder = '输入精调指令，可拖拽图片到文本中…',
}: Props) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [poolDragOver, setPoolDragOver] = useState(false);

  function insertPicRef(item: PoolItem) {
    const nextIndex = parts.length > 0 ? Math.max(...parts.map(p => p.picIndex)) + 1 : 1;
    const token = `[pic_${nextIndex}]`;
    const ta = textareaRef.current;
    const cursor = ta?.selectionStart ?? instruction.length;
    const newText = instruction.slice(0, cursor) + token + instruction.slice(cursor);
    onInstructionChange(newText);
    onPartsChange([...parts, { id: item.id, label: item.label, src: item.src, picIndex: nextIndex }]);
    requestAnimationFrame(() => {
      if (ta) {
        const newPos = cursor + token.length;
        ta.setSelectionRange(newPos, newPos);
        ta.focus();
      }
    });
  }

  function removeChip(idx: number) {
    const removed = parts[idx];
    const removedIndex = removed.picIndex;
    let newText = instruction;

    newText = newText.replace(new RegExp(`\\[pic_${removedIndex}\\]`, 'g'), '');
    const higherParts = parts
      .filter(p => p.picIndex > removedIndex)
      .sort((a, b) => b.picIndex - a.picIndex);

    for (const p of higherParts) {
      newText = newText.replace(new RegExp(`\\[pic_${p.picIndex}\\]`, 'g'), `[pic_${p.picIndex - 1}]`);
    }
    onInstructionChange(newText);

    const newParts = parts
      .filter((_, i) => i !== idx)
      .map(p => ({
        ...p,
        picIndex: p.picIndex > removedIndex ? p.picIndex - 1 : p.picIndex,
      }));
    onPartsChange(newParts);
  }

  function togglePoolItem(item: PoolItem) {
    const idx = parts.findIndex(p => p.id === item.id);
    if (idx >= 0) removeChip(idx);
    else insertPicRef(item);
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setDragOver(true);
  }

  function handleDragLeave() {
    setDragOver(false);
  }

  function readFileAsDataURL(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (ev) => resolve(ev.target?.result as string);
      reader.onerror = () => reject(new Error(`读取失败: ${file.name}`));
      reader.readAsDataURL(file);
    });
  }

  async function addFilesToPool(files: FileList | null) {
    if (!files || files.length === 0 || !onPoolChange) return;
    const newItems: PoolItem[] = [];
    for (const file of Array.from(files)) {
      if (!file.type.startsWith('image/')) continue;
      try {
        const dataUrl = await readFileAsDataURL(file);
        const id = `upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        newItems.push({ id, label: file.name.replace(/\.[^/.]+$/, ''), src: dataUrl });
      } catch { /* skip failed */ }
    }
    if (newItems.length > 0) {
      onPoolChange([...pool, ...newItems]);
    }
  }

  function handlePoolFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    addFilesToPool(e.target.files);
    e.target.value = '';
  }

  function handlePoolDragOver(e: React.DragEvent) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setPoolDragOver(true);
  }

  function handlePoolDragLeave() {
    setPoolDragOver(false);
  }

  async function handlePoolDrop(e: React.DragEvent) {
    e.preventDefault();
    setPoolDragOver(false);
    if (disabled) return;
    // If it's a pool item drag (application/json), ignore here — handled by textarea
    if (e.dataTransfer.types.includes('application/json')) return;
    await addFilesToPool(e.dataTransfer.files);
  }

  // ── Smart backspace/delete: delete entire [pic_N] token as one unit ─────────

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (disabled) return;
    const ta = e.currentTarget;
    const cursor = ta.selectionStart ?? 0;
    const endCursor = ta.selectionEnd ?? cursor;

    // Only handle when there's no text selection (collapsed cursor)
    if (cursor !== endCursor) return;

    // BACKSPACE: cursor is right after ']' → find and delete preceding [pic_N]
    if (e.key === 'Backspace' && cursor > 0) {
      const charBefore = instruction[cursor - 1];
      if (charBefore === ']') {
        const textBefore = instruction.slice(0, cursor);
        const match = textBefore.match(/(\[pic_(\d+)\])$/);
        if (match) {
          e.preventDefault();
          const token = match[1];
          const picIndex = parseInt(match[2], 10);
          const newText = instruction.slice(0, cursor - token.length) + instruction.slice(cursor);
          onInstructionChange(newText);
          // Remove corresponding part and renumber
          const newParts = parts
            .filter(p => p.picIndex !== picIndex)
            .map(p => ({
              ...p,
              picIndex: p.picIndex > picIndex ? p.picIndex - 1 : p.picIndex,
            }));
          onPartsChange(newParts);
          // Update textarea cursor position
          requestAnimationFrame(() => {
            const newPos = cursor - token.length;
            ta.setSelectionRange(newPos, newPos);
          });
        }
      }
    }

    // DELETE: cursor is right before '[' → find and delete following [pic_N]
    if (e.key === 'Delete' && cursor < instruction.length) {
      const charAfter = instruction[cursor];
      if (charAfter === '[') {
        const textAfter = instruction.slice(cursor);
        const match = textAfter.match(/^(\[pic_(\d+)\])/);
        if (match) {
          e.preventDefault();
          const token = match[1];
          const picIndex = parseInt(match[2], 10);
          const newText = instruction.slice(0, cursor) + instruction.slice(cursor + token.length);
          onInstructionChange(newText);
          const newParts = parts
            .filter(p => p.picIndex !== picIndex)
            .map(p => ({
              ...p,
              picIndex: p.picIndex > picIndex ? p.picIndex - 1 : p.picIndex,
            }));
          onPartsChange(newParts);
          requestAnimationFrame(() => {
            ta.setSelectionRange(cursor, cursor);
          });
        }
      }
    }
  }

  function handleDrop(e: React.DragEvent<HTMLTextAreaElement>) {
    e.preventDefault();
    setDragOver(false);
    if (disabled) return;
    const json = e.dataTransfer.getData('application/json');
    if (!json) return;
    let item: PoolItem | null = null;
    try {
      item = JSON.parse(json) as PoolItem;
    } catch {
      return;
    }
    if (!item || typeof item.id !== 'string') return;
    const ta = textareaRef.current;
    if (ta) {
      const dropCursor = getTextareaCursorAtPoint(ta, e.clientX, e.clientY);
      if (dropCursor != null) {
        ta.setSelectionRange(dropCursor, dropCursor);
      }
    }
    insertPicRef(item);
  }

  return (
    <div className="flex flex-col gap-2">
      <textarea
        ref={textareaRef}
        value={instruction}
        onChange={e => onInstructionChange(e.target.value)}
        disabled={disabled}
        placeholder={placeholder}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onKeyDown={handleKeyDown}
        className={`min-h-[96px] w-full rounded-md border bg-gray-900 p-3 text-sm text-gray-100 outline-none transition resize-none ${
          dragOver ? 'border-indigo-500 ring-1 ring-indigo-500' : 'border-gray-700 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500'
        } disabled:opacity-50`}
      />

      {parts.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {parts.map((p, i) => (
            <span
              key={i}
              className="inline-flex items-center gap-1.5 rounded-full border border-indigo-500/30 bg-indigo-500/15 px-2 py-1 text-xs text-indigo-200"
            >
              <img src={p.src} alt="" className="h-5 w-5 rounded-full object-cover" />
              <span className="font-mono text-[10px] text-indigo-300/80">[pic_{p.picIndex}]</span>
              <span className="max-w-[100px] truncate">{p.label}</span>
              {!disabled && (
                <button
                  type="button"
                  onClick={() => removeChip(i)}
                  className="ml-0.5 text-indigo-300/70 hover:text-indigo-100"
                >
                  ×
                </button>
              )}
            </span>
          ))}
        </div>
      )}

      <div
        className={`flex flex-wrap gap-2 rounded-md border p-2 transition ${
          poolDragOver
            ? 'border-indigo-500 bg-indigo-500/10 ring-1 ring-indigo-500'
            : 'border-gray-800 bg-gray-900/50'
        }`}
        onDragOver={handlePoolDragOver}
        onDragLeave={handlePoolDragLeave}
        onDrop={handlePoolDrop}
      >
        {pool.map(item => {
          const active = parts.some(p => p.id === item.id);
          return (
            <div
              key={item.id}
              draggable
              onDragStart={e => e.dataTransfer.setData('application/json', JSON.stringify(item))}
              onClick={() => togglePoolItem(item)}
              className={`flex cursor-pointer items-center gap-1.5 rounded border px-2 py-1 text-xs transition select-none ${
                active
                  ? 'border-indigo-500/40 bg-indigo-500/20 text-indigo-200'
                  : 'border-gray-700 bg-gray-800 text-gray-300 hover:border-gray-600 hover:bg-gray-700'
              }`}
            >
              <img src={item.src} alt="" className="h-5 w-5 rounded object-cover" />
              <span className="max-w-[80px] truncate">{item.label}</span>
            </div>
          );
        })}
        {onPoolChange && (
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={disabled}
            className="flex items-center gap-1 rounded border border-dashed border-gray-600 px-2 py-1 text-xs text-gray-400 transition hover:border-gray-500 hover:text-gray-300 disabled:opacity-50"
            title="上传素材"
          >
            <span>+</span>
            <span>素材</span>
          </button>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={handlePoolFileSelect}
        />
      </div>
    </div>
  );
}

function getTextareaCursorAtPoint(ta: HTMLTextAreaElement, x: number, y: number): number | null {
  if ('caretPositionFromPoint' in document) {
    try {
      const pos = (document as any).caretPositionFromPoint(x, y);
      if (pos && pos.offsetNode) {
        if (pos.offsetNode === ta) return Math.min(pos.offset, ta.value.length);
        const rect = ta.getBoundingClientRect();
        if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
          return ta.selectionStart ?? ta.value.length;
        }
      }
    } catch {
      // ignore
    }
  }
  if ('caretRangeFromPoint' in document) {
    try {
      const range = (document as any).caretRangeFromPoint(x, y);
      if (range && range.startContainer === ta) {
        return Math.min(range.startOffset, ta.value.length);
      }
    } catch {
      // ignore
    }
  }
  return null;
}

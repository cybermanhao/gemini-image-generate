import { InstructionComposer, type PoolItem, type InstructionPart } from '../InstructionComposer.tsx';

const QUICK_INSTRUCTIONS = [
  { label: '纯白背景', text: 'Ensure the background is absolutely pure white with no grey tones or gradients.' },
  { label: '增亮', text: 'Make the overall image brighter, increase exposure.' },
  { label: '柔光', text: 'Use softer, more diffused lighting. Reduce harsh shadows and highlights.' },
  { label: '提升锐度', text: 'Make the product edges sharper and more defined.' },
  { label: '增强对比', text: 'Increase contrast slightly for more depth and dimension.' },
];

const ASPECT_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];
const IMAGE_SIZES = ['1K', '2K', '4K'];

interface Props {
  instruction: string;
  onInstructionChange: (v: string) => void;
  instructionParts: InstructionPart[];
  onInstructionPartsChange: (parts: InstructionPart[]) => void;
  pool: PoolItem[];
  onPoolChange: (pool: PoolItem[]) => void;
  aspectRatio: string;
  onAspectRatioChange: (v: string) => void;
  imageSize: string;
  onImageSizeChange: (v: string) => void;
  onRefine: () => void;
  refining: boolean;
  roundTurn: number;
  autoApprove: boolean;
  onAutoApproveChange: (v: boolean) => void;
  onAutoOrganize?: () => void;
  organizing?: boolean;
}

export function RefinePanel({
  instruction, onInstructionChange,
  instructionParts, onInstructionPartsChange,
  pool, onPoolChange,
  aspectRatio, onAspectRatioChange,
  imageSize, onImageSizeChange,
  onRefine, refining, roundTurn,
  autoApprove, onAutoApproveChange,
  onAutoOrganize, organizing,
}: Props) {
  return (
    <div className="rounded-lg border border-indigo-500/30 bg-indigo-500/10 p-4 space-y-3">
      <div className="text-sm font-medium text-indigo-200">精调指令（基于 Round {roundTurn}）</div>

      <div className="flex gap-3">
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-400">纵横比</span>
          <select
            value={aspectRatio}
            onChange={e => onAspectRatioChange(e.target.value)}
            className="rounded border border-gray-700 bg-gray-900 px-2 py-1 text-xs text-gray-200"
          >
            {ASPECT_RATIOS.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-400">图像尺寸</span>
          <select
            value={imageSize}
            onChange={e => onImageSizeChange(e.target.value)}
            className="rounded border border-gray-700 bg-gray-900 px-2 py-1 text-xs text-gray-200"
          >
            {IMAGE_SIZES.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
      </div>

      <div className="flex gap-1 flex-wrap">
        {QUICK_INSTRUCTIONS.map(q => (
          <button
            key={q.label}
            onClick={() => onInstructionChange(q.text)}
            className="text-[10px] px-2 py-1 rounded border border-gray-700 hover:bg-indigo-500/20 hover:border-indigo-400/30 text-gray-300 transition"
          >
            {q.label}
          </button>
        ))}
      </div>

      <InstructionComposer
        instruction={instruction}
        onInstructionChange={onInstructionChange}
        parts={instructionParts}
        onPartsChange={onInstructionPartsChange}
        pool={pool}
        onPoolChange={onPoolChange}
        disabled={refining || organizing}
        onAutoOrganize={onAutoOrganize}
        organizing={organizing}
      />

      <div className="flex items-center gap-3">
        <button
          onClick={onRefine}
          disabled={!instruction.trim() || refining}
          className="rounded bg-indigo-600 px-5 py-2 text-sm font-medium text-white transition hover:bg-indigo-500 disabled:opacity-50"
        >
          {refining ? '精调中…' : '执行精调'}
        </button>
        <label className="flex items-center gap-1.5 text-xs text-gray-400 cursor-pointer">
          <input
            type="checkbox"
            checked={autoApprove}
            onChange={e => onAutoApproveChange(e.target.checked)}
            className="rounded border-gray-700 bg-gray-950 text-indigo-500 focus:ring-indigo-500"
          />
          30秒自动满意
        </label>
      </div>
    </div>
  );
}

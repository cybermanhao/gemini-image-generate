import type { ReverseResult } from '@/lib/api.ts';

interface Props {
  reverseImage: string;
  onReverseFile: (e: React.ChangeEvent<HTMLInputElement>) => void;
  reverseMode: 'text-to-image' | 'image-to-image';
  onReverseModeChange: (mode: 'text-to-image' | 'image-to-image') => void;
  onReverse: () => void;
  reversing: boolean;
  result: ReverseResult | null;
}

export function ReverseTab({
  reverseImage, onReverseFile,
  reverseMode, onReverseModeChange,
  onReverse, reversing,
  result,
}: Props) {
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-gray-800 bg-gray-900 p-4">
        <label className="mb-2 block text-xs font-medium text-gray-400">上传图像进行反推</label>
        <input type="file" accept="image/*" onChange={onReverseFile} />
        {reverseImage && (
          <img src={reverseImage} alt="reverse" className="mt-3 max-h-64 rounded border border-gray-700" />
        )}
      </div>

      <div className="rounded-lg border border-gray-800 bg-gray-900 p-4 space-y-3">
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input
              type="radio"
              name="reverseMode"
              value="text-to-image"
              checked={reverseMode === 'text-to-image'}
              onChange={() => onReverseModeChange('text-to-image')}
              className="accent-indigo-500"
            />
            <span className="text-xs">反推文生图提示词</span>
          </label>
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input
              type="radio"
              name="reverseMode"
              value="image-to-image"
              checked={reverseMode === 'image-to-image'}
              onChange={() => onReverseModeChange('image-to-image')}
              className="accent-indigo-500"
            />
            <span className="text-xs">反推图生图 Segments</span>
          </label>
        </div>
        <button
          onClick={onReverse}
          disabled={!reverseImage || reversing}
          className="rounded bg-indigo-600 px-5 py-2 text-sm font-medium text-white transition hover:bg-indigo-500 disabled:opacity-50"
        >
          {reversing ? '分析中…' : '开始反推'}
        </button>
      </div>

      {result?.textPrompt && (
        <div className="rounded-lg border border-gray-800 bg-gray-900 p-4">
          <h3 className="text-xs font-medium text-gray-400 mb-2">反推结果 — 文生图提示词</h3>
          <pre className="text-xs text-gray-200 whitespace-pre-wrap bg-gray-950 border border-gray-800 rounded p-3">{result.textPrompt}</pre>
        </div>
      )}

      {result?.segments && (
        <div className="rounded-lg border border-gray-800 bg-gray-900 p-4 space-y-3">
          <h3 className="text-xs font-medium text-gray-400 mb-2">反推结果 — 结构化 Segments</h3>
          {Object.entries(result.segments).map(([key, value]) => (
            <div key={key} className="rounded border border-gray-800 bg-gray-950 p-3">
              <div className="text-[10px] uppercase tracking-wide text-indigo-400 mb-1">{key}</div>
              <p className="text-xs text-gray-200">{value}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

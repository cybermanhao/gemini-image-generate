interface Props {
  remainingMs: number;
  totalMs: number;
  onCancel: () => void;
}

export function CountdownBar({ remainingMs, totalMs, onCancel }: Props) {
  const pct = Math.max(0, Math.min(100, (remainingMs / totalMs) * 100));
  const seconds = Math.ceil(remainingMs / 1000);

  return (
    <div className="rounded-lg border border-indigo-500/30 bg-indigo-500/10 p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-xs text-indigo-300">
          ⏱️ 自动满意倒计时 <span className="font-mono font-semibold">{seconds}s</span>
        </div>
        <button
          onClick={onCancel}
          className="rounded border border-indigo-500/30 px-2 py-0.5 text-[10px] text-indigo-300 hover:bg-indigo-500/20 transition"
        >
          取消
        </button>
      </div>
      <div className="h-1.5 w-full rounded-full bg-gray-800 overflow-hidden">
        <div
          className="h-full rounded-full bg-indigo-500 transition-all duration-1000 ease-linear"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

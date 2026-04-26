import type { SessionStatus, SessionMode } from '@/lib/api.ts';

interface Props {
  tab: 'generate' | 'refine' | 'reverse';
  onTabChange: (tab: 'generate' | 'refine' | 'reverse') => void;
  sessionMode: SessionMode;
  sessionStatus: SessionStatus;
  autoRunning: boolean;
  refineCount: number;
  autoMaxRounds: number;
  takingOver: boolean;
  onTakeover: () => void;
  exporting: boolean;
  onExport: () => void;
  canExport: boolean;
  sessionId: string;
}

export function StudioHeader({
  tab, onTabChange,
  sessionMode, sessionStatus, autoRunning,
  refineCount, autoMaxRounds, takingOver, onTakeover,
  exporting, onExport, canExport,
  sessionId,
}: Props) {
  const autoStatusLabel: Record<SessionStatus, string> = {
    idle: '',
    generating: '生成中',
    judging: 'LAAJ 评估中',
    refining: '自动精调中',
    done: '自动闭环完成',
    error: '自动闭环出错',
  };

  return (
    <header className="flex items-center gap-4 border-b border-gray-800 bg-gray-900 px-4 py-3">
      <h1 className="text-sm font-semibold text-gray-200">🎨 Gemini Image Studio</h1>
      <div className="flex gap-2">
        {(['generate', 'refine', 'reverse'] as const).map(t => (
          <button
            key={t}
            onClick={() => onTabChange(t)}
            className={`rounded px-3 py-1 text-xs font-medium transition ${
              tab === t
                ? 'bg-indigo-600 text-white'
                : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
            }`}
          >
            {t === 'generate' ? '生成' : t === 'refine' ? '精调' : '反推'}
          </button>
        ))}
      </div>

      {sessionMode === 'auto' && sessionStatus !== 'idle' && (
        <div className="ml-2 flex items-center gap-2">
          <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
            sessionStatus === 'error' ? 'bg-red-500/20 text-red-400' :
            sessionStatus === 'done' ? 'bg-green-500/20 text-green-400' :
            'bg-amber-500/20 text-amber-400'
          }`}>
            {autoStatusLabel[sessionStatus]}
            {autoRunning && ` · Round ${refineCount + 1}/${autoMaxRounds}`}
          </span>
          {autoRunning && (
            <button
              onClick={onTakeover}
              disabled={takingOver}
              className="rounded border border-orange-500/40 bg-orange-500/10 px-2 py-0.5 text-[10px] text-orange-400 hover:bg-orange-500/20 transition disabled:opacity-50"
            >
              {takingOver ? '中断中…' : '接管控制'}
            </button>
          )}
        </div>
      )}

      <button
        onClick={onExport}
        disabled={exporting || !canExport}
        className="ml-auto mr-2 rounded border border-gray-700 bg-gray-800 px-2 py-0.5 text-[10px] text-gray-300 hover:bg-gray-700 transition disabled:opacity-50"
      >
        {exporting ? '导出中…' : '导出会话'}
      </button>
      <span className="text-[10px] text-gray-500 font-mono">{sessionId.slice(0, 16)}…</span>
    </header>
  );
}

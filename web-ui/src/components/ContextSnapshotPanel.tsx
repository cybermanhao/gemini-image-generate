import { useState, useEffect } from 'react';
import type { ContextSnapshot, TurnSnapshot, PartSnapshot } from '@/lib/api.ts';
import { getContextSnapshot } from '@/lib/api.ts';

interface Props {
  sessionId: string;
}

const LABEL_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  '原图': { bg: 'bg-amber-500/10', text: 'text-amber-400', border: 'border-amber-500/30' },
  '风格参考': { bg: 'bg-violet-500/10', text: 'text-violet-400', border: 'border-violet-500/30' },
  '额外参考': { bg: 'bg-blue-500/10', text: 'text-blue-400', border: 'border-blue-500/30' },
  '新图': { bg: 'bg-emerald-500/10', text: 'text-emerald-400', border: 'border-emerald-500/30' },
  '生成指令': { bg: 'bg-cyan-500/10', text: 'text-cyan-400', border: 'border-cyan-500/30' },
  '基础 Prompt': { bg: 'bg-slate-500/10', text: 'text-slate-400', border: 'border-slate-500/30' },
  '指令文本': { bg: 'bg-cyan-500/10', text: 'text-cyan-400', border: 'border-cyan-500/30' },
  '生成结果': { bg: 'bg-green-500/10', text: 'text-green-400', border: 'border-green-500/30' },
  '精调结果': { bg: 'bg-green-500/10', text: 'text-green-400', border: 'border-green-500/30' },
  '上次渲染结果': { bg: 'bg-orange-500/10', text: 'text-orange-400', border: 'border-orange-500/30' },
  '模型自描述': { bg: 'bg-indigo-500/10', text: 'text-indigo-400', border: 'border-indigo-500/30' },
};

function getLabelColor(label: string) {
  for (const key of Object.keys(LABEL_COLORS)) {
    if (label.includes(key)) return LABEL_COLORS[key];
  }
  return { bg: 'bg-gray-500/10', text: 'text-gray-400', border: 'border-gray-500/30' };
}

function PartBadge({ part }: { part: PartSnapshot }) {
  const colors = getLabelColor(part.label);
  const icon = part.type === 'image' ? '🖼' : '📝';
  return (
    <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] border ${colors.bg} ${colors.text} ${colors.border}`}>
      <span>{icon}</span>
      {part.label}
    </span>
  );
}

function TurnCard({ turn, index }: { turn: TurnSnapshot; index: number }) {
  const [expanded, setExpanded] = useState(index < 2);
  const isUser = turn.type === 'user';
  const isMultiTurnRefine = turn.role === 'refine' && turn.turn >= 2;

  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900/50 overflow-hidden">
      {/* Header */}
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-gray-800/50 transition-colors"
      >
        <span className={`text-[10px] font-mono font-semibold shrink-0 ${isUser ? 'text-cyan-400' : 'text-green-400'}`}>
          {isUser ? 'User' : 'Model'} · Turn {turn.turn}
        </span>
        <span className="text-[10px] text-gray-500">
          {turn.role === 'generate' && '首次生成'}
          {turn.role === 'refine' && (isMultiTurnRefine ? '多轮精调' : '精调')}
          {turn.role === 'model-response' && '模型响应'}
        </span>
        {turn.metadata.thoughtSignature && (
          <span className="ml-auto flex items-center gap-0.5 text-[9px] text-cyan-400" title={`thoughtSignature: ${turn.metadata.thoughtSignature.slice(0, 20)}...`}>
            ⚡ sig
          </span>
        )}
        <span className="text-[10px] text-gray-500 ml-1">{expanded ? '▲' : '▼'}</span>
      </button>

      {/* Body */}
      {expanded && (
        <div className="px-3 pb-3 space-y-2">
          {/* Parts summary */}
          <div className="flex flex-wrap gap-1">
            {turn.parts.map((part, i) => (
              <PartBadge key={i} part={part} />
            ))}
          </div>

          {/* Part details */}
          <div className="space-y-1.5">
            {turn.parts.map((part, i) => {
              const colors = getLabelColor(part.label);
              const icon = part.type === 'image' ? '🖼' : '📝';
              return (
                <div key={i} className={`rounded border ${colors.border} ${colors.bg} p-2`}>
                  <div className="flex items-center gap-1.5 mb-1">
                    <span>{icon}</span>
                    <span className={`text-[10px] font-medium ${colors.text}`}>{part.label}</span>
                    {part.detail && (
                      <span className="text-[9px] text-gray-500 ml-auto">{part.detail}</span>
                    )}
                  </div>
                  {part.type === 'text' && part.content && (
                    <p className="text-[10px] text-gray-300 whitespace-pre-wrap leading-relaxed">
                      {part.content.length > 300 ? part.content.slice(0, 300) + '…' : part.content}
                    </p>
                  )}
                  {part.type === 'image' && (
                    <p className="text-[9px] text-gray-500 italic">图片数据 (base64)</p>
                  )}
                </div>
              );
            })}
          </div>

          {/* Metadata footer */}
          {turn.metadata.modelDescription && (
            <div className="rounded bg-indigo-500/5 border border-indigo-500/20 p-2">
              <p className="text-[9px] text-indigo-400 font-medium mb-0.5">模型自描述</p>
              <p className="text-[10px] text-gray-300 italic">{turn.metadata.modelDescription}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function ContextSnapshotPanel({ sessionId }: Props) {
  const [snapshot, setSnapshot] = useState<ContextSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);

  const fetchSnapshot = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await getContextSnapshot(sessionId);
      if (res.success) {
        setSnapshot(res.snapshot);
      } else {
        setError('获取快照失败');
      }
    } catch (err: any) {
      setError(err.message ?? '网络错误');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (visible) {
      fetchSnapshot();
    }
  }, [visible, sessionId]);

  // Auto-refresh when new rounds arrive (poll every 5s while visible)
  useEffect(() => {
    if (!visible) return;
    const interval = setInterval(fetchSnapshot, 5000);
    return () => clearInterval(interval);
  }, [visible, sessionId]);

  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900 overflow-hidden">
      {/* Toggle header */}
      <button
        onClick={() => setVisible(v => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-gray-800 transition-colors"
      >
        <span className="text-xs">{visible ? '👁' : '👁‍🗨'}</span>
        <span className="text-xs font-medium text-gray-200">上下文快照</span>
        <span className="text-[10px] text-gray-500 ml-auto">
          {snapshot ? `${snapshot.currentStatus.totalTurns} turns · ${snapshot.currentStatus.totalImages} images` : '点击展开'}
        </span>
      </button>

      {/* Content */}
      {visible && (
        <div className="px-3 pb-3 space-y-3 border-t border-gray-800">
          {/* Status bar */}
          {snapshot && (
            <div className="flex items-center gap-3 pt-2">
              <span className={`text-[10px] px-2 py-0.5 rounded-full border ${
                snapshot.currentStatus.mode === 'multi-turn'
                  ? 'bg-cyan-500/10 border-cyan-500/30 text-cyan-400'
                  : 'bg-amber-500/10 border-amber-500/30 text-amber-400'
              }`}>
                {snapshot.currentStatus.mode === 'multi-turn' ? (
                  <span className="flex items-center gap-1">⚡ 真实多轮</span>
                ) : (
                  <span className="flex items-center gap-1">⚠ 单轮模式</span>
                )}
              </span>
              <span className="text-[10px] text-gray-500">
                thoughtSignature: {snapshot.currentStatus.hasValidThoughtSignature ? '✓ 有效' : '✗ 缺失'}
              </span>
              <button
                onClick={fetchSnapshot}
                disabled={loading}
                className="ml-auto text-[10px] text-gray-500 hover:text-gray-300 transition-colors disabled:opacity-50"
              >
                {loading ? '刷新中…' : '刷新'}
              </button>
            </div>
          )}

          {/* Error */}
          {error && (
            <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded px-2 py-1.5">{error}</p>
          )}

          {/* Turns */}
          {snapshot && snapshot.turns.length > 0 && (
            <div className="space-y-2">
              {snapshot.turns.map((turn, i) => (
                <TurnCard key={`${turn.turn}-${turn.type}-${i}`} turn={turn} index={i} />
              ))}
            </div>
          )}

          {/* Empty state */}
          {snapshot && snapshot.turns.length === 0 && (
            <p className="text-xs text-gray-500 py-2">暂无上下文数据。请先生成一张图像。</p>
          )}
        </div>
      )}
    </div>
  );
}

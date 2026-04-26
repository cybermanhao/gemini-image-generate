import type { GenerationRound } from '@/lib/api.ts';

interface Props {
  round: GenerationRound;
  judgeProgress: { roundId: string; partial: string } | null;
  onJudge: (round: GenerationRound) => void;
  judging: boolean;
}

export function RoundDetail({ round, judgeProgress, onJudge, judging }: Props) {
  const isJudgingThis = judgeProgress?.roundId === round.id;

  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900 p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-gray-200">Round {round.turn} 详情</h3>
        <button
          onClick={() => onJudge(round)}
          disabled={judging}
          className="rounded border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-xs text-amber-400 hover:bg-amber-500/20 transition disabled:opacity-50"
        >
          {judging ? '评估中…' : 'LAAJ 评估'}
        </button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <img
            src={`data:image/png;base64,${round.imageBase64}`}
            alt="result"
            className="w-full rounded-lg border border-gray-700"
          />
        </div>
        <div className="space-y-3">
          {round.modelDescription && (
            <div className="rounded bg-gray-950 border border-gray-800 p-3">
              <div className="text-[10px] text-cyan-400 mb-1">模型自描述</div>
              <p className="text-xs text-gray-300 italic">{round.modelDescription}</p>
            </div>
          )}

          {isJudgingThis && (
            <div className="rounded bg-gray-950 border border-amber-500/30 p-3">
              <div className="text-[10px] text-amber-400 mb-1 flex items-center gap-1">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse" />
                LAAJ 评估中…
              </div>
              <pre className="text-xs text-gray-400 whitespace-pre-wrap max-h-40 overflow-y-auto">{judgeProgress!.partial}</pre>
            </div>
          )}

          {round.scores && (
            <div className="grid grid-cols-2 gap-2">
              {Object.entries(round.scores).map(([dim, s]) => (
                <div key={dim} className="rounded border border-gray-800 bg-gray-950 p-2">
                  <div className="text-[10px] uppercase tracking-wide text-gray-500">{dim}</div>
                  <div className="flex items-baseline gap-1">
                    <span className="text-lg font-semibold text-gray-200">{s.score}</span>
                    <span className="text-xs text-gray-500">/ 5</span>
                  </div>
                  <div className="text-xs text-gray-400">{s.notes}</div>
                </div>
              ))}
            </div>
          )}

          {round.topIssues && round.topIssues.length > 0 && (
            <div className="space-y-1">
              <div className="text-[10px] text-gray-500">Issues</div>
              {round.topIssues.map((issue, i) => (
                <div key={i} className="rounded bg-gray-950 border border-gray-800 p-2 text-xs text-gray-300">
                  <span className="text-amber-400">{issue.issue}</span>
                  <br />
                  <span className="text-emerald-400">→ {issue.fix}</span>
                </div>
              ))}
            </div>
          )}

          {round.nextFocus && (
            <div className="text-xs text-gray-400">
              下一轮重点: <span className="text-gray-200">{round.nextFocus}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

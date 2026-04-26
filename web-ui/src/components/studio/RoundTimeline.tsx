import type { GenerationRound } from '@/lib/api.ts';

interface Props {
  rounds: GenerationRound[];
  selectedRoundId: string | null;
  onSelect: (id: string) => void;
}

export function RoundTimeline({ rounds, selectedRoundId, onSelect }: Props) {
  if (rounds.length === 0) return null;
  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900 p-4">
      <h3 className="text-xs font-medium text-gray-400 mb-3">生成历史 · {rounds.length} 轮</h3>
      <div className="flex gap-3 overflow-x-auto pb-2">
        {rounds.map((r) => (
          <button
            key={r.id}
            onClick={() => onSelect(r.id)}
            className={`shrink-0 rounded-lg border p-2 transition text-left w-32 ${
              selectedRoundId === r.id
                ? 'border-indigo-500 ring-1 ring-indigo-500'
                : 'border-gray-700 hover:border-gray-500'
            }`}
          >
            <div className="text-[10px] text-gray-500 mb-1">
              Round {r.turn} · {r.type === 'generate' ? '生成' : r.type === 'refine' ? '精调' : '编辑'}
            </div>
            <img
              src={`data:image/png;base64,${r.imageBase64}`}
              alt=""
              className="w-full aspect-square rounded object-cover bg-gray-950"
            />
            {r.converged && (
              <div className="mt-1 text-[10px] text-green-400">✓ 已收敛</div>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

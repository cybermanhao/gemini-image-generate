import { useEffect, useState } from 'react';

interface Round {
  round: number;
  output: string;
  converged: boolean;
  scores: Record<string, { score: number; notes: string }>;
  next_focus: string;
}

export function DemoView() {
  const [rounds, setRounds] = useState<Round[]>([]);

  useEffect(() => {
    const evtSource = new EventSource('/api/events');
    evtSource.onmessage = (e) => {
      const data = JSON.parse(e.data);
      if (data.type === 'demo-state') {
        const payload = data.payload as { sceneA?: Round[]; sceneB?: Round[] };
        setRounds(payload.sceneA ?? payload.sceneB ?? payload);
      }
    };
    return () => evtSource.close();
  }, []);

  if (rounds.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-gray-500">
        等待演示数据…（通过 POST /api/load-state 推送）
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      {rounds.map((r) => (
        <div key={r.round} className="rounded-lg border border-gray-800 bg-gray-900 p-4">
          <div className="mb-3 flex items-center justify-between">
            <span className="text-sm font-medium text-gray-200">Round {r.round}</span>
            <span
              className={`rounded px-2 py-0.5 text-xs font-medium ${
                r.converged ? 'bg-green-500/20 text-green-300' : 'bg-amber-500/20 text-amber-300'
              }`}
            >
              {r.converged ? '已收敛' : '未收敛'}
            </span>
          </div>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {Object.entries(r.scores).map(([dim, s]) => (
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

          <div className="mt-3 text-xs text-gray-400">
            下一轮重点：<span className="text-gray-200">{r.next_focus}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

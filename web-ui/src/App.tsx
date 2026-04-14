import { useEffect, useState } from 'react';
import { DemoView } from './components/DemoView.tsx';
import { PlayView } from './components/PlayView.tsx';

type Mode = 'demo' | 'play';

export function App() {
  const [mode, setMode] = useState<Mode>(() => {
    const hash = window.location.hash.replace('#', '');
    return (hash === 'demo' || hash === 'play') ? hash : 'play';
  });

  useEffect(() => {
    window.location.hash = mode;
  }, [mode]);

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-4 border-b border-gray-800 bg-gray-900 px-4 py-3">
        <h1 className="text-sm font-semibold text-gray-200">Refine UI</h1>
        <div className="flex gap-2">
          <button
            onClick={() => setMode('play')}
            className={`rounded px-3 py-1 text-xs font-medium transition ${
              mode === 'play'
                ? 'bg-indigo-600 text-white'
                : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
            }`}
          >
            交互模式
          </button>
          <button
            onClick={() => setMode('demo')}
            className={`rounded px-3 py-1 text-xs font-medium transition ${
              mode === 'demo'
                ? 'bg-indigo-600 text-white'
                : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
            }`}
          >
            演示模式
          </button>
        </div>
      </header>
      <main className="flex-1 overflow-auto p-4">
        {mode === 'demo' ? <DemoView /> : <PlayView />}
      </main>
    </div>
  );
}

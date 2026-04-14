import { useEffect, useMemo, useState } from 'react';
import { InstructionComposer, type InstructionPart, type PoolItem } from './InstructionComposer.tsx';

interface OutputImage {
  dataUrl: string;
  thoughtSignature?: string;
}

interface Round {
  round: number;
  prompt: string;
  instruction?: string;
  parts: InstructionPart[];
  outputs: OutputImage[];
  selectedIndex: number;
  converged: boolean;
  scores: Record<string, { score: number; notes: string }>;
  next_focus: string;
  top_issues: Array<{ issue: string; fix: string }>;
}

const FAKE_COLORS = [
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', // red
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5/hPwAHBAIAX0OJ0AAAAABJRU5ErkJggg==', // green-ish
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAGBAIAX0OJ0AAAAABJRU5ErkJggg==', // blue-ish
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z/D/HwAFBQIAX0OJ0AAAAABJRU5ErkJggg==', // yellow-ish
];

interface ExampleAsset {
  name: string;
  url: string;
}

export function PlayView() {
  const [subject, setSubject] = useState<string>('');
  const [refs, setRefs] = useState<string[]>([]);
  const [basePrompt, setBasePrompt] = useState('');
  const [batchSize, setBatchSize] = useState(1);
  const [rounds, setRounds] = useState<Round[]>([]);
  const [loading, setLoading] = useState(false);

  const [instruction, setInstruction] = useState('');
  const [instructionParts, setInstructionParts] = useState<InstructionPart[]>([]);

  const [exampleAssets, setExampleAssets] = useState<ExampleAsset[]>([]);

  const pool = useMemo<PoolItem[]>(() => {
    const items: PoolItem[] = [];
    if (subject) items.push({ id: 'subject', label: '主体图', src: subject });
    refs.forEach((src, i) => items.push({ id: `ref-${i}`, label: `参考${i + 1}`, src }));
    return items;
  }, [subject, refs]);

  const latestRound = rounds[rounds.length - 1];
  const canRefine = latestRound != null && !latestRound.converged;

  useEffect(() => {
    const evtSource = new EventSource('/api/events');
    evtSource.onmessage = (e) => {
      const data = JSON.parse(e.data);
      if (data.type === 'play-init') {
        const p = data.payload as { subject?: string; refs?: string[]; basePrompt?: string };
        if (p.subject) setSubject(p.subject);
        if (p.refs) setRefs(p.refs);
        if (p.basePrompt) setBasePrompt(p.basePrompt);
      }
    };
    return () => evtSource.close();
  }, []);

  useEffect(() => {
    fetch('/api/example-assets-list')
      .then(r => r.json())
      .then((d: { files: string[] }) => {
        setExampleAssets(d.files.map(name => ({ name, url: `/api/example-assets/${encodeURIComponent(name)}` })));
      })
      .catch(() => setExampleAssets([]));
  }, []);

  async function handleGenerate() {
    if (!subject || !basePrompt) return;
    setLoading(true);

    const roundIdx = rounds.length;
    const payload = { step: 'generate', payload: { round: roundIdx, subject, refs, basePrompt, batchSize } };
    await fetch('/api/simulate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });

    await new Promise((r) => setTimeout(r, 600));

    // If we have example assets, try to return a real image (subject or first ref) instead of fake colors
    const simulatedOutputUrl = subject || refs[0];
    const outputs: OutputImage[] = Array.from({ length: batchSize }, (_, i) => {
      if (simulatedOutputUrl && batchSize === 1) {
        return {
          dataUrl: simulatedOutputUrl,
          thoughtSignature: `fake_sig_${roundIdx}_${i}`,
        };
      }
      return {
        dataUrl: `data:image/png;base64,${FAKE_COLORS[i % FAKE_COLORS.length]}`,
        thoughtSignature: `fake_sig_${roundIdx}_${i}`,
      };
    });

    const judgePayload = { step: 'judge', payload: { round: roundIdx } };
    await fetch('/api/simulate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(judgePayload) });

    const converged = roundIdx > 0;
    const scores = {
      identity_preservation: { score: converged ? 4 : 3, notes: 'mostly kept' },
      outfit_fidelity: { score: converged ? 4 : 2, notes: 'colors need tweak' },
      style_consistency: { score: converged ? 5 : 3, notes: 'slight mismatch' },
      overall: { score: converged ? 4 : 3, notes: 'good base' },
    };
    const top_issues = converged
      ? []
      : [{ issue: 'Color palette slightly off', fix: 'Shift clothing colors closer to reference palette' }];

    const newRound: Round = {
      round: roundIdx,
      prompt: basePrompt,
      outputs,
      selectedIndex: 0,
      converged,
      scores,
      next_focus: converged ? 'None — converged' : 'Color palette alignment',
      top_issues,
      parts: [],
    };
    setRounds((prev) => [...prev, newRound]);
    setLoading(false);

    if (!converged && top_issues[0]) {
      setInstruction(top_issues[0].fix);
    }
  }

  async function handleRefine() {
    if (!canRefine || !instruction) return;
    setLoading(true);

    const roundIdx = rounds.length;
    const selected = latestRound.outputs[latestRound.selectedIndex];
    const payload = {
      step: 'refine',
      payload: { round: roundIdx, instruction, parts: instructionParts, acceptedSig: selected.thoughtSignature },
    };
    await fetch('/api/simulate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });

    await new Promise((r) => setTimeout(r, 600));

    const outputs: OutputImage[] = [{
      dataUrl: selected.dataUrl,
      thoughtSignature: `fake_sig_${roundIdx}_0`,
    }];
    const converged = true;
    const scores = {
      identity_preservation: { score: 4, notes: 'kept' },
      outfit_fidelity: { score: 4, notes: 'better' },
      style_consistency: { score: 5, notes: 'consistent' },
      overall: { score: 4, notes: 'good' },
    };

    const newRound: Round = {
      round: roundIdx,
      prompt: basePrompt,
      instruction,
      parts: instructionParts,
      outputs,
      selectedIndex: 0,
      converged,
      scores,
      next_focus: 'None — converged',
      top_issues: [],
    };
    setRounds((prev) => [...prev, newRound]);
    setInstruction('');
    setInstructionParts([]);
    setLoading(false);
  }

  function handleFileChange(type: 'subject' | 'ref', e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const url = reader.result as string;
      if (type === 'subject') setSubject(url);
      else setRefs((prev) => [...prev, url]);
    };
    reader.readAsDataURL(file);
  }

  function selectImage(roundIdx: number, imgIdx: number) {
    setRounds((prev) => prev.map((r, i) => (i === roundIdx ? { ...r, selectedIndex: imgIdx } : r)));
  }

  function loadExampleScenario(scenario: 'pikachu-cosplay' | 'waifu-outfit') {
    const findAsset = (keyword: string) => exampleAssets.find(a => a.name.toLowerCase().includes(keyword))?.url;
    const pikachu = findAsset('pikachu');
    const target = findAsset('gardevoir') || findAsset('pokemon');
    const waifu = findAsset('waifu');

    if (scenario === 'pikachu-cosplay') {
      if (pikachu) setSubject(pikachu);
      if (target) setRefs(target ? [target] : []);
      setBasePrompt(`A cosplay illustration where Pikachu wears the target Pokemon's signature colors, accessories, and key visual motifs, while clearly remaining Pikachu. Maintain cute expression, Pikachu body shape, and electric cheek marks.`);
    } else {
      if (waifu) setSubject(waifu);
      if (target) setRefs(target ? [target] : []);
      setBasePrompt(`A full-body anime character illustration where the character wears a fashion outfit inspired by the target Pokemon's color palette, silhouette, and signature visual motifs. The character must remain the same person from the reference image (same face, hair, body type).`);
    }
    setRounds([]);
    setInstruction('');
    setInstructionParts([]);
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      {exampleAssets.length > 0 && (
        <div className="rounded-lg border border-gray-800 bg-gray-900 p-4">
          <div className="mb-2 text-xs font-medium text-gray-400">示例场景（一键加载素材与 Prompt）</div>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => loadExampleScenario('pikachu-cosplay')}
              className="rounded bg-indigo-600/80 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-indigo-500"
            >
              Scene A: Pikachu Cosplay
            </button>
            <button
              onClick={() => loadExampleScenario('waifu-outfit')}
              className="rounded bg-pink-600/80 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-pink-500"
            >
              Scene B: Waifu Outfit
            </button>
          </div>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-lg border border-gray-800 bg-gray-900 p-4">
          <label className="mb-2 block text-xs font-medium text-gray-400">主体图</label>
          <input type="file" accept="image/*" onChange={(e) => handleFileChange('subject', e)} />
          {subject && <img src={subject} alt="subject" className="mt-2 h-24 w-24 rounded object-cover" />}
        </div>
        <div className="rounded-lg border border-gray-800 bg-gray-900 p-4">
          <label className="mb-2 block text-xs font-medium text-gray-400">参考图（可多张）</label>
          <input type="file" accept="image/*" onChange={(e) => handleFileChange('ref', e)} />
          <div className="mt-2 flex flex-wrap gap-2">
            {refs.map((src, i) => (
              <div key={i} className="relative">
                <img src={src} alt={`ref-${i}`} className="h-16 w-16 rounded object-cover" />
                <button
                  onClick={() => setRefs((prev) => prev.filter((_, idx) => idx !== i))}
                  className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-red-500 text-[10px] text-white"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="rounded-lg border border-gray-800 bg-gray-900 p-4">
        <label className="mb-2 block text-xs font-medium text-gray-400">基础 Prompt</label>
        <textarea
          value={basePrompt}
          onChange={(e) => setBasePrompt(e.target.value)}
          rows={3}
          className="w-full rounded-md border border-gray-700 bg-gray-950 p-2 text-sm text-gray-100 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
          placeholder="描述你想要的生成结果…"
        />
        <div className="mt-2 flex items-center gap-3">
          <button
            onClick={handleGenerate}
            disabled={!subject || !basePrompt || loading}
            className="rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-indigo-500 disabled:opacity-50"
          >
            {loading ? '生成中…' : `生成 ${batchSize} 张`}
          </button>
          <select
            value={batchSize}
            onChange={(e) => setBatchSize(Number(e.target.value))}
            disabled={loading}
            className="rounded border border-gray-700 bg-gray-950 px-2 py-2 text-sm text-gray-100 outline-none focus:border-indigo-500"
          >
            <option value={1}>1 张</option>
            <option value={2}>2 张</option>
            <option value={4}>4 张</option>
          </select>
        </div>
      </div>

      {rounds.map((r, rIdx) => (
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

          <div className="mb-3 flex flex-wrap gap-3">
            {r.outputs.map((out, i) => (
              <button
                key={i}
                onClick={() => selectImage(rIdx, i)}
                className={`relative rounded border p-1 transition ${
                  r.selectedIndex === i
                    ? 'border-indigo-500 ring-1 ring-indigo-500'
                    : 'border-gray-700 hover:border-gray-500'
                }`}
              >
                <img src={out.dataUrl} alt={`out-${i}`} className="h-24 w-24 rounded object-cover" />
                {r.selectedIndex === i && (
                  <div className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full bg-indigo-600 text-[10px] font-bold text-white">
                    ✓
                  </div>
                )}
              </button>
            ))}
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

          {r.top_issues.length > 0 && (
            <div className="mt-3 text-xs text-gray-300">
              <div className="mb-1 text-gray-500">Issues:</div>
              {r.top_issues.map((issue, i) => (
                <div key={i} className="rounded bg-gray-950 p-2 text-gray-300">
                  {issue.issue}
                </div>
              ))}
            </div>
          )}
        </div>
      ))}

      {canRefine && (
        <div className="rounded-lg border border-indigo-500/30 bg-indigo-500/10 p-4">
          <div className="mb-2 text-sm font-medium text-indigo-200">精调指令（基于选中的 Round {latestRound.round} 图片）</div>
          <InstructionComposer
            instruction={instruction}
            onInstructionChange={setInstruction}
            parts={instructionParts}
            onPartsChange={setInstructionParts}
            pool={pool}
            disabled={loading}
          />
          <button
            onClick={handleRefine}
            disabled={!instruction || loading}
            className="mt-3 rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-indigo-500 disabled:opacity-50"
          >
            {loading ? '精调中…' : '执行精调'}
          </button>
        </div>
      )}
    </div>
  );
}

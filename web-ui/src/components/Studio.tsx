import { useState, useEffect, useRef } from 'react';
import type { GenerationRound, JudgeResult, ReverseResult, SessionStatus, SessionMode } from '@/lib/api.ts';
import { generate, refine, judge, reversePrompt, getSession, submitChoice, abortSession, editImage, exportSession } from '@/lib/api.ts';
import type { EditMode } from '@/lib/api.ts';
import { InstructionComposer, type PoolItem, type InstructionPart } from './InstructionComposer.tsx';
import { ContextSnapshotPanel } from './ContextSnapshotPanel.tsx';

type Tab = 'generate' | 'refine' | 'reverse';

const SESSION_ID = new URLSearchParams(window.location.search).get('session') ?? `session-${Date.now()}`;

const QUICK_INSTRUCTIONS = [
  { label: '纯白背景', text: 'Ensure the background is absolutely pure white with no grey tones or gradients.' },
  { label: '增亮', text: 'Make the overall image brighter, increase exposure.' },
  { label: '柔光', text: 'Use softer, more diffused lighting. Reduce harsh shadows and highlights.' },
  { label: '提升锐度', text: 'Make the product edges sharper and more defined.' },
  { label: '增强对比', text: 'Increase contrast slightly for more depth and dimension.' },
];

const ASPECT_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];
const IMAGE_SIZES = ['1K', '2K', '4K'];

export function Studio() {
  const [tab, setTab] = useState<Tab>('generate');

  // ── Generate state ──
  const [subjectImage, setSubjectImage] = useState<string>('');
  const [styleRefImage, setStyleRefImage] = useState<string>('');
  const [prompt, setPrompt] = useState('');
  const [aspectRatio, setAspectRatio] = useState('1:1');
  const [imageSize, setImageSize] = useState('1K');
  const [thinkingLevel, setThinkingLevel] = useState<'minimal' | 'high'>('minimal');
  const [generating, setGenerating] = useState(false);

  // ── Rounds / Refine state ──
  const [rounds, setRounds] = useState<GenerationRound[]>([]);
  const [selectedRoundId, setSelectedRoundId] = useState<string | null>(null);
  const [instruction, setInstruction] = useState('');
  const [instructionParts, setInstructionParts] = useState<InstructionPart[]>([]);
  const [refining, setRefining] = useState(false);
  const [refineAspectRatio, setRefineAspectRatio] = useState('1:1');
  const [refineImageSize, setRefineImageSize] = useState('1K');

  // ── Edit state ──
  const [editMode, setEditMode] = useState<EditMode>('BGSWAP');
  const [editPrompt, setEditPrompt] = useState('');
  const [editing, setEditing] = useState(false);
  const [exporting, setExporting] = useState(false);

  // ── Reverse state ──
  const [reverseImage, setReverseImage] = useState('');
  const [reverseMode, setReverseMode] = useState<'text-to-image' | 'image-to-image'>('text-to-image');
  const [reverseResult, setReverseResult] = useState<ReverseResult | null>(null);
  const [reversing, setReversing] = useState(false);

  // ── Judge state ──
  const [, setJudgeResult] = useState<JudgeResult | null>(null);
  const [judging, setJudging] = useState(false);
  const [judgeProgress, setJudgeProgress] = useState<{ roundId: string; partial: string } | null>(null);

  // ── Auto mode status ──
  const [sessionStatus, setSessionStatus_] = useState<SessionStatus>('idle');
  const [sessionMode, setSessionMode_] = useState<SessionMode>('manual');
  const [autoMaxRounds, setAutoMaxRounds] = useState(3);
  const [takingOver, setTakingOver] = useState(false);

  // ── Human-in-the-loop choices ──
  const [pendingChoice, setPendingChoice] = useState<{ id: string; type: string; payload: any } | null>(null);
  const [choiceReason, setChoiceReason] = useState('');
  const [hitlInstruction, setHitlInstruction] = useState(''); // isolated from refine instruction

  // ── SSE ──
  useEffect(() => {
    getSession(SESSION_ID).then(d => {
      if (d.exists) setRounds(d.rounds);
    });
    // Sync session status on mount
    fetch(`/api/session/${SESSION_ID}/status`)
      .then(r => r.json())
      .then(d => {
        if (d.success) {
          setSessionStatus_(d.status);
          setSessionMode_(d.mode);
          setAutoMaxRounds(d.maxRounds ?? 3);
        }
      })
      .catch(() => {});

    const evt = new EventSource(`/api/events/${SESSION_ID}`);
    evt.onmessage = (e) => {
      const data = JSON.parse(e.data);
      if (data.type === 'round') {
        setRounds(prev => {
          const exists = prev.find(r => r.id === data.round.id);
          if (exists) return prev;
          return [...prev, data.round];
        });
        setSelectedRoundId(data.round.id);
      }
      if (data.type === 'round-updated') {
        setRounds(prev => prev.map(r => r.id === data.round.id ? data.round : r));
        setJudgeProgress(prev => prev?.roundId === data.round.id ? null : prev);
      }
      if (data.type === 'status') {
        setSessionStatus_(data.status as SessionStatus);
      }
      if (data.type === 'error') {
        setSessionStatus_('error');
      }
      if (data.type === 'aborted') {
        setSessionStatus_('idle');
        setSessionMode_('manual');
      }
      if (data.type === 'judge-progress') {
        setJudgeProgress({ roundId: data.roundId, partial: data.partial });
      }
      if (data.type === 'choice-request') {
        setPendingChoice({ id: data.choiceId, type: data.choiceType, payload: data.payload });
      }
    };
    return () => evt.close();
  }, []);

  const selectedRound = rounds.find(r => r.id === selectedRoundId) ?? rounds[rounds.length - 1] ?? null;
  const autoRunning = sessionMode === 'auto' && (sessionStatus === 'generating' || sessionStatus === 'judging' || sessionStatus === 'refining');
  const refineCount = rounds.filter(r => r.type === 'refine').length;
  const canRefine = selectedRound != null && !selectedRound.converged && !autoRunning;
  const canEdit = selectedRound != null && !autoRunning;

  const autoStatusLabel: Record<SessionStatus, string> = {
    idle: '',
    generating: '生成中',
    judging: 'LAAJ 评估中',
    refining: '自动精调中',
    done: '自动闭环完成',
    error: '自动闭环出错',
  };

  // ── Actions ──
  const handleGenerate = async () => {
    if (!prompt.trim()) return;
    setGenerating(true);
    try {
      const res = await generate({
        sessionId: SESSION_ID,
        imageBase64: subjectImage ? toBase64(subjectImage) : undefined,
        prompt: prompt.trim(),
        aspectRatio,
        imageSize,
        thinkingLevel,
        styleRefBase64: styleRefImage ? toBase64(styleRefImage) : undefined,
      });
      setRounds(prev => [...prev, res.round]);
      setSelectedRoundId(res.round.id);
      setTab('refine');
    } catch (err: any) {
      alert(`生成失败: ${err.message ?? String(err)}`);
    } finally {
      setGenerating(false);
    }
  };

  const handleRefine = async () => {
    if (!selectedRound || !instruction.trim()) return;
    setRefining(true);
    try {
      const picMap: Record<number, string> = {};
      instructionParts.forEach(p => {
        picMap[p.picIndex] = toBase64(p.src);
      });
      const res = await refine({
        sessionId: SESSION_ID,
        roundId: selectedRound.id,
        instruction: instruction.trim(),
        newImagesBase64: Object.keys(picMap).length > 0 ? picMap : undefined,
        aspectRatio: refineAspectRatio,
        imageSize: refineImageSize,
      });
      setRounds(prev => [...prev, res.round]);
      setSelectedRoundId(res.round.id);
      setInstruction('');
      setInstructionParts([]);
    } catch (err: any) {
      alert(`精调失败: ${err.message ?? String(err)}`);
    } finally {
      setRefining(false);
    }
  };

  const handleJudge = async (round: GenerationRound) => {
    setJudging(true);
    try {
      const res = await judge({
        imageBase64: round.imageBase64,
        prompt: round.instruction ?? round.prompt,
      });
      setJudgeResult(res.result);
      setRounds(prev => prev.map(r => r.id === round.id ? { ...r, scores: res.result.scores, topIssues: res.result.topIssues, nextFocus: res.result.nextFocus, converged: res.result.converged } : r));
      if (!res.result.converged && res.result.topIssues[0]) {
        alert(`LAAJ: ${res.result.topIssues[0].issue}\n建议: ${res.result.topIssues[0].fix}`);
      }
    } catch (err: any) {
      alert(`评估失败: ${err.message ?? String(err)}`);
    } finally {
      setJudging(false);
    }
  };

  const handleReverse = async () => {
    if (!reverseImage) return;
    setReversing(true);
    try {
      const res = await reversePrompt({
        imageBase64: toBase64(reverseImage),
        mode: reverseMode,
      });
      setReverseResult(res.result);
    } catch (err: any) {
      alert(`反推失败: ${err.message ?? String(err)}`);
    } finally {
      setReversing(false);
    }
  };

  const handleEdit = async () => {
    if (!selectedRound || !editPrompt.trim()) return;
    setEditing(true);
    try {
      const res = await editImage({
        sessionId: SESSION_ID,
        roundId: selectedRound.id,
        prompt: editPrompt.trim(),
        editMode,
      });
      setRounds(prev => [...prev, res.round]);
      setSelectedRoundId(res.round.id);
      setEditPrompt('');
    } catch (err: any) {
      alert(`编辑失败: ${err.message ?? String(err)}`);
    } finally {
      setEditing(false);
    }
  };

  const handleExport = async () => {
    setExporting(true);
    try {
      const res = await exportSession(SESSION_ID);
      if (!res.success) {
        alert('导出失败');
        return;
      }
      const blob = new Blob([JSON.stringify(res.export, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `session-${SESSION_ID.slice(0, 8)}-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err: any) {
      alert(`导出失败: ${err.message ?? String(err)}`);
    } finally {
      setExporting(false);
    }
  };

  const handleTakeover = async () => {
    setTakingOver(true);
    try {
      await abortSession(SESSION_ID);
      // UI update comes via SSE 'aborted' event
    } finally {
      setTakingOver(false);
    }
  };

  const handleChoiceSubmit = async (result: unknown) => {
    if (!pendingChoice) return;
    await submitChoice(pendingChoice.id, result);
    setPendingChoice(null);
    setChoiceReason('');
    setHitlInstruction('');
  };

  const overlayRef = useRef<HTMLDivElement>(null);

  const pool: PoolItem[] = [
    ...(subjectImage ? [{ id: 'subject', label: '主体图', src: subjectImage }] : []),
    ...(styleRefImage ? [{ id: 'style', label: '风格参考', src: styleRefImage }] : []),
  ];

  const toBase64 = (dataUrl: string) => dataUrl.split(',')[1];
  const handleFile = (setter: (s: string) => void) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => setter(ev.target?.result as string);
    reader.onerror = () => alert(`文件读取失败: ${file.name}`);
    reader.readAsDataURL(file);
  };

  return (
    <div className="flex h-full flex-col bg-gray-950 text-gray-100">
      {/* Header */}
      <header className="flex items-center gap-4 border-b border-gray-800 bg-gray-900 px-4 py-3">
        <h1 className="text-sm font-semibold text-gray-200">🎨 Gemini Image Studio</h1>
        <div className="flex gap-2">
          {(['generate', 'refine', 'reverse'] as Tab[]).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
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
        {/* Auto mode status badge + takeover button */}
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
                onClick={handleTakeover}
                disabled={takingOver}
                className="rounded border border-orange-500/40 bg-orange-500/10 px-2 py-0.5 text-[10px] text-orange-400 hover:bg-orange-500/20 transition disabled:opacity-50"
              >
                {takingOver ? '中断中…' : '接管控制'}
              </button>
            )}
          </div>
        )}
        <button
          onClick={handleExport}
          disabled={exporting || rounds.length === 0}
          className="ml-auto mr-2 rounded border border-gray-700 bg-gray-800 px-2 py-0.5 text-[10px] text-gray-300 hover:bg-gray-700 transition disabled:opacity-50"
        >
          {exporting ? '导出中…' : '导出会话'}
        </button>
        <span className="text-[10px] text-gray-500 font-mono">{SESSION_ID.slice(0, 16)}…</span>
      </header>

      <main className="flex-1 overflow-auto p-4">
        <div className="mx-auto max-w-5xl space-y-6">
          {/* ── Generate Tab ── */}
          {tab === 'generate' && (
            <div className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-3">
                <ImageUploadCard label="主体图（可选）" image={subjectImage} onChange={setSubjectImage} onFile={handleFile(setSubjectImage)} />
                <ImageUploadCard label="风格参考（可选）" image={styleRefImage} onChange={setStyleRefImage} onFile={handleFile(setStyleRefImage)} />
                <div className="rounded-lg border border-gray-800 bg-gray-900 p-4 space-y-3">
                  <ConfigSelect label="比例" value={aspectRatio} options={ASPECT_RATIOS} onChange={setAspectRatio} />
                  <ConfigSelect label="尺寸" value={imageSize} options={IMAGE_SIZES} onChange={setImageSize} />
                  <ConfigSelect label="思考深度" value={thinkingLevel} options={['minimal', 'high']} onChange={setThinkingLevel} />
                </div>
              </div>

              <div className="rounded-lg border border-gray-800 bg-gray-900 p-4">
                <textarea
                  value={prompt}
                  onChange={e => setPrompt(e.target.value)}
                  rows={4}
                  className="w-full rounded-md border border-gray-700 bg-gray-950 p-3 text-sm text-gray-100 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 resize-none"
                  placeholder="描述你想要生成的图像…"
                />
                <div className="mt-3 flex items-center gap-3">
                  <button
                    onClick={handleGenerate}
                    disabled={!prompt.trim() || generating}
                    className="rounded bg-indigo-600 px-5 py-2 text-sm font-medium text-white transition hover:bg-indigo-500 disabled:opacity-50"
                  >
                    {generating ? '生成中…' : '生成图像'}
                  </button>
                  {subjectImage && (
                    <span className="text-xs text-gray-500">图生图模式</span>
                  )}
                  {!subjectImage && (
                    <span className="text-xs text-gray-500">文生图模式</span>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* ── Refine Tab ── */}
          {tab === 'refine' && (
            <div className="space-y-4">
              {/* Rounds timeline */}
              {rounds.length > 0 && (
                <div className="rounded-lg border border-gray-800 bg-gray-900 p-4">
                  <h3 className="text-xs font-medium text-gray-400 mb-3">生成历史 · {rounds.length} 轮</h3>
                  <div className="flex gap-3 overflow-x-auto pb-2">
                    {rounds.map((r) => (
                      <button
                        key={r.id}
                        onClick={() => setSelectedRoundId(r.id)}
                        className={`shrink-0 rounded-lg border p-2 transition text-left w-32 ${
                          selectedRoundId === r.id
                            ? 'border-indigo-500 ring-1 ring-indigo-500'
                            : 'border-gray-700 hover:border-gray-500'
                        }`}
                      >
                        <div className="text-[10px] text-gray-500 mb-1">Round {r.turn} · {r.type === 'generate' ? '生成' : '精调'}</div>
                        <img src={`data:image/png;base64,${r.imageBase64}`} alt="" className="w-full aspect-square rounded object-cover bg-gray-950" />
                        {r.converged && (
                          <div className="mt-1 text-[10px] text-green-400">✓ 已收敛</div>
                        )}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Selected round detail */}
              {selectedRound && (
                <div className="rounded-lg border border-gray-800 bg-gray-900 p-4 space-y-4">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-medium text-gray-200">Round {selectedRound.turn} 详情</h3>
                    <div className="flex gap-2">
                      <button
                        onClick={() => handleJudge(selectedRound)}
                        disabled={judging}
                        className="rounded border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-xs text-amber-400 hover:bg-amber-500/20 transition disabled:opacity-50"
                      >
                        {judging ? '评估中…' : 'LAAJ 评估'}
                      </button>
                    </div>
                  </div>

                  <div className="grid gap-4 sm:grid-cols-2">
                    <div>
                      <img src={`data:image/png;base64,${selectedRound.imageBase64}`} alt="result" className="w-full rounded-lg border border-gray-700" />
                    </div>
                    <div className="space-y-3">
                      {selectedRound.modelDescription && (
                        <div className="rounded bg-gray-950 border border-gray-800 p-3">
                          <div className="text-[10px] text-cyan-400 mb-1">模型自描述</div>
                          <p className="text-xs text-gray-300 italic">{selectedRound.modelDescription}</p>
                        </div>
                      )}
                      {judgeProgress?.roundId === selectedRound.id && (
                        <div className="rounded bg-gray-950 border border-amber-500/30 p-3">
                          <div className="text-[10px] text-amber-400 mb-1 flex items-center gap-1">
                            <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse" />
                            LAAJ 评估中…
                          </div>
                          <pre className="text-xs text-gray-400 whitespace-pre-wrap max-h-40 overflow-y-auto">{judgeProgress.partial}</pre>
                        </div>
                      )}
                      {selectedRound.scores && (
                        <div className="grid grid-cols-2 gap-2">
                          {Object.entries(selectedRound.scores).map(([dim, s]) => (
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
                      {selectedRound.topIssues && selectedRound.topIssues.length > 0 && (
                        <div className="space-y-1">
                          <div className="text-[10px] text-gray-500">Issues</div>
                          {selectedRound.topIssues.map((issue, i) => (
                            <div key={i} className="rounded bg-gray-950 border border-gray-800 p-2 text-xs text-gray-300">
                              <span className="text-amber-400">{issue.issue}</span>
                              <br />
                              <span className="text-emerald-400">→ {issue.fix}</span>
                            </div>
                          ))}
                        </div>
                      )}
                      {selectedRound.nextFocus && (
                        <div className="text-xs text-gray-400">
                          下一轮重点: <span className="text-gray-200">{selectedRound.nextFocus}</span>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Auto mode locked notice */}
                  {autoRunning && (
                    <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-300">
                      {autoStatusLabel[sessionStatus]}{` · Round ${refineCount + 1}/${autoMaxRounds}`} — 自动模式运行中，精调已禁用
                    </div>
                  )}

                  {/* Edit controls */}
                  {canEdit && (
                    <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-4 space-y-3">
                      <div className="text-sm font-medium text-emerald-200">图像编辑（基于 Round {selectedRound.turn}）</div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-gray-400">编辑模式</span>
                        <select
                          value={editMode}
                          onChange={e => setEditMode(e.target.value as EditMode)}
                          className="rounded border border-gray-700 bg-gray-900 px-2 py-1 text-xs text-gray-200"
                        >
                          <option value="BGSWAP">换背景（保留主体）</option>
                          <option value="INPAINT_REMOVAL">移除元素</option>
                          <option value="INPAINT_INSERTION">插入元素</option>
                          <option value="STYLE">风格迁移</option>
                        </select>
                      </div>
                      <input
                        type="text"
                        value={editPrompt}
                        onChange={e => setEditPrompt(e.target.value)}
                        placeholder="描述要进行的编辑…"
                        className="w-full rounded border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-200 placeholder-gray-500 focus:border-emerald-500 focus:outline-none"
                      />
                      <button
                        onClick={handleEdit}
                        disabled={!editPrompt.trim() || editing}
                        className="rounded bg-emerald-600 px-5 py-2 text-sm font-medium text-white transition hover:bg-emerald-500 disabled:opacity-50"
                      >
                        {editing ? '编辑中…' : '执行编辑'}
                      </button>
                    </div>
                  )}

                  {/* Refine controls */}
                  {canRefine && (
                    <div className="rounded-lg border border-indigo-500/30 bg-indigo-500/10 p-4 space-y-3">
                      <div className="text-sm font-medium text-indigo-200">精调指令（基于 Round {selectedRound.turn}）</div>

                      {/* Aspect ratio & size for refine */}
                      <div className="flex gap-3">
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-gray-400">纵横比</span>
                          <select value={refineAspectRatio} onChange={e => setRefineAspectRatio(e.target.value)}
                            className="rounded border border-gray-700 bg-gray-900 px-2 py-1 text-xs text-gray-200">
                            {ASPECT_RATIOS.map(r => <option key={r} value={r}>{r}</option>)}
                          </select>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-gray-400">图像尺寸</span>
                          <select value={refineImageSize} onChange={e => setRefineImageSize(e.target.value)}
                            className="rounded border border-gray-700 bg-gray-900 px-2 py-1 text-xs text-gray-200">
                            {IMAGE_SIZES.map(s => <option key={s} value={s}>{s}</option>)}
                          </select>
                        </div>
                      </div>

                      {/* Quick instructions */}
                      <div className="flex gap-1 flex-wrap">
                        {QUICK_INSTRUCTIONS.map(q => (
                          <button key={q.label} onClick={() => setInstruction(q.text)}
                            className="text-[10px] px-2 py-1 rounded border border-gray-700 hover:bg-indigo-500/20 hover:border-indigo-400/30 text-gray-300 transition">
                            {q.label}
                          </button>
                        ))}
                      </div>

                      <InstructionComposer
                        instruction={instruction}
                        onInstructionChange={setInstruction}
                        parts={instructionParts}
                        onPartsChange={setInstructionParts}
                        pool={pool}
                        disabled={refining}
                      />

                      <button
                        onClick={handleRefine}
                        disabled={!instruction.trim() || refining}
                        className="rounded bg-indigo-600 px-5 py-2 text-sm font-medium text-white transition hover:bg-indigo-500 disabled:opacity-50"
                      >
                        {refining ? '精调中…' : '执行精调'}
                      </button>
                    </div>
                  )}
                </div>
              )}
              {/* Context Snapshot Panel */}
              {rounds.length > 0 && (
                <ContextSnapshotPanel sessionId={SESSION_ID} />
              )}

              {rounds.length === 0 && (
                <div className="flex h-48 items-center justify-center text-sm text-gray-500">
                  先生成一张图像，然后在这里进行多轮精调
                </div>
              )}
            </div>
          )}

          {/* ── Reverse Tab ── */}
          {tab === 'reverse' && (
            <div className="space-y-4">
              <div className="rounded-lg border border-gray-800 bg-gray-900 p-4">
                <label className="mb-2 block text-xs font-medium text-gray-400">上传图像进行反推</label>
                <input type="file" accept="image/*" onChange={handleFile(setReverseImage)} />
                {reverseImage && (
                  <img src={reverseImage} alt="reverse" className="mt-3 max-h-64 rounded border border-gray-700" />
                )}
              </div>

              <div className="rounded-lg border border-gray-800 bg-gray-900 p-4 space-y-3">
                <div className="flex items-center gap-4">
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input type="radio" name="reverseMode" value="text-to-image" checked={reverseMode === 'text-to-image'} onChange={() => setReverseMode('text-to-image')} className="accent-indigo-500" />
                    <span className="text-xs">反推文生图提示词</span>
                  </label>
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input type="radio" name="reverseMode" value="image-to-image" checked={reverseMode === 'image-to-image'} onChange={() => setReverseMode('image-to-image')} className="accent-indigo-500" />
                    <span className="text-xs">反推图生图 Segments</span>
                  </label>
                </div>
                <button
                  onClick={handleReverse}
                  disabled={!reverseImage || reversing}
                  className="rounded bg-indigo-600 px-5 py-2 text-sm font-medium text-white transition hover:bg-indigo-500 disabled:opacity-50"
                >
                  {reversing ? '分析中…' : '开始反推'}
                </button>
              </div>

              {reverseResult?.textPrompt && (
                <div className="rounded-lg border border-gray-800 bg-gray-900 p-4">
                  <h3 className="text-xs font-medium text-gray-400 mb-2">反推结果 — 文生图提示词</h3>
                  <pre className="text-xs text-gray-200 whitespace-pre-wrap bg-gray-950 border border-gray-800 rounded p-3">{reverseResult.textPrompt}</pre>
                </div>
              )}

              {reverseResult?.segments && (
                <div className="rounded-lg border border-gray-800 bg-gray-900 p-4 space-y-3">
                  <h3 className="text-xs font-medium text-gray-400 mb-2">反推结果 — 结构化 Segments</h3>
                  {Object.entries(reverseResult.segments).map(([key, value]) => (
                    <div key={key} className="rounded border border-gray-800 bg-gray-950 p-3">
                      <div className="text-[10px] uppercase tracking-wide text-indigo-400 mb-1">{key}</div>
                      <p className="text-xs text-gray-200">{value}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </main>

      {/* ── Human-in-the-loop choice overlay ── */}
      {pendingChoice && (
        <div
          ref={overlayRef}
          tabIndex={-1}
          autoFocus
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 outline-none"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              setPendingChoice(null);
              setChoiceReason('');
              setHitlInstruction('');
            }
          }}
        >
          <div className="w-full max-w-3xl rounded-xl border border-gray-700 bg-gray-900 p-6 shadow-2xl space-y-4">
            {pendingChoice.type === 'ab_compare' && (
              <>
                <h2 className="text-sm font-semibold text-gray-200 text-center">
                  {pendingChoice.payload.question ?? 'Which image do you prefer?'}
                </h2>
                <div className="grid gap-4 sm:grid-cols-2">
                  <button
                    onClick={() => handleChoiceSubmit({ choice: 'A', reason: choiceReason })}
                    className="rounded-lg border border-gray-700 bg-gray-950 p-3 hover:border-indigo-500 transition text-left"
                  >
                    <div className="text-[10px] text-indigo-400 mb-2 text-center">Option A · Round {pendingChoice.payload.optionA?.turn}</div>
                    <img
                      src={`data:image/png;base64,${pendingChoice.payload.optionA?.imageBase64}`}
                      alt="A"
                      className="w-full rounded border border-gray-800"
                    />
                  </button>
                  <button
                    onClick={() => handleChoiceSubmit({ choice: 'B', reason: choiceReason })}
                    className="rounded-lg border border-gray-700 bg-gray-950 p-3 hover:border-indigo-500 transition text-left"
                  >
                    <div className="text-[10px] text-indigo-400 mb-2 text-center">Option B · Round {pendingChoice.payload.optionB?.turn}</div>
                    <img
                      src={`data:image/png;base64,${pendingChoice.payload.optionB?.imageBase64}`}
                      alt="B"
                      className="w-full rounded border border-gray-800"
                    />
                  </button>
                </div>
                <input
                  type="text"
                  value={choiceReason}
                  onChange={e => setChoiceReason(e.target.value)}
                  placeholder="Reason (optional)..."
                  className="w-full rounded-md border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-gray-100 outline-none focus:border-indigo-500"
                />
              </>
            )}

            {pendingChoice.type === 'await_input' && (
              <>
                <h2 className="text-sm font-semibold text-gray-200 text-center">
                  {pendingChoice.payload.hint ?? 'What would you like to change?'}
                </h2>
                <p className="text-xs text-gray-500 text-center">CLI is waiting for your input...</p>
                <textarea
                  rows={3}
                  value={hitlInstruction}
                  onChange={e => setHitlInstruction(e.target.value)}
                  placeholder="Enter your instruction..."
                  className="w-full rounded-md border border-gray-700 bg-gray-950 p-3 text-sm text-gray-100 outline-none focus:border-indigo-500 resize-none"
                />
                <div className="flex justify-end gap-2">
                  <button
                    onClick={() => { setPendingChoice(null); setHitlInstruction(''); }}
                    className="rounded border border-gray-700 px-4 py-2 text-xs text-gray-300 hover:bg-gray-800 transition"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => { handleChoiceSubmit({ instruction: hitlInstruction }); setHitlInstruction(''); }}
                    disabled={!hitlInstruction.trim()}
                    className="rounded bg-indigo-600 px-4 py-2 text-xs text-white hover:bg-indigo-500 transition disabled:opacity-50"
                  >
                    Submit
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function ImageUploadCard({ label, image, onChange, onFile }: {
  label: string;
  image: string;
  onChange: (s: string) => void;
  onFile: (e: React.ChangeEvent<HTMLInputElement>) => void;
}) {
  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900 p-4">
      <label className="mb-2 block text-xs font-medium text-gray-400">{label}</label>
      <input type="file" accept="image/*" onChange={onFile} />
      {image && (
        <div className="mt-2 relative">
          <img src={image} alt="" className="h-32 w-full rounded object-contain bg-gray-950" />
          <button
            onClick={() => onChange('')}
            className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full bg-red-500 text-[10px] text-white"
          >
            ×
          </button>
        </div>
      )}
    </div>
  );
}

function ConfigSelect<T extends string>({ label, value, options, onChange }: {
  label: string;
  value: T;
  options: T[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-xs text-gray-400">{label}</span>
      <select
        value={value}
        onChange={e => onChange(e.target.value as T)}
        className="rounded border border-gray-700 bg-gray-950 px-2 py-1 text-xs text-gray-100 outline-none focus:border-indigo-500"
      >
        {options.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    </div>
  );
}

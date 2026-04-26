import { useState, useEffect } from 'react';
import type { GenerationRound, SessionStatus, SessionMode } from '@/lib/api.ts';
import { generate, refine, judge, reversePrompt, getSession, submitChoice, abortSession, editImage, exportSession } from '@/lib/api.ts';
import { useToast } from '@/hooks/useToast.tsx';
import type { PoolItem, InstructionPart } from './InstructionComposer.tsx';
import { StudioHeader } from './studio/StudioHeader.tsx';
import { GenerateTab } from './studio/GenerateTab.tsx';
import { RefineTab } from './studio/RefineTab.tsx';
import { ReverseTab } from './studio/ReverseTab.tsx';
import { HitlOverlay, type PendingChoice } from './studio/HitlOverlay.tsx';

type Tab = 'generate' | 'refine' | 'reverse';

function getSessionId() {
  return new URLSearchParams(window.location.search).get('session') ?? `session-${Date.now()}`;
}

export function Studio() {
  const { showToast } = useToast();
  const [tab, setTab] = useState<Tab>('generate');

  // ── Generate state ──
  const [subjectImage, setSubjectImage] = useState('');
  const [styleRefImage, setStyleRefImage] = useState('');
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
  const [editPrompt, setEditPrompt] = useState('');
  const [editing, setEditing] = useState(false);
  const [exporting, setExporting] = useState(false);

  // ── Reverse state ──
  const [reverseImage, setReverseImage] = useState('');
  const [reverseMode, setReverseMode] = useState<'text-to-image' | 'image-to-image'>('text-to-image');
  const [reverseResult, setReverseResult] = useState<NonNullable<Awaited<ReturnType<typeof reversePrompt>>['result']> | null>(null);
  const [reversing, setReversing] = useState(false);

  // ── Judge state ──
  const [, setJudgeResult] = useState<Awaited<ReturnType<typeof judge>>['result'] | null>(null);
  const [judging, setJudging] = useState(false);
  const [judgeProgress, setJudgeProgress] = useState<{ roundId: string; partial: string } | null>(null);

  // ── Auto mode status ──
  const [sessionId, setSessionId] = useState(() => getSessionId());
  const [sessionStatus, setSessionStatus] = useState<SessionStatus>('idle');
  const [sessionMode, setSessionMode] = useState<SessionMode>('manual');
  const [autoMaxRounds, setAutoMaxRounds] = useState(3);
  const [takingOver, setTakingOver] = useState(false);

  // ── Human-in-the-loop choices ──
  const [pendingChoice, setPendingChoice] = useState<PendingChoice | null>(null);
  const [choiceReason, setChoiceReason] = useState('');
  const [hitlInstruction, setHitlInstruction] = useState('');

  // ── Material pool ──
  const [materialPool, setMaterialPool] = useState<PoolItem[]>([]);

  const pool: PoolItem[] = [
    ...(subjectImage ? [{ id: 'subject', label: '主体图', src: subjectImage }] : []),
    ...(styleRefImage ? [{ id: 'style', label: '风格参考', src: styleRefImage }] : []),
    ...rounds.map((r, i) => ({
      id: `round-${r.id}`,
      label: `${r.type === 'generate' ? '生成' : r.type === 'refine' ? '精调' : '编辑'} #${i}`,
      src: `data:image/jpeg;base64,${r.imageBase64}`,
    })),
    ...materialPool,
  ];

  const toBase64 = (dataUrl: string) => dataUrl.split(',')[1];

  const handleFile = (setter: (s: string) => void) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => setter(ev.target?.result as string);
    reader.onerror = () => showToast(`文件读取失败: ${file.name}`, 'error');
    reader.readAsDataURL(file);
  };

  // ── SSE & session sync ──
  useEffect(() => {
    const handleUrlChange = () => {
      const newId = getSessionId();
      if (newId !== sessionId) {
        setSessionId(newId);
        setRounds([]);
        setSelectedRoundId(null);
        setSessionStatus('idle');
        setSessionMode('manual');
        setJudgeProgress(null);
        setPendingChoice(null);
      }
    };
    window.addEventListener('popstate', handleUrlChange);

    getSession(sessionId).then(d => {
      if (d.exists) setRounds(d.rounds);
    });
    fetch(`/api/session/${sessionId}/status`)
      .then(r => r.json())
      .then(d => {
        if (d.success) {
          setSessionStatus(d.status);
          setSessionMode(d.mode);
          setAutoMaxRounds(d.maxRounds ?? 3);
        }
      })
      .catch(() => {});

    const evt = new EventSource(`/api/events/${sessionId}`);
    evt.onmessage = (e) => {
      let data: any;
      try {
        data = JSON.parse(e.data);
      } catch {
        console.warn('[sse] malformed event data:', e.data);
        return;
      }
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
        setSessionStatus(data.status as SessionStatus);
      }
      if (data.type === 'error') {
        setSessionStatus('error');
      }
      if (data.type === 'aborted') {
        setSessionStatus('idle');
        setSessionMode('manual');
      }
      if (data.type === 'judge-progress') {
        setJudgeProgress({ roundId: data.roundId, partial: data.partial });
      }
      if (data.type === 'choice-request') {
        const ctype = data.choiceType as string;
        if (ctype === 'ab_compare') {
          setPendingChoice({ id: data.choiceId, type: 'ab_compare', payload: data.payload });
        } else if (ctype === 'await_input') {
          setPendingChoice({ id: data.choiceId, type: 'await_input', payload: data.payload });
        }
      }
    };
    return () => {
      evt.close();
      window.removeEventListener('popstate', handleUrlChange);
    };
  }, [sessionId]);

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
        sessionId,
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
      showToast(`生成失败: ${err.message ?? String(err)}`, 'error');
    } finally {
      setGenerating(false);
    }
  };

  const handleRefine = async () => {
    if (!selectedRound || !instruction.trim()) return;
    setRefining(true);
    try {
      const picMap: Record<number, string> = {};
      instructionParts.forEach(p => { picMap[p.picIndex] = toBase64(p.src); });
      const res = await refine({
        sessionId,
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
      showToast(`精调失败: ${err.message ?? String(err)}`, 'error');
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
      setRounds(prev => prev.map(r => r.id === round.id ? {
        ...r,
        scores: res.result.scores,
        topIssues: res.result.topIssues,
        nextFocus: res.result.nextFocus,
        converged: res.result.converged,
      } : r));
      if (!res.result.converged && res.result.topIssues[0]) {
        showToast(`LAAJ: ${res.result.topIssues[0].issue} — 建议: ${res.result.topIssues[0].fix}`, 'info');
      }
    } catch (err: any) {
      showToast(`评估失败: ${err.message ?? String(err)}`, 'error');
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
      showToast(`反推失败: ${err.message ?? String(err)}`, 'error');
    } finally {
      setReversing(false);
    }
  };

  const handleEdit = async () => {
    if (!selectedRound || !editPrompt.trim()) return;
    setEditing(true);
    try {
      const res = await editImage({
        sessionId,
        roundId: selectedRound.id,
        prompt: editPrompt.trim(),
      });
      setRounds(prev => [...prev, res.round]);
      setSelectedRoundId(res.round.id);
      setEditPrompt('');
    } catch (err: any) {
      showToast(`编辑失败: ${err.message ?? String(err)}`, 'error');
    } finally {
      setEditing(false);
    }
  };

  const handleExport = async () => {
    setExporting(true);
    try {
      const res = await exportSession(sessionId);
      if (!res.success) {
        showToast('导出失败', 'error');
        return;
      }
      const blob = new Blob([JSON.stringify(res.export, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `session-${sessionId.slice(0, 8)}-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err: any) {
      showToast(`导出失败: ${err.message ?? String(err)}`, 'error');
    } finally {
      setExporting(false);
    }
  };

  const handleTakeover = async () => {
    setTakingOver(true);
    try {
      await abortSession(sessionId);
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

  const handleChoiceCancel = () => {
    setPendingChoice(null);
    setChoiceReason('');
    setHitlInstruction('');
  };

  return (
    <div className="flex h-full flex-col bg-gray-950 text-gray-100">
      <StudioHeader
        tab={tab}
        onTabChange={setTab}
        sessionMode={sessionMode}
        sessionStatus={sessionStatus}
        autoRunning={autoRunning}
        refineCount={refineCount}
        autoMaxRounds={autoMaxRounds}
        takingOver={takingOver}
        onTakeover={handleTakeover}
        exporting={exporting}
        onExport={handleExport}
        canExport={rounds.length > 0}
        sessionId={sessionId}
      />

      <main className="flex-1 overflow-auto p-4">
        <div className="mx-auto max-w-5xl space-y-6">
          {tab === 'generate' && (
            <GenerateTab
              subjectImage={subjectImage}
              onSubjectImageChange={setSubjectImage}
              onSubjectFile={handleFile(setSubjectImage)}
              styleRefImage={styleRefImage}
              onStyleRefImageChange={setStyleRefImage}
              onStyleRefFile={handleFile(setStyleRefImage)}
              prompt={prompt}
              onPromptChange={setPrompt}
              aspectRatio={aspectRatio}
              onAspectRatioChange={setAspectRatio}
              imageSize={imageSize}
              onImageSizeChange={setImageSize}
              thinkingLevel={thinkingLevel}
              onThinkingLevelChange={setThinkingLevel}
              onGenerate={handleGenerate}
              generating={generating}
            />
          )}

          {tab === 'refine' && (
            <RefineTab
              rounds={rounds}
              selectedRoundId={selectedRoundId}
              onSelectRound={setSelectedRoundId}
              instruction={instruction}
              onInstructionChange={setInstruction}
              instructionParts={instructionParts}
              onInstructionPartsChange={setInstructionParts}
              pool={pool}
              onPoolChange={setMaterialPool}
              refineAspectRatio={refineAspectRatio}
              onRefineAspectRatioChange={setRefineAspectRatio}
              refineImageSize={refineImageSize}
              onRefineImageSizeChange={setRefineImageSize}
              onRefine={handleRefine}
              refining={refining}
              editPrompt={editPrompt}
              onEditPromptChange={setEditPrompt}
              onEdit={handleEdit}
              editing={editing}
              onJudge={handleJudge}
              judging={judging}
              judgeProgress={judgeProgress}
              sessionStatus={sessionStatus}
              sessionMode={sessionMode}
              autoMaxRounds={autoMaxRounds}
              refineCount={refineCount}
              canRefine={canRefine}
              canEdit={canEdit}
              autoRunning={autoRunning}
              autoStatusLabel={autoStatusLabel}
              sessionId={sessionId}
            />
          )}

          {tab === 'reverse' && (
            <ReverseTab
              reverseImage={reverseImage}
              onReverseFile={handleFile(setReverseImage)}
              reverseMode={reverseMode}
              onReverseModeChange={setReverseMode}
              onReverse={handleReverse}
              reversing={reversing}
              result={reverseResult}
            />
          )}
        </div>
      </main>

      {pendingChoice && (
        <HitlOverlay
          choice={pendingChoice}
          onSubmit={handleChoiceSubmit}
          onCancel={handleChoiceCancel}
          choiceReason={choiceReason}
          onChoiceReasonChange={setChoiceReason}
          hitlInstruction={hitlInstruction}
          onHitlInstructionChange={setHitlInstruction}
        />
      )}
    </div>
  );
}

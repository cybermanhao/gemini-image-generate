import type { GenerationRound, SessionStatus, SessionMode } from '@/lib/api.ts';
import type { PoolItem, InstructionPart } from '../InstructionComposer.tsx';
import { RoundTimeline } from './RoundTimeline.tsx';
import { RoundDetail } from './RoundDetail.tsx';
import { EditPanel } from './EditPanel.tsx';
import { RefinePanel } from './RefinePanel.tsx';
import { ContextSnapshotPanel } from '../ContextSnapshotPanel.tsx';

interface Props {
  rounds: GenerationRound[];
  selectedRoundId: string | null;
  onSelectRound: (id: string) => void;
  instruction: string;
  onInstructionChange: (v: string) => void;
  instructionParts: InstructionPart[];
  onInstructionPartsChange: (parts: InstructionPart[]) => void;
  pool: PoolItem[];
  onPoolChange: (pool: PoolItem[]) => void;
  refineAspectRatio: string;
  onRefineAspectRatioChange: (v: string) => void;
  refineImageSize: string;
  onRefineImageSizeChange: (v: string) => void;
  onRefine: () => void;
  refining: boolean;
  editPrompt: string;
  onEditPromptChange: (v: string) => void;
  onEdit: () => void;
  editing: boolean;
  onJudge: (round: GenerationRound) => void;
  judging: boolean;
  judgeProgress: { roundId: string; partial: string } | null;
  sessionStatus: SessionStatus;
  sessionMode: SessionMode;
  autoMaxRounds: number;
  refineCount: number;
  canRefine: boolean;
  canEdit: boolean;
  autoRunning: boolean;
  autoStatusLabel: Record<SessionStatus, string>;
  sessionId: string;
}

export function RefineTab({
  rounds, selectedRoundId, onSelectRound,
  instruction, onInstructionChange,
  instructionParts, onInstructionPartsChange,
  pool, onPoolChange,
  refineAspectRatio, onRefineAspectRatioChange,
  refineImageSize, onRefineImageSizeChange,
  onRefine, refining,
  editPrompt, onEditPromptChange, onEdit, editing,
  onJudge, judging, judgeProgress,
  sessionStatus, autoMaxRounds, refineCount,
  canRefine, canEdit, autoRunning, autoStatusLabel,
  sessionId,
}: Props) {
  const selectedRound = rounds.find(r => r.id === selectedRoundId) ?? rounds[rounds.length - 1] ?? null;

  return (
    <div className="space-y-4">
      <RoundTimeline rounds={rounds} selectedRoundId={selectedRoundId} onSelect={onSelectRound} />

      {selectedRound && (
        <RoundDetail
          round={selectedRound}
          judgeProgress={judgeProgress}
          onJudge={onJudge}
          judging={judging}
        />
      )}

      {autoRunning && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-300">
          {autoStatusLabel[sessionStatus]} · Round {refineCount + 1}/{autoMaxRounds} — 自动模式运行中，精调已禁用
        </div>
      )}

      {selectedRound && canEdit && (
        <EditPanel
          editPrompt={editPrompt}
          onEditPromptChange={onEditPromptChange}
          onEdit={onEdit}
          editing={editing}
          roundTurn={selectedRound.turn}
        />
      )}

      {selectedRound && canRefine && (
        <RefinePanel
          instruction={instruction}
          onInstructionChange={onInstructionChange}
          instructionParts={instructionParts}
          onInstructionPartsChange={onInstructionPartsChange}
          pool={pool}
          onPoolChange={onPoolChange}
          aspectRatio={refineAspectRatio}
          onAspectRatioChange={onRefineAspectRatioChange}
          imageSize={refineImageSize}
          onImageSizeChange={onRefineImageSizeChange}
          onRefine={onRefine}
          refining={refining}
          roundTurn={selectedRound.turn}
        />
      )}

      {rounds.length > 0 && <ContextSnapshotPanel sessionId={sessionId} />}

      {rounds.length === 0 && (
        <div className="flex h-48 items-center justify-center text-sm text-gray-500">
          先生成一张图像，然后在这里进行多轮精调
        </div>
      )}
    </div>
  );
}

import { useRef } from 'react';

interface ABOption {
  roundId: string;
  turn: number;
  imageBase64: string;
}

type ABComparePayload = { question?: string; optionA?: ABOption; optionB?: ABOption };
type AwaitInputPayload = { hint?: string };

export type PendingChoice =
  | { id: string; type: 'ab_compare'; payload: ABComparePayload }
  | { id: string; type: 'await_input'; payload: AwaitInputPayload };

interface Props {
  choice: PendingChoice;
  onSubmit: (result: unknown) => void;
  onCancel: () => void;
  choiceReason: string;
  onChoiceReasonChange: (v: string) => void;
  hitlInstruction: string;
  onHitlInstructionChange: (v: string) => void;
}

export function HitlOverlay({
  choice, onSubmit, onCancel,
  choiceReason, onChoiceReasonChange,
  hitlInstruction, onHitlInstructionChange,
}: Props) {
  const overlayRef = useRef<HTMLDivElement>(null);

  return (
    <div
      ref={overlayRef}
      tabIndex={-1}
      autoFocus
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 outline-none"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      <div className="w-full max-w-3xl rounded-xl border border-gray-700 bg-gray-900 p-6 shadow-2xl space-y-4">
        {choice.type === 'ab_compare' && (
          <>
            <h2 className="text-sm font-semibold text-gray-200 text-center">
              {choice.payload.question ?? 'Which image do you prefer?'}
            </h2>
            <div className="grid gap-4 sm:grid-cols-2">
              <button
                onClick={() => onSubmit({ choice: 'A', reason: choiceReason })}
                className="rounded-lg border border-gray-700 bg-gray-950 p-3 hover:border-indigo-500 transition text-left"
              >
                <div className="text-[10px] text-indigo-400 mb-2 text-center">
                  Option A · Round {choice.payload.optionA?.turn}
                </div>
                <img
                  src={`data:image/png;base64,${choice.payload.optionA?.imageBase64}`}
                  alt="A"
                  className="w-full rounded border border-gray-800"
                />
              </button>
              <button
                onClick={() => onSubmit({ choice: 'B', reason: choiceReason })}
                className="rounded-lg border border-gray-700 bg-gray-950 p-3 hover:border-indigo-500 transition text-left"
              >
                <div className="text-[10px] text-indigo-400 mb-2 text-center">
                  Option B · Round {choice.payload.optionB?.turn}
                </div>
                <img
                  src={`data:image/png;base64,${choice.payload.optionB?.imageBase64}`}
                  alt="B"
                  className="w-full rounded border border-gray-800"
                />
              </button>
            </div>
            <input
              type="text"
              value={choiceReason}
              onChange={e => onChoiceReasonChange(e.target.value)}
              placeholder="Reason (optional)..."
              className="w-full rounded-md border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-gray-100 outline-none focus:border-indigo-500"
            />
          </>
        )}

        {choice.type === 'await_input' && (
          <>
            <h2 className="text-sm font-semibold text-gray-200 text-center">
              {choice.payload.hint ?? 'What would you like to change?'}
            </h2>
            <p className="text-xs text-gray-500 text-center">CLI is waiting for your input...</p>
            <textarea
              rows={3}
              value={hitlInstruction}
              onChange={e => onHitlInstructionChange(e.target.value)}
              placeholder="Enter your instruction..."
              className="w-full rounded-md border border-gray-700 bg-gray-950 p-3 text-sm text-gray-100 outline-none focus:border-indigo-500 resize-none"
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={onCancel}
                className="rounded border border-gray-700 px-4 py-2 text-xs text-gray-300 hover:bg-gray-800 transition"
              >
                Cancel
              </button>
              <button
                onClick={() => { onSubmit({ instruction: hitlInstruction }); }}
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
  );
}

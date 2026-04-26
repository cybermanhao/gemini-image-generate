interface Props {
  editPrompt: string;
  onEditPromptChange: (v: string) => void;
  onEdit: () => void;
  editing: boolean;
  roundTurn: number;
}

export function EditPanel({ editPrompt, onEditPromptChange, onEdit, editing, roundTurn }: Props) {
  return (
    <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-4 space-y-3">
      <div className="text-sm font-medium text-emerald-200">图像编辑（基于 Round {roundTurn}）</div>
      <input
        type="text"
        value={editPrompt}
        onChange={e => onEditPromptChange(e.target.value)}
        placeholder="描述要进行的编辑…"
        className="w-full rounded border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-200 placeholder-gray-500 focus:border-emerald-500 focus:outline-none"
      />
      <button
        onClick={onEdit}
        disabled={!editPrompt.trim() || editing}
        className="rounded bg-emerald-600 px-5 py-2 text-sm font-medium text-white transition hover:bg-emerald-500 disabled:opacity-50"
      >
        {editing ? '编辑中…' : '执行编辑'}
      </button>
    </div>
  );
}

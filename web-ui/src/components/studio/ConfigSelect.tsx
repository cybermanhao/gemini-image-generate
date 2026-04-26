interface Props<T extends string> {
  label: string;
  value: T;
  options: T[];
  onChange: (v: T) => void;
}

export function ConfigSelect<T extends string>({ label, value, options, onChange }: Props<T>) {
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

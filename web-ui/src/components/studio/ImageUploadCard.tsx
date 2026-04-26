interface Props {
  label: string;
  image: string;
  onChange: (s: string) => void;
  onFile: (e: React.ChangeEvent<HTMLInputElement>) => void;
}

export function ImageUploadCard({ label, image, onChange, onFile }: Props) {
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
            aria-label="清除图片"
          >
            ×
          </button>
        </div>
      )}
    </div>
  );
}

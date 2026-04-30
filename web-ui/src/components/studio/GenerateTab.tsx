import { ImageUploadCard } from './ImageUploadCard.tsx';
import { ConfigSelect } from './ConfigSelect.tsx';

const ASPECT_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];
const IMAGE_SIZES = ['1K', '2K', '4K'];

interface Props {
  subjectImage: string;
  onSubjectImageChange: (v: string) => void;
  onSubjectFile: (e: React.ChangeEvent<HTMLInputElement>) => void;
  styleRefImage: string;
  onStyleRefImageChange: (v: string) => void;
  onStyleRefFile: (e: React.ChangeEvent<HTMLInputElement>) => void;
  prompt: string;
  onPromptChange: (v: string) => void;
  aspectRatio: string;
  onAspectRatioChange: (v: string) => void;
  imageSize: string;
  onImageSizeChange: (v: string) => void;
  thinkingLevel: 'minimal' | 'high';
  onThinkingLevelChange: (v: 'minimal' | 'high') => void;
  autoApprove: boolean;
  onAutoApproveChange: (v: boolean) => void;
  onGenerate: () => void;
  generating: boolean;
}

export function GenerateTab({
  subjectImage, onSubjectImageChange, onSubjectFile,
  styleRefImage, onStyleRefImageChange, onStyleRefFile,
  prompt, onPromptChange,
  aspectRatio, onAspectRatioChange,
  imageSize, onImageSizeChange,
  thinkingLevel, onThinkingLevelChange,
  autoApprove, onAutoApproveChange,
  onGenerate, generating,
}: Props) {
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-3">
        <ImageUploadCard label="主体图（可选）" image={subjectImage} onChange={onSubjectImageChange} onFile={onSubjectFile} />
        <ImageUploadCard label="风格参考（可选）" image={styleRefImage} onChange={onStyleRefImageChange} onFile={onStyleRefFile} />
        <div className="rounded-lg border border-gray-800 bg-gray-900 p-4 space-y-3">
          <ConfigSelect label="比例" value={aspectRatio} options={ASPECT_RATIOS} onChange={onAspectRatioChange} />
          <ConfigSelect label="尺寸" value={imageSize} options={IMAGE_SIZES} onChange={onImageSizeChange} />
          <ConfigSelect label="思考深度" value={thinkingLevel} options={['minimal', 'high']} onChange={onThinkingLevelChange} />
        </div>
      </div>

      <div className="rounded-lg border border-gray-800 bg-gray-900 p-4">
        <textarea
          value={prompt}
          onChange={e => onPromptChange(e.target.value)}
          rows={4}
          className="w-full rounded-md border border-gray-700 bg-gray-950 p-3 text-sm text-gray-100 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 resize-none"
          placeholder="描述你想要生成的图像…"
        />
        <div className="mt-3 flex items-center gap-3">
          <button
            onClick={onGenerate}
            disabled={!prompt.trim() || generating}
            className="rounded bg-indigo-600 px-5 py-2 text-sm font-medium text-white transition hover:bg-indigo-500 disabled:opacity-50"
          >
            {generating ? '生成中…' : '生成图像'}
          </button>
          {subjectImage ? (
            <span className="text-xs text-gray-500">图生图模式</span>
          ) : (
            <span className="text-xs text-gray-500">文生图模式</span>
          )}
          <label className="flex items-center gap-1.5 text-xs text-gray-400 cursor-pointer">
            <input
              type="checkbox"
              checked={autoApprove}
              onChange={e => onAutoApproveChange(e.target.checked)}
              className="rounded border-gray-700 bg-gray-950 text-indigo-500 focus:ring-indigo-500"
            />
            30秒自动满意
          </label>
        </div>
      </div>
    </div>
  );
}

/**
 * Reverse Prompt 批量评估脚本
 *
 * 用法：
 *   npx tsx evals/reverse-eval/run.ts
 *
 * 流程：
 *   1. 读取 ./images/ 目录下的所有图片
 *   2. 对每个图片调用 /api/reverse（text-to-image 和 image-to-image 两种模式）
 *   3. 将结果保存到 ./results/{timestamp}/
 *
 * 前置条件：
 *   - web-ui/server.ts 在运行（默认端口 3456）
 *   - GEMINI_API_KEY 有有效配额
 */

import { readdir, readFile, mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const IMAGES_DIR = join(__dirname, 'images');
const RESULTS_DIR = join(__dirname, 'results');
const API_BASE = 'http://localhost:3456';

interface ReverseResult {
  textPrompt?: string;
  segments?: Record<string, string>;
}

interface EvalRecord {
  imageName: string;
  imageBase64: string;
  timestamp: string;
  textToImage: ReverseResult | { error: string };
  imageToImage: ReverseResult | { error: string };
}

async function toBase64(filePath: string): Promise<string> {
  const buffer = await readFile(filePath);
  return buffer.toString('base64');
}

async function callReverse(imageBase64: string, mode: 'text-to-image' | 'image-to-image'): Promise<ReverseResult> {
  const res = await fetch(`${API_BASE}/api/reverse`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ imageBase64, mode }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`HTTP ${res.status}: ${body.error ?? res.statusText}`);
  }
  const data = await res.json();
  return data.result;
}

async function main() {
  // Check images directory
  let files: string[];
  try {
    files = (await readdir(IMAGES_DIR)).filter(f => /\.(jpe?g|png|webp)$/i.test(f));
  } catch {
    console.error(`[eval] Images directory not found: ${IMAGES_DIR}`);
    console.error('[eval] Please create the directory and place test images inside.');
    process.exit(1);
  }

  if (files.length === 0) {
    console.error(`[eval] No images found in ${IMAGES_DIR}`);
    process.exit(1);
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = join(RESULTS_DIR, timestamp);
  await mkdir(outDir, { recursive: true });

  const records: EvalRecord[] = [];

  for (const file of files) {
    const filePath = join(IMAGES_DIR, file);
    console.log(`[eval] Processing: ${file}`);

    const imageBase64 = await toBase64(filePath);

    let textToImage: ReverseResult | { error: string };
    let imageToImage: ReverseResult | { error: string };

    try {
      textToImage = await callReverse(imageBase64, 'text-to-image');
      console.log(`  -> text-to-image: ${(textToImage as ReverseResult).textPrompt?.slice(0, 60) ?? 'N/A'}...`);
    } catch (err: any) {
      textToImage = { error: err.message ?? String(err) };
      console.error(`  -> text-to-image ERROR: ${err.message ?? String(err)}`);
    }

    try {
      imageToImage = await callReverse(imageBase64, 'image-to-image');
      const segs = (imageToImage as ReverseResult).segments;
      console.log(`  -> image-to-image: ${segs ? Object.keys(segs).join(', ') : 'N/A'}`);
    } catch (err: any) {
      imageToImage = { error: err.message ?? String(err) };
      console.error(`  -> image-to-image ERROR: ${err.message ?? String(err)}`);
    }

    records.push({
      imageName: file,
      imageBase64,
      timestamp: new Date().toISOString(),
      textToImage,
      imageToImage,
    });
  }

  const outPath = join(outDir, 'results.json');
  await writeFile(outPath, JSON.stringify(records, null, 2));

  console.log(`\n[eval] Done. Results saved to: ${outPath}`);
  console.log(`[eval] Next step: npx tsx evals/reverse-eval/analyze.ts ${outPath}`);
}

main().catch(err => {
  console.error('[eval] Fatal:', err);
  process.exit(1);
});

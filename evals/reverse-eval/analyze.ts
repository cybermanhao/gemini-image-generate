/**
 * Reverse Prompt 结果分析脚本
 *
 * 用法：
 *   npx tsx evals/reverse-eval/analyze.ts <results.json>
 *
 * 输出：
 *   在 results.json 同级目录生成 report-{date}.md
 */

import { readFile, writeFile } from 'fs/promises';
import { join, dirname, basename } from 'path';

interface ReverseResult {
  textPrompt?: string;
  segments?: Record<string, string>;
}

interface EvalRecord {
  imageName: string;
  timestamp: string;
  textToImage: ReverseResult | { error: string };
  imageToImage: ReverseResult | { error: string };
}

function isError(r: ReverseResult | { error: string }): r is { error: string } {
  return 'error' in r;
}

function generateReport(records: EvalRecord[]): string {
  const date = new Date().toISOString().slice(0, 10);

  let md = `# Reverse Prompt 评估报告\n\n`;
  md += `**生成日期**: ${date}  \n`;
  md += `**样本数**: ${records.length}  \n\n`;
  md += `---\n\n`;

  // Summary stats
  const textOk = records.filter(r => !isError(r.textToImage)).length;
  const imgOk = records.filter(r => !isError(r.imageToImage)).length;

  md += `## 概览\n\n`;
  md += `| 模式 | 成功 | 失败 | 成功率 |\n`;
  md += `|------|------|------|--------|\n`;
  md += `| text-to-image | ${textOk} | ${records.length - textOk} | ${((textOk / records.length) * 100).toFixed(0)}% |\n`;
  md += `| image-to-image | ${imgOk} | ${records.length - imgOk} | ${((imgOk / records.length) * 100).toFixed(0)}% |\n\n`;
  md += `---\n\n`;

  // Per-image detail
  md += `## 逐样本详情\n\n`;
  for (const r of records) {
    md += `### ${r.imageName}\n\n`;

    md += `#### text-to-image 反推\n\n`;
    if (isError(r.textToImage)) {
      md += `**错误**: ${r.textToImage.error}\n\n`;
    } else {
      md += `\`\`\`\n${r.textToImage.textPrompt ?? '(empty)'}\n\`\`\`\n\n`;
    }

    md += `#### image-to-image 反推\n\n`;
    if (isError(r.imageToImage)) {
      md += `**错误**: ${r.imageToImage.error}\n\n`;
    } else if (r.imageToImage.segments) {
      md += `\`\`\`json\n${JSON.stringify(r.imageToImage.segments, null, 2)}\n\`\`\`\n\n`;
    } else {
      md += `*(no segments)*\n\n`;
    }

    md += `#### 人工评分（请在此填写）\n\n`;
    md += `| 维度 | 分数 (1-5) | 备注 |\n`;
    md += `|------|-----------|------|\n`;
    md += `| Fidelity | | |\n`;
    md += `| Completeness | | |\n`;
    md += `| Actionability | | |\n`;
    md += `| Specificity | | |\n`;
    md += `| **加权总分** | | |\n\n`;
    md += `---\n\n`;
  }

  // Decision template
  md += `## 决策建议\n\n`;
  md += `> 请根据人工评分结果填写以下结论。\n\n`;
  md += `| 指标 | 值 |\n`;
  md += `|------|-----|\n`;
  md += `| 平均 Fidelity | |\n`;
  md += `| 平均 Completeness | |\n`;
  md += `| 平均 Actionability | |\n`;
  md += `| 平均 Specificity | |\n`;
  md += `| **平均总分** | |\n\n`;
  md += `### 决策\n\n`;
  md += `- [ ] 质量达标（≥ 4.0），保持现有实现\n`;
  md += `- [ ] 优化 prompt 模板（3.0–3.9）\n`;
  md += `- [ ] 换用更强模型 gemini-2.5-pro（2.0–2.9）\n`;
  md += `- [ ] 考虑放弃或多模型投票（< 2.0）\n\n`;
  md += `### 备注\n\n`;
  md += `（记录观察到的模式、失败案例、改进建议等）\n`;

  return md;
}

async function main() {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error('[analyze] Usage: npx tsx evals/reverse-eval/analyze.ts <results.json>');
    process.exit(1);
  }

  const raw = await readFile(inputPath, 'utf-8');
  const records: EvalRecord[] = JSON.parse(raw);

  const report = generateReport(records);
  const outPath = join(dirname(inputPath), `report-${new Date().toISOString().slice(0, 10)}.md`);
  await writeFile(outPath, report);

  console.log(`[analyze] Report generated: ${outPath}`);
  console.log(`[analyze] Next step: Open the report, fill in manual scores, and make a decision.`);
}

main().catch(err => {
  console.error('[analyze] Fatal:', err);
  process.exit(1);
});

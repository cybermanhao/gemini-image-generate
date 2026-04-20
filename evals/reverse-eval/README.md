# P4 — 反推（Reverse Prompt）质量评估

## 目的

评估当前 `gemini-2.5-flash` 反推质量，决策是否需要：
- 换用更强模型（`gemini-2.5-pro`）
- 优化 prompt 模板
- 保持现状

## 文件结构

```
evals/reverse-eval/
├── README.md          # 本文件
├── rubric.md          # 评分标准和决策阈值
├── run.ts             # 批量评估脚本
├── analyze.ts         # 结果分析脚本
├── images/            # 测试图片（放这里）
└── results/           # 输出目录（自动生成）
    └── {timestamp}/
        ├── results.json
        └── report-{date}.md
```

## 使用流程

### 1. 准备测试图片

将测试图片放入 `images/` 目录：

```bash
mkdir -p evals/reverse-eval/images
cp your-test-images/*.jpg evals/reverse-eval/images/
```

建议准备 3-5 张覆盖不同场景的图片（产品、角色、风景、美食、抽象）。

### 2. 确保服务器运行

```bash
cd web-ui
npm start          # 默认端口 3456
```

### 3. 运行评估

```bash
npx tsx evals/reverse-eval/run.ts
```

脚本会：
- 读取 `images/` 下所有图片
- 对每个图片调用 `/api/reverse`（text-to-image 和 image-to-image 两种模式）
- 保存结果到 `results/{timestamp}/results.json`

### 4. 生成报告

```bash
npx tsx evals/reverse-eval/analyze.ts evals/reverse-eval/results/{timestamp}/results.json
```

生成 `report-{date}.md`，包含：
- 成功率统计
- 每个样本的反推结果（两种模式）
- **人工评分表格**（需要手动填写）
- 决策建议模板

### 5. 人工评分

打开生成的 `report-{date}.md`，按 `rubric.md` 的四个维度为每个样本打分：

| 维度 | 权重 |
|------|------|
| Fidelity（保真度）| 30% |
| Completeness（完整性）| 25% |
| Actionability（可执行性）| 25% |
| Specificity（具体性）| 20% |

### 6. 做决策

根据加权平均分：

| 总分 | 决策 |
|------|------|
| ≥ 4.0 | 达标，保持 |
| 3.0–3.9 | 优化 prompt |
| 2.0–2.9 | 换更强模型 |
| < 2.0 | 考虑放弃/多模型投票 |

## 注意事项

- **需要有效 API 配额**：`run.ts` 会调用真实 API，free tier 配额用完时会报错
- **图片隐私**：测试图片的 base64 会完整保存在 `results.json` 中，注意敏感内容
- **Fidelity 验证**：如需验证反推 prompt 的保真度，需将 text-to-image 结果喂回 `generate_image()` 重新生成，人工对比原图和重绘图

# Reverse Prompt 质量评估标准

## 评估目标

判断当前 `gemini-2.5-flash` 的反推质量是否达标，以及是否需要：
- 换用更强的模型（如 `gemini-2.5-pro`）
- 优化 prompt 模板
- 引入多模型投票机制

## 测试图片集

| # | 文件名 | 类型 | 难度 | 说明 |
|---|--------|------|------|------|
| 1 | `product-white-bg.jpg` | 产品摄影 | 低 | 纯白背景、单一主体、布光清晰 |
| 2 | `character-anime.jpg` | 角色插画 | 中 | 动漫风格、色彩丰富、有背景元素 |
| 3 | `landscape-sunset.jpg` | 风景摄影 | 中 | 自然场景、氛围光照、复杂构图 |
| 4 | `food-flatlay.jpg` | 美食平铺 | 低 | 俯拍、多主体、道具搭配 |
| 5 | `abstract-art.jpg` | 抽象艺术 | 高 | 非写实、风格化、难以文字描述 |

> 图片放在 `./images/` 目录下。如果没有真实生成图，可以用版权自由的示例图或之前成功生成的图片。

## 评估维度

### 1. Fidelity（保真度）— 权重 30%

反推的 prompt 如果直接用于生成，能否得到与原图**高度相似**的结果？

| 分数 | 标准 |
|------|------|
| 5 | 重新生成后几乎无法区分与原图 |
| 4 | 主体、风格、构图基本一致，细节有微小偏差 |
| 3 | 主体正确，但风格或氛围有明显差异 |
| 2 | 主体类别正确，但具体特征偏差较大 |
| 1 | 重新生成后与原始图完全不像 |

**验证方法**：将反推 prompt 喂回 `generate_image()`，人工对比原图和重绘图。

### 2. Completeness（完整性）— 权重 25%

prompt 是否覆盖了图像的所有关键视觉维度？

检查清单（text-to-image 模式）：
- [ ] 主体（subject）是什么？
- [ ] 风格（style）如何描述？
- [ ] 光照（lighting）类型？
- [ ] 构图（composition）特点？
- [ ] 背景（background）描述？
- [ ] 色彩（color palette）倾向？
- [ ] 情绪/氛围（mood）？

检查清单（image-to-image 模式）：
- [ ] identity
- [ ] canvas
- [ ] environment
- [ ] view
- [ ] material
- [ ] style
- [ ] quality

| 分数 | 标准 |
|------|------|
| 5 | 所有维度都有明确描述 |
| 4 | 遗漏 1 个次要维度 |
| 3 | 遗漏 2 个维度 |
| 2 | 遗漏 3 个以上维度 |
| 1 | 仅描述了主体，其他均未提及 |

### 3. Actionability（可执行性）— 权重 25%

prompt 是否可以直接用于生成，不需要大量人工修改？

| 分数 | 标准 |
|------|------|
| 5 | 直接复制粘贴即可生成高质量图 |
| 4 | 需要微调 1-2 个细节 |
| 3 | 需要补充部分关键描述 |
| 2 | 需要重写一半以上内容 |
| 1 | 基本不可用，需要完全重写 |

### 4. Specificity（具体性）— 权重 20%

描述是否足够具体、有信息量，而非空洞的形容词堆砌？

**正面示例**：
- "soft diffused studio lighting from the left, subtle shadow on the right side"
- "ceramic mug with matte glaze, off-white color, visible handle texture"

**负面示例**：
- "good lighting"
- "nice style"
- "beautiful background"

| 分数 | 标准 |
|------|------|
| 5 | 几乎所有描述都包含具体、可操作的细节 |
| 4 | 大部分描述具体，少数空洞 |
| 3 | 一半具体一半空洞 |
| 2 | 大部分描述缺乏具体性 |
| 1 | 全是空洞形容词 |

## 评估流程

```
1. 准备图片 -> ./images/
2. 运行 npx tsx evals/reverse-eval/run.ts
3. 运行 npx tsx evals/reverse-eval/analyze.ts
4. 人工审阅 ./results/report-{date}.md
5. 决策：保持 / 换模型 / 优化 prompt
```

## 决策阈值

| 平均总分 | 决策 |
|----------|------|
| ≥ 4.0 | 质量达标，保持现有实现 |
| 3.0–3.9 | 优化 prompt 模板，增加 few-shot 示例 |
| 2.0–2.9 | 换用更强的模型（gemini-2.5-pro） |
| < 2.0 | 考虑多模型投票或放弃反推功能 |

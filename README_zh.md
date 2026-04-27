[English](README.md)

# gemini-imagen-patterns

基于 `@google/genai` SDK 的多模态图像生成 Claude Skill + MCP Server。

包含 **Gemini Image Studio** —— 可视化 Web UI，支持交互式生成、多轮精调和 LAAJ 评估。

## 两种使用模式

### 1. CLI + SSE 模式（人机协同）

MCP Server 作为 CLI Agent 与 Web 浏览器之间的桥梁。

```
CLI (Kimi / Claude)          MCP Server               Browser (Web UI)
     │                            │                            │
     ├─ open_image_studio() ────►│─── SSE ───────────────────►│  打开标签页
     │                            │                            │
     ├─ generate_image() ───────►│─── SSE ───────────────────►│  显示结果
     │                            │                            │
     ├─ choose_best(A, B) ──────►│─── SSE choice-request ────►│  弹出 A/B 对比
     │◄───────────────────────────│◄── POST /api/choice ──────┤  用户点击选择
     │                            │                            │
     ├─ refine_image() ─────────►│─── SSE ───────────────────►│  显示精调结果
```

### 2. 纯 Web 模式（可视化模拟器）

无需 CLI，直接在浏览器中打开 Studio：

```bash
npm start
# 打开 http://localhost:3456
```

## 快速开始

```bash
cd web-ui
cp .env.example .env   # 填写 GEMINI_API_KEY
npm install
npm start              # http://localhost:3456
```

**MCP 连接：**
```json
{
  "mcpServers": {
    "gemini-image-studio": {
      "url": "http://localhost:3456/mcp/sse"
    }
  }
}
```

完整工具列表和场景指南 → [SKILL.md](SKILL.md)

## 使用示例

### 示例 1：生成宝可梦角色（文生图）

使用 [PokéAPI](https://pokeapi.co/) 构建结构化提示词：

```typescript
const pokemon = await fetch('https://pokeapi.co/api/v2/pokemon/pikachu').then(r => r.json());
const prompt = `A cute ${pokemon.types.map(t => t.type.name).join('/')}-type Pokemon named ${pokemon.name}, ${pokemon.height / 10}m tall, ${pokemon.weight / 10}kg, yellow fur, red cheeks, lightning bolt tail, full body portrait, clean white background, anime style, high detail`;
```

粘贴到 **生成** 标签页，选择比例 `1:1`、尺寸 `2K`，然后生成：

![生成标签页 — 宝可梦提示词](screenshots/02-generate-pokemon.png)

### 示例 2：反推 Waifu 图像（图生文）

从 [waifu.pics](https://waifu.pics/) 获取随机动漫图片：

```bash
curl -s https://api.waifu.pics/sfw/waifu | jq -r '.url'
```

上传到 **反推** 标签页：

![反推标签页 — Waifu 图片](screenshots/03-reverse-waifu.png)

### 示例 3：多轮精调 + LAAJ

生成后切换到 **精调** 标签页。选中任意一轮可 **评估**（LAAJ 打分）、**编辑**（像素级）或 **精调**（基于 `thoughtSignature` 和 `[pic_N]` 拖拽）：

![精调标签页 — pic_N 拖拽](screenshots/05-picn-dragdrop.png)

## Web UI 功能

| 标签页 | 功能 |
|--------|------|
| **生成** | 上传主体图/风格参考（可选），写提示词，选择比例/尺寸/思考深度，生成 |
| **精调** | 生成历史时间轴 → 选中 round → 评估 / 编辑 / 精调，支持快捷指令和 `[pic_N]` 拖拽 |
| **反推** | 上传图片 → 反推纯文本提示词或结构化分段（identity、canvas、environment、view、material、style、quality） |

核心能力：Parts 数组构造 · `[pic_N]` 图文交错 · `thoughtSignature` 多轮精调 · File API 缓存 · LAAJ 评估循环 · SSE 人机协同

## 项目结构

```
├── SKILL.md              # 主入口：4 个使用场景 + SDK 模式
├── references/           # 详细文档：示例、模型、多轮精调、LAAJ
└── web-ui/               # Gemini Image Studio（Express + MCP SSE + React）
```

## License

MIT

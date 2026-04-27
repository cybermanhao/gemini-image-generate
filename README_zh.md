[English](README.md)

# gemini-imagen-patterns

基于 `@google/genai` SDK 构建多模态图像生成流水线的 Claude Skill + MCP Server。

现已包含 **Gemini Image Studio** —— 一个可视化 Web UI + MCP Server，支持交互式图像生成与多轮精调。

## 涵盖内容

- **Parts 数组构造** —— `text`、`inlineData`、`fileData` / `createPartFromUri`
- **图文交错** —— `[pic_1]` / `[pic_N]` 模式
- **File API 缓存** —— 上传、47小时 TTL、403 降级为 inlineData
- **多轮精调 (Multi-turn Refine)** —— 三回合结构，注入 `thoughtSignature`
- **思考配置** —— Gemini 3 使用 `ThinkingLevel`，Gemini 2.5 使用 `thinkingBudget`
- **LAAJ 评估循环** —— LLM-as-a-Judge，使用 `gemini-2.5-flash`
- **人机协同 (Human-in-the-loop)** —— CLI 触发决策，浏览器 UI 通过 SSE 收集人工输入

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

将其作为 Gemini 图像生成的可视化游乐场 —— 上传图片、编写提示词、精调结果、使用 LAAJ 评估，全部在一个页面完成。

## 快速开始

### 前置条件

- Node.js 18+
- Gemini API key

### 安装与运行

```bash
cd web-ui
# 复制并填写你的 API key
cp .env.example .env
# 编辑 .env: GEMINI_API_KEY=your_key_here

# 安装依赖
npm install

# 启动服务器（同时提供 MCP SSE + Web UI）
npm start
```

服务器启动在 `http://localhost:3456`：
- Web UI: `http://localhost:3456`
- MCP SSE 端点: `http://localhost:3456/mcp/sse`
- MCP 消息端点: `http://localhost:3456/mcp/message`

### 连接 MCP 客户端

配置你的 MCP 客户端（Claude Desktop、Kimi CLI 等）通过 SSE 连接：

```json
{
  "mcpServers": {
    "gemini-image-studio": {
      "url": "http://localhost:3456/mcp/sse"
    }
  }
}
```

## 使用示例

### 示例 1：生成宝可梦角色（文生图）

使用 [PokéAPI](https://pokeapi.co/) 的数据构建丰富、结构化的提示词：

```typescript
const pokemon = await fetch('https://pokeapi.co/api/v2/pokemon/pikachu').then(r => r.json());
const prompt = `A cute ${pokemon.types.map(t => t.type.name).join('/')}-type Pokemon named ${pokemon.name}, ${pokemon.height / 10}m tall, ${pokemon.weight / 10}kg, yellow fur, red cheeks, lightning bolt tail, full body portrait, clean white background, anime style, high detail`;
```

将提示词粘贴到 **生成** 标签页，选择比例 `1:1`、尺寸 `2K`，然后点击 **生成图像**：

![生成标签页 — 空状态](screenshots/01-generate-empty.png)

![生成标签页 — 填入宝可梦提示词](screenshots/02-generate-pokemon.png)

### 示例 2：反推 Waifu 图像（图生文）

从 [waifu.pics](https://waifu.pics/) 获取一张随机动漫图片：

```bash
curl -s https://api.waifu.pics/sfw/waifu | jq -r '.url'
```

上传到 **反推** 标签页并选择模式：

- **反推文生图提示词** —— 获取纯文本的文生图提示词
- **反推图生图 Segments** —— 获取结构化分段（identity、canvas、environment、view、material、style、quality）

![反推标签页 — 已上传 Waifu 图片](screenshots/03-reverse-waifu.png)

### 示例 3：多轮精调 + LAAJ

生成图像后，切换到 **精调** 标签页：

![精调标签页 — 空状态](screenshots/04-refine-empty.png)

当存在生成记录后，时间轴会展示每一轮的缩略图。选中任意一轮可执行：

1. **评估 (Judge)** —— 运行 LAAJ 评估（打分 + 改进建议）
2. **编辑 (Edit)** —— 使用自然语言提示词进行像素级编辑
3. **精调 (Refine)** —— 基于 `thoughtSignature` 和 `[pic_N]` 拖拽的多轮精调

## MCP 工具

| 工具 | 说明 |
|------|------|
| `open_image_studio` | 在浏览器中打开 Web UI，返回会话 URL |
| `generate_image` | 生成图像（文生图或图生图） |
| `refine_image` | 使用 `thoughtSignature` 进行多轮精调 |
| `judge_image` | 对生成图像运行 LAAJ 评估 |
| `choose_best` | 通过 Web UI 让用户从两张图中选择。**阻塞直到用户做出选择。** |
| `await_input` | 在 Web UI 中等待用户输入精调指令。**阻塞直到收到输入。** |

## CLI 工作流示例

```text
> open_image_studio
← Image Studio 已打开: http://localhost:3456?session=abc-123

> generate_image(session="abc-123", prompt="A watercolor painting of a fox")
← Round 0 完成。（自动出现在浏览器中）

> generate_image(session="abc-123", prompt="Same fox, but at golden hour")
← Round 1 完成。

> choose_best(session="abc-123", roundA="<round0-id>", roundB="<round1-id>", question="Which lighting is better?")
← SSE 推送选择面板到浏览器...
← 用户点击 A
← "User chose: A (no reason given)"

> refine_image(session="abc-123", roundId="<round0-id>", instruction="Add lavender field background")
← Round 2 完成。

> judge_image(session="abc-123", imageBase64="...", prompt="...")
← LAAJ 分数: composition 4/5, lighting 5/5, overall 4/5
```

## Web UI 功能

### 生成标签页
- 上传主体图（可选）用于图生图
- 上传风格参考图（可选）
- 配置纵横比、图像尺寸、思考深度
- 编写提示词并生成

### 精调标签页
- 可视化生成历史缩略图
- 选择任意一轮作为精调基础
- **接受 / 拒绝 / 继续** 工作流
- 快捷指令按钮（纯白背景、增亮、柔光等）
- `[pic_N]` 拖拽式指令编辑器
- LAAJ 评估分数卡片
- CLI 操作的实时 SSE 同步

### 反推标签页
- 上传图像反推其提示词
- 模式 A：纯文本的文生图提示词
- 模式 B：结构化分段（identity、canvas、environment、view、material、style、quality）

## 目录结构

```
├── SKILL.md                      # 主入口（模式与文档）
├── README.md                     # 英文 README
├── README_zh.md                  # 中文 README
├── references/                   # 详细参考文档
│   ├── examples.md               # 13 个可运行的 TypeScript 示例
│   ├── models.md                 # 模型选择与 thinkingConfig
│   ├── interleaving.md           # [pic_N] 实现
│   ├── multiturn.md              # 精调 3 回合 + thoughtSignature
│   ├── file-api-cache.md         # File API 上传 / 缓存 / 降级
│   ├── laaj.md                   # LAAJ 循环
│   └── skill-evolution.md        # 使用 LAAJ 进化 Skill
└── web-ui/                       # Gemini Image Studio（MCP Server + React UI）
    ├── server.ts                 # Express + MCP HTTP transport + Gemini API
    ├── src/
    │   ├── App.tsx               # 入口
    │   ├── components/
    │   │   ├── Studio.tsx        # Studio 主容器
    │   │   ├── studio/           # 子组件（Header、Tabs、Panels）
    │   │   └── InstructionComposer.tsx  # [pic_N] 拖拽编辑器
    │   ├── hooks/
    │   │   └── useToast.tsx      # Toast 通知系统
    │   └── lib/
    │       └── api.ts            # 前端 API 客户端
    ├── package.json
    └── ...
```

## 模型

| 任务 | 模型 |
|------|------|
| 图像生成 | `gemini-3-pro-image-preview` |
| 视觉分析 / LAAJ | `gemini-2.5-flash` |

## License

MIT

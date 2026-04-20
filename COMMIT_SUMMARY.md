# Commit Summary — gemini-image-generate

> 本次工作周期：P0–P3 核心功能落地 + editImage + 会话导出 + MCP 同步 + Review 修复 + Session 清理
> 共 **13 个 commit**，基于 `bb59ef7`（feat(e2e): add scenario-based Playwright tests）之后

---

## Commit 列表（按时间顺序）

### 1. `575c7ab` — feat(core): P0-P3 agent auto-loop, session state machine, abort, error handling, judge streaming/cache

**文件**: `web-ui/server.ts`, `web-ui/src/lib/api.ts`

**核心内容**:
- 会话状态机：`idle | generating | judging | refining | done | error`
- 自动精调循环 `runAutoRefine()`：`generate -> judge -> refine` 直到收敛或 `maxRounds`
- 标准化错误码：`CONTENT_POLICY`, `TIMEOUT`, `MODEL_ERROR`, `RATE_LIMIT`, `INVALID_INPUT`
- `classifyError()` 智能分类异常
- `withGeminiCall()` 超时包装器（120s）+ AbortSignal 转发
- AbortController 软中断：`/api/session/:id/abort`，优雅清理 judge cache
- Judge streaming：`generateContentStream` + SSE `judge-progress` 推送
- Judge context caching：`ai.caches.create/delete` 跨 round 复用
- REST API 新增：`GET /api/session/:id/status`、`POST /api/generate` 支持 `autoRefine`/`maxRounds`
- API 客户端新增：`SessionStatus`, `SessionMode`, `ErrorCode`, `abortSession()`, `getSessionStatus()`

---

### 2. `ba18e55` — feat(ui): auto-mode status badge, judge-progress streaming, takeover button

**文件**: `web-ui/src/components/Studio.tsx`

**核心内容**:
- 自动模式状态 badge：琥珀色脉冲动画 + Round 计数器
- Judge 进度实时面板：SSE `judge-progress` 事件驱动，显示流式 JSON 累积
- "接管控制"按钮：调用 `/api/session/:id/abort` 中断 auto loop
- autoRunning 时禁用精调和编辑控件，防止冲突
- 页面挂载时同步会话状态（`/api/session/:id/status`）
- SSE 事件处理：`status`, `error`, `aborted`, `judge-progress`, `round-updated`

---

### 3. `31163c2` — docs: add abort/streaming/caching/advanced-api references, update SKILL.md and models

**文件**: `SKILL.md`, `references/models.md`, `references/abort.md`, `references/streaming.md`, `references/caching.md`, `references/advanced-api.md`

**核心内容**:
- `SKILL.md` 重写：更精确的 skill 触发描述、模型列表更新、parts ordering 三大规则
- `references/abort.md`：AbortSignal / 超时 / 用户中断 / 软接管模式
- `references/streaming.md`：`generateContentStream` 用于 thought progress 和 judge live output
- `references/caching.md`：`ai.caches` 跨 refine round 复用 judge prompt
- `references/advanced-api.md`：`editImage` 模式（BGSWAP, INPAINT_REMOVAL）、`countTokens`、`upscaleImage`、`personGeneration`
- `references/models.md`：模型能力和 thinkingConfig 按家族分类

---

### 4. `0f48f6f` — chore: add skill evals and update gitignore

**文件**: `evals/evals.json`, `.gitignore`

**核心内容**:
- `evals/evals.json`：3 个 skill eval 用例（multiturn-refine / parts-guardrail / laaj-loop）
- `.gitignore`：排除 `.claude/`、`.weixin-sync-buf.json`、`test-results/`

---

### 5. `a172779` — fix(core): classifyError misclassified 429 as CONTENT_POLICY; add auto-mode E2E test

**文件**: `web-ui/server.ts`, `web-ui/e2e/studio.spec.ts`

**核心内容**:
- **Bug 修复**：`classifyError` 把 429 配额错误误判为 `CONTENT_POLICY`
  - 根因：Google API 429 错误消息包含 `generate_content`，命中了 `msg.includes('content')`
  - 修复：`RATE_LIMIT` 检查提前到 `CONTENT_POLICY` 之前；去掉宽泛的 `content` 单独匹配
- E2E 测试：`agent auto mode: generate and auto-refine until converged`
  - 真实 API 调用，10 分钟轮询，验证完整闭环
  - 失败时打印 `status.error` 调试信息

---

### 6. `c4b69e6` — feat(edit): add editImage integration via Imagen 3

**文件**: `web-ui/server.ts`, `web-ui/src/components/Studio.tsx`, `web-ui/src/lib/api.ts`

**核心内容**:
- 后端：`/api/edit` 端点 + `doEdit()` 调用 `ai.models.editImage()`
  - 模型：`imagen-3.0-capability-001`
  - 4 种模式：BGSWAP、INPAINT_REMOVAL、INPAINT_INSERTION、STYLE
  - 自动 mask 选择：BACKGROUND（BGSWAP）、SEMANTIC（removal/insertion）、DEFAULT（STYLE）
  - Edit round 类型为 `'edit'`，存入 session 历史
- 前端：Studio.tsx 新增 emerald 主题 Edit 面板
  - 模式选择器 + prompt 输入 + 执行按钮
  - autoRunning 时禁用
- API 客户端：`EditMode` 类型 + `editImage()` 函数

---

### 7. `ef4fc23` — feat(export): add session export as JSON

**文件**: `web-ui/server.ts`, `web-ui/src/components/Studio.tsx`, `web-ui/src/lib/api.ts`

**核心内容**:
- 后端：`GET /api/session/:id/export` 返回完整会话数据（含所有 rounds）
- 前端：Header "导出会话"按钮
  - `handleExport()` 生成 Blob，触发浏览器下载
  - 无 rounds 时自动禁用
  - 文件名：`session-{id前8位}-{日期}.json`
- API 客户端：`exportSession()`

---

### 8. `9a6f59a` — feat(mcp): sync MCP tools with new capabilities

**文件**: `web-ui/server.ts`

**核心内容**:
- `generate_image`：新增 `autoRefine`/`maxRounds` 参数
  - `autoRefine=true` 时 fire-and-forget 启动 auto loop
  - 返回轮询指令，提示 agent 使用 `get_session_status`
- 新增 MCP tools：
  - `edit_image`：Imagen 3 编辑（4 种模式）
  - `get_session_status`：轮询 auto-refine 进度
  - `abort_session`：软中断活跃 auto loop
  - `export_session`：JSON 导出会话数据
- MCP handler 复用现有核心函数：`withGeminiCall`、`runAutoRefine`、`classifyError` 等

---

### 9. `6574d21` — docs(SKILL.md): update MCP tools table with new capabilities

**文件**: `SKILL.md`

**核心内容**:
- `generate_image` 描述增加 `autoRefine` + `get_session_status` 轮询模式说明
- MCP tools 表格补充：`edit_image`、`get_session_status`、`abort_session`、`export_session`

---

### 10. `a8fca7b` — feat(eval): add P4 reverse prompt quality assessment framework

**文件**: `evals/reverse-eval/README.md`、`rubric.md`、`run.ts`、`analyze.ts`、`images/.gitkeep`

**核心内容**:
- `rubric.md`：4 维度评分标准
  - Fidelity（保真度）30%、Completeness（完整性）25%、Actionability（可执行性）25%、Specificity（具体性）20%
  - 决策阈值：≥4.0 保持 / 3.0–3.9 优化 prompt / 2.0–2.9 换模型 / <2.0 放弃
- `run.ts`：批量评估脚本，读取 `images/` 下图片，调用 `/api/reverse` 两种模式
- `analyze.ts`：生成 markdown 报告，含成功率统计、逐样本详情、人工评分表格模板
- `README.md`：完整使用指南（图片准备 -> 批量跑 -> 生成报告 -> 人工评分 -> 决策）
- `images/.gitkeep`：测试图片目录占位

---

### 11. `9c3fd52` — fix(review): address critical issues from code review

**文件**: `web-ui/server.ts`, `web-ui/src/components/Studio.tsx`, `web-ui/src/lib/api.ts`

**核心内容**:
- `api.ts`：`GenerationRound.type` 联合类型缺少 `'edit'`（与后端不同步）
- `server.ts/runAutoRefine`：空数组保护，防止 `undefined.id` 崩溃
- `server.ts/withGeminiCall`：`.finally()` 中 `removeEventListener` 清理 abort 监听器，修复内存泄漏
- `server.ts/MCP refine_image`：添加 auto-mode busy 检查，与 REST `/api/refine` 409 行为对齐
- `Studio.tsx/SSE`：`JSON.parse` 包 `try/catch`，忽略 malformed 事件

---

### 12. `e09b94c` — fix(review): CORS, base64 validation, choice types, editMode validation

**文件**: `web-ui/server.ts`, `web-ui/src/components/Studio.tsx`

**核心内容**:
- CORS：从 `app.use(cors())` 改为 `cors({ origin: ALLOWED_ORIGIN || localhost })`
- `isValidBase64()` 辅助函数：长度检查、字符集验证、拒绝 data URL
  - 在 `/api/generate`、`/api/reverse`、`/api/judge` 端点启用验证
- `Studio.tsx/pendingChoice`：payload 从 `any` 改为判别联合类型
  - `ab_compare` | `await_input`，启用 TypeScript 类型收窄
- `editMode`：REST `/api/edit` 和 MCP `edit_image` 双路径增加运行时枚举校验

---

### 13. `7efb11f` — feat(cleanup): add session TTL cleanup to prevent unbounded memory growth

**文件**: `web-ui/server.ts`

**核心内容**:
- `Session` 接口新增 `lastAccessedAt: number` 字段
- `getOrCreateSession`：每次访问自动更新 `lastAccessedAt`
- `cleanupExpiredSessions()`：定时扫描删除过期会话
  - 默认 TTL：24h（`SESSION_TTL_MS`）
  - 默认扫描间隔：1h（`SESSION_CLEANUP_INTERVAL_MS`）
- 删除前：若存在活跃 auto loop，先 `abortController.abort()`
- 启动时控制台输出配置信息

---

## 统计

| 指标 | 数值 |
|------|------|
| 新增 commit | 13 |
| 总代码量 | +2,528 行 / -55 行 |
| 新增文件 | 10（references×4、evals×5、.gitignore 更新） |
| 修改文件 | 7（server.ts、Studio.tsx、api.ts、SKILL.md、studio.spec.ts、models.md、.gitignore） |
| TypeScript 编译 | ✅ 零错误（每次 commit 均验证） |
| 快速 E2E 回归 | ✅ 通过（chromium-fast，非 @expensive） |

## 阻塞项

| 事项 | 阻塞原因 | 解锁条件 |
|------|----------|----------|
| E2E 自动模式真实验证 | API 配额用完（free tier `limit: 0`） | 付费 tier key 或每日配额重置 |
| editImage 功能验证 | 同上 | 同上 |
| P4 反推手测 | 同上 | 同上 |

## 新增环境变量

```bash
GEMINI_API_KEY=          # 必填
PORT=3456                # 可选，默认 3456
ALLOWED_ORIGIN=          # 可选，CORS 允许来源
SESSION_TTL_MS=86400000           # 可选，会话 TTL（默认 24h）
SESSION_CLEANUP_INTERVAL_MS=3600000  # 可选，清理间隔（默认 1h）
```

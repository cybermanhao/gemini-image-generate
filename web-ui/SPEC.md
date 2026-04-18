# Gemini Image Studio — 技术规范（草案）

## 1. 项目定位

**不是**给人类用的图像生成工具。  
**是**给 AI agent 在程序开发时调用的图像生成 skill。  
**目标**是 agent 能尽量少的人工介入完成从 prompt 到最终图片的完整链路。

Web UI 的定位是：**观测窗口 + fallback 干预入口**，不是主要交互界面。

---

## 2. 核心工作流

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Prompt    │────→│  Generate   │────→│    LAAJ     │────→│   Converged?│
│  (from CLI) │     │   (Gemini)  │     │   (Judge)   │     │             │
└─────────────┘     └─────────────┘     └─────────────┘     └──────┬──────┘
                                                                     │
                                    ┌────────────────────────────────┘
                                    │ No
                                    ▼
                           ┌─────────────────┐
                           │  Auto-Refine    │
                           │ (build instr.   │
                           │  from topIssues)│
                           └─────────────────┘
```

**终止条件（满足任一）：**
- `converged === true`
- `rounds.length >= maxRounds`（默认 3）
- 人主动接管（Web UI 点击"执行精调"时中断 auto 循环）

---

## 3. 双模式设计

### 3.1 Agent 自动模式（默认）

**触发：** CLI/API 调用 `generate()` 时传入 `autoRefine: true`

**行为：**
1. 生成 Round 0
2. 自动运行 LAAJ
3. 如果未收敛且有 topIssues，自动构造精调指令
4. 调用 refine
5. 重复步骤 2-4 直到收敛或达到 maxRounds
6. 返回最终结果

**人能看到什么：**
- SSE 实时推送每轮进度
- Web UI 显示当前状态（"自动精调中 · Round 2/3"）
- 人可以打开 ContextSnapshot 面板观察发送了什么

**人能做什么：**
- **观看**，不能干预（最小可用版本）
- 后续版本：点击"接管控制"中断 auto 循环，切换为手动模式

### 3.2 人工调整模式

**触发：**
- Web UI 直接操作
- CLI 调用 `generate()` 时 `autoRefine: false`
- Agent 自动模式遇到 `choice-request`（无法自主决策）

**行为：**
- 生成后停止，等待人输入精调指令
- 人点击"执行精调"后继续
- LAAJ 结果展示给人看，人决定是否继续

---

## 4. 待决策事项

### 4.1 持久化 ❓

| 方案 | 适用场景 | 当前判断 |
|------|---------|---------|
| 内存 Map（现状） | 演示、单次会话 | ✅ 保留 |
| JSON 文件导出 | 偶尔保存成功案例 | ⚠️ 后续加"导出会话"按钮即可 |
| SQLite | 跨天追溯、批量分析 | ❌ 暂不需要 |

**决策：** 暂不引入 SQLite。当明确出现"3 天后想找回某张图的历史"的痛点时再评估。

### 4.2 反推（Reverse Prompt）❓

| 问题 | 当前状态 |
|------|---------|
| 反推质量是否达标？ | 未验证，使用 `gemini-2.5-flash` 可能不够强 |
| 在通用图像生成场景下的价值？ | 不明确 |

**决策：** 保持现有实现不变，不投入优化资源。等核心自动闭环跑顺后，再单独评估反推质量。

### 4.3 自动精调策略 ❓

**核心问题：agent 如何根据 LAAJ 的 `topIssues` 自动构造精调指令？**

当前 LAAJ 返回格式：
```ts
{
  topIssues: [
    { issue: "Background is not pure white", fix: "Remove all shadow and make background #FFFFFF" }
  ]
}
```

**候选策略：**

| 策略 | 实现复杂度 | 质量风险 |
|------|-----------|---------|
| A. 直接用 `fix` 字段作为精调指令 | 极低 | 中 — fix 可能太长/不精确 |
| B. 用 LLM 把 `issue + fix` 压缩成 1 句精调指令 | 低 | 低 — 多一次 API 调用 |
| C. 预定义指令模板库（纯白背景→"Ensure pure white"） | 中 | 低 — 但需要维护映射表 |

**决策：** 先实现策略 A（直接用 fix），跑起来后再评估是否需要策略 B。

### 4.4 人工接管边界 ❓

**问题：agent 正在自动跑第 2 轮精调时，人打开 Web UI 点了"执行精调"，怎么办？**

| 方案 | 实现复杂度 | 用户体验 |
|------|-----------|---------|
| A. 拒绝："当前会话在自动模式中，请等待" | 极低 | 差 — 人干等着 |
| B. 软中断：发送 abort 信号，agent graceful 停止 | 中 | 好 — 人能随时接管 |
| C. 分支：人的指令创建新的精调分支，不影响 agent 主链路 | 高 | 好但复杂 |

**决策：** 最小可用版本用方案 A（拒绝+提示等待）。后续版本升级到方案 B。

### 4.5 图像存储 ❓

| 方案 | 当前状态 | 问题 |
|------|---------|------|
| base64 存内存 | ✅ 现状 | 大图内存占用高 |
| base64 存 SQLite | 未实现 | DB 膨胀 |
| 存文件系统 + DB 存路径 | 未实现 | 需要文件管理逻辑 |

**决策：** 保持 base64 内存存储。当前场景（演示/开发）下内存不是瓶颈。当单 session 图片超过 50MB 成为问题时再考虑文件化。

---

## 5. 实现优先级

### P0 — 最小可用的 Agent 自动闭环（1-2 天）

- [ ] `generate()` API 支持 `autoRefine: boolean` + `maxRounds: number`
- [ ] 生成后自动运行 LAAJ
- [ ] 根据 `topIssues[0].fix` 自动构造精调指令
- [ ] 自动调用 refine，循环直到收敛或 maxRounds
- [ ] 会话状态字段：`idle | generating | judging | refining | done | error`
- [ ] `GET /api/session/:id/status` 状态查询 API

### P1 — 可观测性（1 天）

- [ ] Web UI 显示当前会话状态（"自动精调中 · Round 2/3"）
- [ ] SSE 推送状态变更
- [ ] 自动模式时禁用精调按钮（或显示"等待自动完成"）

### P2 — 错误处理（1 天）

- [ ] 标准化错误码：`CONTENT_POLICY` / `TIMEOUT` / `MODEL_ERROR` / `RATE_LIMIT`
- [ ] Agent 可解析的错误响应
- [ ] 超时处理（生成超过 120s 自动标记为失败）

### P3 — 人工接管（2-3 天，后续版本）

- [ ] 软中断机制
- [ ] 人点击"执行精调"时 abort auto 循环
- [ ] 状态无缝切换

### P4 — 反推优化（待定）

- [ ] 评估当前反推质量
- [ ] 决定是否值得投入优化

---

## 6. 接口契约（草案）

### 6.1 Generate

```http
POST /api/generate
Content-Type: application/json

{
  "sessionId": "web-123",
  "prompt": "A small green leaf on white background",
  "aspectRatio": "1:1",
  "imageSize": "1K",
  "thinkingLevel": "minimal",
  "autoRefine": true,      // NEW
  "maxRounds": 3           // NEW
}
```

**同步响应（autoRefine=false）：**
```json
{ "success": true, "round": { ... } }
```

**异步响应（autoRefine=true）：**
```json
{ "success": true, "sessionId": "web-123", "status": "running" }
```

Agent 需要轮询 `/api/session/:sessionId/status` 获取最终状态。

### 6.2 Session Status

```http
GET /api/session/:sessionId/status
```

```json
{
  "status": "refining",
  "mode": "auto",
  "roundsCount": 2,
  "currentRound": { ... },
  "converged": false,
  "maxRounds": 3,
  "error": null
}
```

---

## 7. 已知限制（接受现状）

1. **服务器重启丢数据** — 接受，暂不引入 SQLite
2. **反推质量不确定** — 接受，暂不优化
3. **一次只能生成一张图** — 接受，批量生成后续评估
4. **无 upscale/超分** — 接受，Gemini 输出 2K 够用
5. **人工接管需等待** — 接受，P3 再实现软中断

---

## 8. 成功的定义

Agent 能在无人介入的情况下完成：
```
输入 prompt → 生成图像 → LAAJ 评估 → 自动精调 → 再次评估 → 收敛
```

并且 agent 能通过状态查询 API 知道什么时候去拿最终结果。

---

*最后更新：2026-04-18*  
*状态：草案，待评审*

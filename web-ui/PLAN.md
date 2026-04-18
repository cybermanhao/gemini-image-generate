# P0 实现计划：Agent 自动闭环

基于 SPEC.md 的 P0 目标：让 agent 能在无人介入的情况下完成 `generate → LAAJ → refine → 收敛` 的完整链路。

---

## 任务总览

| # | 任务 | 文件 | 预估时间 | 依赖 |
|---|------|------|---------|------|
| 1 | 会话状态机 | `server.ts` | 2h | 无 |
| 2 | 标准化错误码 | `server.ts` | 1.5h | 无 |
| 3 | 自动精调循环 | `server.ts` | 3h | 任务 1, 2 |
| 4 | 状态查询 API | `server.ts` | 1h | 任务 1 |
| 5 | API 客户端更新 | `src/lib/api.ts` | 1h | 任务 3, 4 |
| 6 | Web UI 状态显示 | `src/components/Studio.tsx` | 2h | 任务 1, 4 |
| 7 | 自动模式禁用精调按钮 | `src/components/Studio.tsx` | 1h | 任务 6 |
| 8 | E2E 测试（自动模式） | `e2e/studio.spec.ts` | 3h | 全部 |
| 9 | Build & 全量测试 | — | 1h | 全部 |

**总计：约 2 天**

---

## 任务 1：会话状态机（server.ts）

### 目标
给 Session 增加状态字段，支持 `idle | generating | judging | refining | done | error` 的流转。

### 具体改动

**1.1 扩展 Session 接口**
```typescript
interface Session {
  id: string;
  rounds: GenerationRound[];
  baseImageBase64?: string;
  basePrompt?: string;
  // NEW
  status: SessionStatus;
  mode: 'manual' | 'auto';
  currentTask?: {
    type: 'generate' | 'refine' | 'judge';
    roundId?: string;
    startedAt: number;
  };
  error?: {
    code: ErrorCode;
    message: string;
    roundId?: string;
    timestamp: number;
  };
}

type SessionStatus = 'idle' | 'generating' | 'judging' | 'refining' | 'done' | 'error';
```

**1.2 状态流转工具函数**
```typescript
function setSessionStatus(session: Session, status: SessionStatus, task?: Session['currentTask']) {
  session.status = status;
  session.currentTask = task;
  broadcast(session.id, { type: 'status', status, task });
}

function setSessionError(session: Session, code: ErrorCode, message: string, roundId?: string) {
  session.status = 'error';
  session.error = { code, message, roundId, timestamp: Date.now() };
  broadcast(session.id, { type: 'error', code, message, roundId });
}
```

**1.3 getOrCreateSession 初始化状态**
```typescript
function getOrCreateSession(sessionId: string): Session {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      id: sessionId,
      rounds: [],
      status: 'idle',
      mode: 'manual',
    });
  }
  return sessions.get(sessionId)!;
}
```

---

## 任务 2：标准化错误码（server.ts）

### 目标
把所有 `alert()` 和字符串错误替换为结构化错误码，agent 能根据 code 决定重试/跳过/上报。

### 错误码定义
```typescript
type ErrorCode =
  | 'CONTENT_POLICY'      // 内容政策拒绝
  | 'TIMEOUT'             // 生成超时（>120s）
  | 'MODEL_ERROR'         // 模型返回异常（无图、格式错误）
  | 'RATE_LIMIT'          // API 限流
  | 'INVALID_PROMPT'      // 提示词为空或过长
  | 'ROUND_NOT_FOUND'     // refine 时找不到 round
  | 'SESSION_NOT_FOUND'   // 查询不存在的 session
  | 'AUTO_REFINE_FAILED'  // 自动精调循环中断
  | 'UNKNOWN';            // 未分类错误
```

### 具体改动

**2.1 封装错误分类函数**
```typescript
function classifyError(err: any): { code: ErrorCode; message: string } {
  const msg = String(err.message ?? err);
  if (msg.includes('429') || msg.includes('rate limit')) return { code: 'RATE_LIMIT', message: msg };
  if (msg.includes('timeout') || msg.includes('deadline')) return { code: 'TIMEOUT', message: msg };
  if (msg.includes('content') || msg.includes('safety')) return { code: 'CONTENT_POLICY', message: msg };
  if (msg.includes('did not return an image')) return { code: 'MODEL_ERROR', message: msg };
  return { code: 'UNKNOWN', message: msg };
}
```

**2.2 修改所有 API 端点的 catch 块**

当前：
```typescript
} catch (err: any) {
  console.error('[generate]', err);
  res.status(500).json({ success: false, error: err.message ?? String(err) });
}
```

改为：
```typescript
} catch (err: any) {
  const { code, message } = classifyError(err);
  setSessionError(session, code, message);
  console.error(`[generate] ${code}:`, message);
  res.status(500).json({ success: false, error: message, code });
}
```

**2.3 生成超时处理**

给 `doGenerate` 和 `doRefine` 加 Promise.race：
```typescript
const TIMEOUT_MS = 120_000;

async function doGenerateWithTimeout(...): Promise<GenerateResult> {
  return Promise.race([
    doGenerate(...),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Generation timeout after 120s')), TIMEOUT_MS)
    ),
  ]);
}
```

---

## 任务 3：自动精调循环（server.ts）

### 目标
实现 `autoRefine` 参数，让 agent 能自动完成 `generate → LAAJ → refine → 收敛` 闭环。

### 具体改动

**3.1 扩展 GenerateBody 接口**
```typescript
interface GenerateBody {
  sessionId: string;
  imageBase64?: string;
  prompt: string;
  aspectRatio?: string;
  imageSize?: string;
  thinkingLevel?: 'minimal' | 'high';
  extraImagesBase64?: string[];
  styleRefBase64?: string;
  // NEW
  autoRefine?: boolean;
  maxRounds?: number;
}
```

**3.2 实现自动精调循环函数**
```typescript
async function runAutoRefine(
  session: Session,
  baseParams: Omit<GenerateBody, 'sessionId' | 'autoRefine' | 'maxRounds'>,
  maxRounds: number
): Promise<void> {
  for (let roundIndex = 0; roundIndex < maxRounds; roundIndex++) {
    const lastRound = session.rounds[session.rounds.length - 1];
    if (!lastRound) break;

    // Step 1: Judge
    setSessionStatus(session, 'judging', { type: 'judge', roundId: lastRound.id, startedAt: Date.now() });
    const judgeResult = await doJudge({
      imageBase64: lastRound.imageBase64,
      prompt: lastRound.instruction ?? lastRound.prompt,
    });

    // Update round with scores
    lastRound.scores = judgeResult.scores;
    lastRound.topIssues = judgeResult.topIssues;
    lastRound.nextFocus = judgeResult.nextFocus;
    lastRound.converged = judgeResult.converged;

    broadcast(session.id, { type: 'round-updated', round: lastRound });

    // Check convergence
    if (judgeResult.converged) {
      setSessionStatus(session, 'done');
      return;
    }

    // Check if we can refine
    if (!judgeResult.topIssues || judgeResult.topIssues.length === 0) {
      setSessionStatus(session, 'done');
      return;
    }

    // Step 2: Build instruction from top issue
    const instruction = judgeResult.topIssues[0].fix;

    // Step 3: Refine
    setSessionStatus(session, 'refining', { type: 'refine', startedAt: Date.now() });
    const refineResult = await doRefine({
      baseImageBase64: session.baseImageBase64,
      basePrompt: session.basePrompt ?? '',
      prevImageBase64: lastRound.imageBase64,
      prevThoughtSignature: lastRound.thoughtSignature,
      prevModelDescription: lastRound.modelDescription,
      instruction,
      aspectRatio: baseParams.aspectRatio,
      imageSize: baseParams.imageSize,
    });

    const round: GenerationRound = {
      id: randomUUID(),
      turn: session.rounds.length,
      type: 'refine',
      prompt: session.basePrompt ?? '',
      instruction,
      imageBase64: refineResult.imageBase64,
      thoughtSignature: refineResult.thoughtSignature,
      modelDescription: refineResult.modelDescription,
      converged: false,
      createdAt: Date.now(),
      contextSnapshot: refineResult.contextSnapshot,
    };

    session.rounds.push(round);
    broadcast(session.id, { type: 'round', round });
  }

  setSessionStatus(session, 'done');
}
```

**3.3 修改 /api/generate 端点**

```typescript
app.post('/api/generate', async (req: Request, res: Response) => {
  try {
    const body = req.body as GenerateBody;
    // ... validation ...

    const session = getOrCreateSession(body.sessionId);

    if (session.status !== 'idle' && session.status !== 'done' && session.status !== 'error') {
      res.status(409).json({
        success: false,
        code: 'SESSION_BUSY',
        error: `Session is ${session.status}, please wait or use a new session`,
      });
      return;
    }

    session.mode = body.autoRefine ? 'auto' : 'manual';

    // Generate Round 0
    setSessionStatus(session, 'generating', { type: 'generate', startedAt: Date.now() });
    const result = await doGenerateWithTimeout({ ... });

    const round: GenerationRound = { ... };
    session.rounds.push(round);
    broadcast(session.id, { type: 'round', round });

    // Auto refine
    if (body.autoRefine) {
      // Fire-and-forget: don't await, return immediately
      runAutoRefine(session, body, body.maxRounds ?? 3).catch(err => {
        const { code, message } = classifyError(err);
        setSessionError(session, code, message);
      });

      res.json({ success: true, sessionId: session.id, status: 'running', mode: 'auto' });
      return;
    }

    setSessionStatus(session, 'done');
    res.json({ success: true, round });
  } catch (err: any) {
    // ... error handling ...
  }
});
```

---

## 任务 4：状态查询 API（server.ts）

### 目标
让 agent 能轮询查询会话当前状态。

### 具体改动

```typescript
app.get('/api/session/:sessionId/status', (req: Request, res: Response) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) {
    res.status(404).json({ success: false, code: 'SESSION_NOT_FOUND', error: 'Session not found' });
    return;
  }

  const lastRound = session.rounds[session.rounds.length - 1];

  res.json({
    success: true,
    status: session.status,
    mode: session.mode,
    roundsCount: session.rounds.length,
    currentRound: lastRound ?? null,
    converged: lastRound?.converged ?? false,
    currentTask: session.currentTask ?? null,
    error: session.error ?? null,
  });
});
```

---

## 任务 5：API 客户端更新（src/lib/api.ts）

### 目标
前端客户端支持新的参数和状态查询。

### 具体改动

**5.1 扩展 GenerateParams**
```typescript
export interface GenerateParams {
  sessionId: string;
  imageBase64?: string;
  prompt: string;
  aspectRatio?: string;
  imageSize?: string;
  thinkingLevel?: 'minimal' | 'high';
  extraImagesBase64?: string[];
  styleRefBase64?: string;
  // NEW
  autoRefine?: boolean;
  maxRounds?: number;
}
```

**5.2 添加状态查询函数**
```typescript
export interface SessionStatus {
  success: boolean;
  status: string;
  mode: string;
  roundsCount: number;
  currentRound: GenerationRound | null;
  converged: boolean;
  currentTask: { type: string; roundId?: string; startedAt: number } | null;
  error: { code: string; message: string; roundId?: string; timestamp: number } | null;
}

export async function getSessionStatus(sessionId: string): Promise<SessionStatus> {
  const res = await fetch(`${API_BASE}/api/session/${sessionId}/status`);
  return res.json();
}
```

---

## 任务 6：Web UI 状态显示（src/components/Studio.tsx）

### 目标
在 Web UI 上显示当前会话的自动模式状态。

### 具体改动

**6.1 监听 SSE status 消息**
```typescript
useEffect(() => {
  // ... existing SSE setup ...
  evt.onmessage = (e) => {
    const data = JSON.parse(e.data);
    if (data.type === 'round') {
      setRounds(prev => [...prev, data.round]);
      setSelectedRoundId(data.round.id);
    }
    if (data.type === 'round-updated') {
      setRounds(prev => prev.map(r => r.id === data.round.id ? data.round : r));
    }
    // NEW
    if (data.type === 'status') {
      setSessionStatus(data.status);
      setSessionMode(data.mode ?? 'manual');
    }
    if (data.type === 'error') {
      setSessionError(data);
    }
  };
}, []);
```

**6.2 添加状态显示组件**
在 Refine tab 顶部或 Header 旁边显示：
```
⚡ 自动精调中 · Round 2/3 · judging...
```

---

## 任务 7：自动模式禁用精调按钮（src/components/Studio.tsx）

### 目标
当会话处于 auto 模式且正在运行时，禁用人工精调按钮，防止冲突。

### 具体改动

```typescript
const isAutoRunning = sessionMode === 'auto' && 
  (sessionStatus === 'generating' || sessionStatus === 'judging' || sessionStatus === 'refining');

// 在精调按钮上
<button disabled={!instruction.trim() || refining || isAutoRunning}>
  {isAutoRunning ? '自动精调中…' : refining ? '精调中…' : '执行精调'}
</button>
```

---

## 任务 8：E2E 测试（e2e/studio.spec.ts）

### 目标
验证 agent 自动闭环能完整跑通。

### 新增测试用例

```typescript
test('agent auto mode: generate and auto-refine until converged', async ({ page, request }) => {
  test.setTimeout(600_000);
  const sessionId = `auto-${Date.now()}`;

  // 1. Agent 调用 generate with autoRefine
  const genRes = await request.post('/api/generate', {
    data: { sessionId, prompt: SIMPLE_PROMPT, autoRefine: true, maxRounds: 3 },
  });
  const genBody = await genRes.json();
  expect(genBody.success).toBe(true);
  expect(genBody.mode).toBe('auto');
  expect(genBody.status).toBe('running');

  // 2. Agent 轮询状态直到 done
  let status: any;
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(10_000);
    const res = await request.get(`/api/session/${sessionId}/status`);
    status = await res.json();
    if (status.status === 'done' || status.status === 'error') break;
  }

  expect(status.status).toBe('done');
  expect(status.roundsCount).toBeGreaterThanOrEqual(1);

  // 3. Web UI 自动同步显示所有 rounds
  await page.goto(`/?session=${sessionId}`);
  await expect(page.getByText(/生成历史/)).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('img[alt="result"]').first()).toBeVisible();

  // 4. 最后一轮有 LAAJ 分数
  const lastRound = status.currentRound;
  expect(lastRound.scores).toBeDefined();
});
```

---

## 任务 9：Build & 全量测试

### 检查清单

- [ ] `npm run build` 通过
- [ ] `npm run test`（E2E 全部通过）
- [ ] 手动验证：
  - [ ] 人工模式：Web UI 生成 + 精调正常
  - [ ] 自动模式：curl 调用 autoRefine，轮询状态到 done
  - [ ] 错误场景：空 prompt、超时模拟
  - [ ] SSE 同步：CLI 生成后 Web UI 自动显示

---

## 风险与回退

| 风险 | 影响 | 回退方案 |
|------|------|---------|
| autoRefine 循环死锁 | 会话永远卡在 running | 状态查询 API 暴露 `startedAt`，agent 可自己判断超时 |
| LAAJ 评估慢 | 自动模式总耗时超长 | `maxRounds` 默认 3，agent 可设 1 跳过精调 |
| 并发请求冲突 | 两个 CLI 同时调用同 session | `/api/generate` 检查 `session.status !== 'idle'` 返回 409 |
| 自动指令质量差 | 精调方向错误 | P0 接受现状，P1 换 LLM 压缩策略 |

---

## 执行顺序

```
Day 1 上午：任务 1（状态机）+ 任务 2（错误码）
Day 1 下午：任务 3（自动循环）
Day 2 上午：任务 4（状态 API）+ 任务 5（客户端）+ 任务 6/7（UI）
Day 2 下午：任务 8（E2E 测试）+ 任务 9（Build & 测试）
```

---

*Plan 版本：P0-draft-1*  
*基于 SPEC.md v1*

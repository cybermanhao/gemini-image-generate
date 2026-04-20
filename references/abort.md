# Abort & Cancellation

`@google/genai` supports `abortSignal?: AbortSignal` in `GenerateContentConfig`.
Passing a signal cancels the **in-flight HTTP request** — not just the Promise — freeing the connection immediately.

---

## Where it goes

```typescript
const response = await ai.models.generateContent({
  model: 'gemini-3.1-flash-image-preview',
  contents: [...],
  config: {
    responseModalities: ['TEXT', 'IMAGE'],
    imageConfig: { aspectRatio: '1:1', imageSize: '1K' },
    abortSignal: signal,   // ← here, inside config
  },
});
```

Same field is available on `generateImages()`, `countTokens()`, streaming variants, and all other SDK calls.

---

## Pattern 1 — Hard Timeout (cancels the HTTP request)

`Promise.race` against a timer rejects the Promise but leaves the HTTP request running.
Use `AbortController` instead to actually cancel the connection:

```typescript
const TIMEOUT_MS = 120_000;

function withGeminiCall<T>(
  factory: (signal: AbortSignal) => Promise<T>,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<T> {
  const { signal: externalSignal, timeoutMs = TIMEOUT_MS } = options;
  const timeoutCtrl = new AbortController();

  const timer = setTimeout(() => {
    timeoutCtrl.abort(
      Object.assign(new Error(`Gemini call timed out after ${timeoutMs / 1000}s`), { code: 'ETIMEDOUT' }),
    );
  }, timeoutMs);

  // Forward an external signal (user interrupt) into the same controller
  externalSignal?.addEventListener('abort', () => timeoutCtrl.abort(externalSignal.reason), { once: true });

  return factory(timeoutCtrl.signal).finally(() => clearTimeout(timer));
}

// Usage
const result = await withGeminiCall(
  (s) => doGenerate({ prompt, signal: s }),
  { timeoutMs: 120_000 },
);
```

**Why one controller, not two?** Forwarding the external signal into `timeoutCtrl` means the factory always receives a single signal. You don't need `AbortSignal.any()` (Node 20+ only) or manual fan-out.

---

## Pattern 2 — User Soft Interrupt (接管控制)

For an auto-loop that runs multiple Gemini calls in sequence, one `AbortController` per loop run covers all of them:

```typescript
// Server: store the controller on the session
const ctrl = new AbortController();
session.abortController = ctrl;

// In the loop
const result = await withGeminiCall(
  (s) => doRefine({ ...params, signal: s }),
  { signal: ctrl.signal },          // forwarded into withGeminiCall
);

// Abort endpoint — called by user clicking "接管控制"
app.post('/api/session/:sessionId/abort', (req, res) => {
  const session = sessions.get(req.params.sessionId)!;
  session.abortController?.abort(new Error('User requested abort'));
  res.json({ success: true });
});
```

When `ctrl.abort()` fires:
1. The in-flight Gemini HTTP request is cancelled immediately
2. The `await` inside `withGeminiCall` throws an `AbortError`
3. The loop catches it, detects `isAbortError(err)`, breaks cleanly
4. Session status switches back to `idle`, mode back to `manual`
5. Web UI receives `{ type: 'aborted' }` SSE event

---

## Pattern 3 — Agent-Side Cancellation

An agent calling the MCP server can pass its own `AbortSignal` through the tool call.
Currently the MCP `generate_image` / `refine_image` tools don't expose `signal` in their input schema,
but the underlying `doGenerate` / `doRefine` functions accept it.
To wire it up, extract the signal from the MCP request context and pass it down.

---

## Detecting abort errors

```typescript
function isAbortError(err: unknown): boolean {
  const e = err as any;
  return (
    e?.name === 'AbortError' ||
    e?.code === 'ABORT_ERR' ||
    String(e?.message ?? '').toLowerCase().includes('aborted') ||
    String(e?.message ?? '').toLowerCase().includes('user requested abort')
  );
}
```

**Do not** call `setSessionError()` for abort errors — that marks the session as failed.
Call `setSessionStatus(session, 'idle')` and let the user continue manually.

---

## Abort vs Timeout — comparison

| | `Promise.race` (old) | `AbortController` (current) |
|---|---|---|
| HTTP request cancelled | ❌ keeps running | ✅ cancelled immediately |
| Connection freed | ❌ | ✅ |
| User interrupt support | ❌ | ✅ |
| Error type | generic `Error` | `AbortError` (detectable) |

---

## Workflow integration

```
POST /api/generate { autoRefine: true }
  → creates AbortController, stores as session.abortController
  → generate (with signal)
  → runAutoRefine loop (each call uses withGeminiCall + signal)

POST /api/session/:id/abort
  → session.abortController.abort()
  → current in-flight call cancelled
  → loop exits cleanly
  → status: idle, mode: manual
  → SSE: { type: 'aborted' }
  → UI enables manual refine controls
```

---

## Error code mapping

| Abort cause | `ErrorCode` | Notes |
|---|---|---|
| `withGeminiCall` timeout (120s) | `TIMEOUT` | Has `code: 'ETIMEDOUT'` |
| User abort | — | Not an error, sets `idle` |
| Network timeout from SDK | `TIMEOUT` | SDK may throw its own error |

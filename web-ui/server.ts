import express from 'express';
import type { Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json({ limit: '50mb' }));

const clients = new Set<Response>();

function broadcast(data: unknown) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    res.write(payload);
  }
}

// SSE endpoint
app.get('/api/events', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.write(':ok\n\n');
  clients.add(res);
  req.on('close', () => clients.delete(res));
});

// Demo mode: load rounds state
let demoState: unknown = null;
app.post('/api/load-state', (req: Request, res: Response) => {
  demoState = req.body;
  broadcast({ type: 'demo-state', payload: demoState });
  res.json({ ok: true });
});

// Play mode: set initial values
let playInit: unknown = null;
app.post('/api/set-init', (req: Request, res: Response) => {
  playInit = req.body;
  broadcast({ type: 'play-init', payload: playInit });
  res.json({ ok: true });
});

// Trigger a simulated pipeline step
app.post('/api/simulate', (req: Request, res: Response) => {
  const { step, payload } = req.body;
  broadcast({ type: 'simulate', step, payload });
  res.json({ ok: true });
});

// Built-in example assets shipped with the skill demo
const EXAMPLE_ASSETS_DIR = path.resolve(__dirname, 'public/assets');
if (fs.existsSync(EXAMPLE_ASSETS_DIR)) {
  app.use('/api/example-assets', express.static(EXAMPLE_ASSETS_DIR));
}

// List example assets
app.get('/api/example-assets-list', (_req: Request, res: Response) => {
  if (!fs.existsSync(EXAMPLE_ASSETS_DIR)) {
    res.json({ dir: null, files: [] });
    return;
  }
  const files = fs.readdirSync(EXAMPLE_ASSETS_DIR).filter(f => /\.(png|jpe?g|gif|webp|bmp)$/i.test(f));
  res.json({ dir: EXAMPLE_ASSETS_DIR, files });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
});

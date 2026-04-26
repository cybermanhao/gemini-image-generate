import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { PORT, SESSION_CLEANUP_INTERVAL_MS } from './src/server/config.js';
import { cleanupExpiredSessions } from './src/server/services/sessionStore.js';
import { registerRoutes } from './src/server/routes/index.js';
import { registerMcp } from './src/server/mcp/server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(cors({ origin: process.env.ALLOWED_ORIGIN ?? `http://localhost:${PORT}` }));
app.use(express.json({ limit: '50mb' }));

registerRoutes(app);
registerMcp(app);

app.use(express.static(path.join(__dirname, 'dist')));
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`[server] Image Studio running at http://localhost:${PORT}`);
  console.log(`[mcp]    MCP SSE endpoint at http://localhost:${PORT}/mcp/sse`);
  setInterval(cleanupExpiredSessions, SESSION_CLEANUP_INTERVAL_MS);
  console.log(`[cleanup] Session TTL: ${24}h, cleanup interval: ${60}min`);
});

import type { Request, Response } from 'express';
import { addClient, removeClient } from '../services/sse.js';

export function register(app: import('express').Application) {
  app.get('/api/events/:sessionId', (req: Request, res: Response) => {
    const { sessionId } = req.params;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.write(':ok\n\n');
    addClient(sessionId, res);
    req.on('close', () => removeClient(sessionId, res));
  });
}

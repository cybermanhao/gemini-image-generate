import type { Request, Response } from 'express';
import type { JudgeBody } from '../types.js';
import { isValidBase64 } from '../utils/validation.js';
import { doJudge } from '../services/gemini.js';

function getStatusFromError(err: any): number {
  if (err?.status === 429) return 429;
  if (err?.status === 400) return 400;
  return 500;
}

export function register(app: import('express').Application) {
  app.post('/api/judge', async (req: Request, res: Response) => {
    try {
      const body = req.body as JudgeBody;
      if (!body.imageBase64 || typeof body.imageBase64 !== 'string') {
        res.status(400).json({ success: false, error: 'imageBase64 is required' });
        return;
      }
      if (!isValidBase64(body.imageBase64)) {
        res.status(400).json({ success: false, error: 'imageBase64 is not valid base64' });
        return;
      }
      if (!body.prompt || !body.prompt.trim()) {
        res.status(400).json({ success: false, error: 'prompt is required' });
        return;
      }
      const result = await doJudge(body);
      res.json({ success: true, result });
    } catch (err: any) {
      console.error('[judge]', err);
      res.status(getStatusFromError(err)).json({ success: false, error: err.message ?? String(err) });
    }
  });
}

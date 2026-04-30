import type { Request, Response } from 'express';
import type { OrganizePartsBody } from '../types.js';
import { doOrganizeParts } from '../services/gemini.js';
import { isValidBase64 } from '../utils/validation.js';

export function register(app: import('express').Application) {
  app.post('/api/organize-parts', async (req: Request, res: Response) => {
    try {
      const body = req.body as OrganizePartsBody;

      if (!body.images || !Array.isArray(body.images) || body.images.length === 0) {
        res.status(400).json({ success: false, error: 'images array is required' });
        return;
      }

      if (body.images.length > 9) {
        res.status(400).json({ success: false, error: 'Max 9 images allowed' });
        return;
      }

      for (const img of body.images) {
        if (!img.base64 || typeof img.base64 !== 'string' || !isValidBase64(img.base64)) {
          res.status(400).json({ success: false, error: 'Invalid base64 in images' });
          return;
        }
      }

      if (!body.userInstruction || typeof body.userInstruction !== 'string') {
        res.status(400).json({ success: false, error: 'userInstruction is required' });
        return;
      }

      const result = await doOrganizeParts(body.images, body.userInstruction);
      res.json({ success: true, result });
    } catch (err: any) {
      console.error('[organize-parts]', err);
      res.status(500).json({ success: false, error: err.message ?? String(err) });
    }
  });
}

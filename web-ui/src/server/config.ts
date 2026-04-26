import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';
import { fileURLToPath } from 'url';
import path from 'path';

dotenv.config({ override: true });

export const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PORT = Number(process.env.PORT) || 3456;
export const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!GEMINI_API_KEY) {
  console.error('[fatal] GEMINI_API_KEY not set. Create .env from .env.example');
  process.exit(1);
}

export const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
export const GENERATION_MODEL = 'gemini-3-pro-image-preview';
export const JUDGE_MODEL = 'gemini-2.5-flash';
export const GEMINI_TIMEOUT_MS = 120_000;
export const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS) || 24 * 60 * 60 * 1000;
export const SESSION_CLEANUP_INTERVAL_MS = Number(process.env.SESSION_CLEANUP_INTERVAL_MS) || 60 * 60 * 1000;

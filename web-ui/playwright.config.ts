import { defineConfig, devices } from '@playwright/test';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '.env') });

/**
 * Playwright config for Gemini Image Studio E2E tests.
 *
 * Run modes:
 *   npx playwright test                  # default: chromium-fast (skips @expensive)
 *   npx playwright test --project=chromium-full   # runs only @expensive tests
 *   npx playwright test --project=chromium        # runs all tests
 *   npx playwright test --grep "@slow"            # runs slow tests across projects
 *   npx playwright test --grep-invert "@expensive" # skip expensive tests
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:3456',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium-fast',
      use: { ...devices['Desktop Chrome'] },
      grepInvert: /@expensive/,
    },
    {
      name: 'chromium-full',
      use: { ...devices['Desktop Chrome'] },
      grep: /@expensive/,
    },
  ],
  webServer: {
    command: 'npx tsx server.ts',
    url: 'http://localhost:3456',
    reuseExistingServer: !process.env.CI,
    env: {
      GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
      PORT: '3456',
    },
    timeout: 120_000,
  },
});

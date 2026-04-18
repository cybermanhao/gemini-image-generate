import { test, expect } from '@playwright/test';
import { StudioPage } from '../pom/StudioPage';
import fs from 'fs';
import path from 'path';
import os from 'os';

function createTestImage(): string {
  const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const tmp = path.join(os.tmpdir(), `test-img-${Date.now()}.png`);
  fs.writeFileSync(tmp, Buffer.from(base64, 'base64'));
  return tmp;
}

test.describe.configure({ mode: 'serial' });

test.describe('场景: 提示词工程师 — 反向推导与结构化分析', { tag: ['@slow', '@expensive'] }, () => {
  test('反推文生图提示词', async ({ page }) => {
    test.setTimeout(120_000);
    const studio = new StudioPage(page);
    const img = createTestImage();
    await studio.goto(`reverse-${Date.now()}`);

    await studio.reverse(img, 'text-to-image');

    // 验证反推结果包含文本
    const resultText = await page.locator('pre').first().textContent();
    expect(resultText?.length).toBeGreaterThan(10);
  });

  test('反推图生图结构化 Segments', async ({ page }) => {
    test.setTimeout(120_000);
    const studio = new StudioPage(page);
    const img = createTestImage();
    await studio.goto(`reverse-seg-${Date.now()}`);

    await studio.reverse(img, 'image-to-image');

    // 验证 segments 出现
    await expect(page.getByText('identity')).toBeVisible();
    await expect(page.getByText('canvas')).toBeVisible();
    await expect(page.getByText('style')).toBeVisible();
  });
});

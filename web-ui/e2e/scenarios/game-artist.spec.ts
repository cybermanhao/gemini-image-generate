import { test, expect } from '@playwright/test';
import { StudioPage } from '../pom/StudioPage';
import fs from 'fs';
import path from 'path';
import os from 'os';

function createTestImage(): string {
  // 1x1 red pixel PNG
  const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const tmp = path.join(os.tmpdir(), `test-img-${Date.now()}.png`);
  fs.writeFileSync(tmp, Buffer.from(base64, 'base64'));
  return tmp;
}

test.describe.configure({ mode: 'serial' });

test.describe('场景: 游戏美术 — 风格参考与概念迭代', { tag: ['@slow', '@expensive'] }, () => {
  test('使用风格参考生成角色概念图', async ({ page }) => {
    test.setTimeout(600_000);
    const studio = new StudioPage(page);
    const styleRef = createTestImage();
    await studio.goto(`game-${Date.now()}`);

    // Turn 0: 上传风格参考 + 文生图
    await studio.generate(
      'A fantasy RPG character portrait, warrior class, heavy armor, epic pose',
      { aspectRatio: '3:4', imageSize: '2K', styleRefFile: styleRef }
    );

    // Turn 1: 精调 — 更换为法师
    await studio.refine('Change the character class to a fire mage, replace armor with robes, add magical flames in hands', { turn: 0 });

    // 验证生成历史
    const count = await studio.getRoundCount();
    expect(count).toBe(2);
  });
});

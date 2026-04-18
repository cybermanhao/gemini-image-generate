import { test, expect } from '@playwright/test';
import { StudioPage } from '../pom/StudioPage';

test.describe.configure({ mode: 'serial' });

test.describe('场景: 社媒创作者 — 短视频封面生成', { tag: ['@slow', '@expensive'] }, () => {
  test('生成 9:16 竖版封面图', async ({ page }) => {
    test.setTimeout(300_000);
    const studio = new StudioPage(page);
    await studio.goto(`social-${Date.now()}`);

    await studio.generate(
      'Eye-catching thumbnail for a tech review video, bold typography space at top, futuristic gadgets on desk, neon lighting, vertical composition',
      { aspectRatio: '9:16', imageSize: '2K' }
    );

    const count = await studio.getRoundCount();
    expect(count).toBe(1);
  });
});

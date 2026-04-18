import { test, expect } from '@playwright/test';
import { StudioPage } from '../pom/StudioPage';

test.describe.configure({ mode: 'serial' });

test.describe('场景: 动漫爱好者 — 角色设计与多轮精调', { tag: ['@slow', '@expensive'] }, () => {
  test('生成动漫角色并进行多轮风格精调', async ({ page }) => {
    test.setTimeout(600_000);
    const studio = new StudioPage(page);
    await studio.goto(`anime-${Date.now()}`);

    // Turn 0: 文生图 — 赛博朋克少女
    await studio.generate(
      'Anime style portrait of a cyberpunk girl with neon blue hair, wearing a techwear jacket, sci-fi city background, detailed face, masterpiece',
      { aspectRatio: '2:3', imageSize: '2K', thinkingLevel: 'high' }
    );

    // 验证自动跳转到 refine tab 并显示 Round 0
    await expect(page.getByRole('heading', { name: /Round 0 详情/ })).toBeVisible();

    // Turn 1: 精调 — 修改发色为粉色
    await studio.refine('Change her hair color to pastel pink and add sakura petals floating around', { turn: 0 });

    // Turn 2: 精调 — 修改服装
    await studio.refine('Change the jacket to a traditional Japanese school uniform (seifuku), keep the pink hair', { turn: 1 });

    // LAAJ 评估最终效果
    await studio.judgeRound(2);

    // 验证历史记录有 3 轮
    const count = await studio.getRoundCount();
    expect(count).toBe(3);
  });
});

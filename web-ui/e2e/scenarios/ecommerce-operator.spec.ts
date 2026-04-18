import { test, expect } from '@playwright/test';
import { StudioPage } from '../pom/StudioPage';

test.describe.configure({ mode: 'serial' });

test.describe('场景: 电商运营 — 产品图生成与优化', { tag: ['@slow', '@expensive'] }, () => {
  test('生成产品图并使用快速指令优化', async ({ page }) => {
    test.setTimeout(600_000);
    const studio = new StudioPage(page);
    await studio.goto(`ecom-${Date.now()}`);

    // Turn 0: 纯白背景产品图
    await studio.generate(
      'Professional product photography of a minimalist ceramic coffee mug on pure white background, studio lighting, soft shadows, high detail',
      { aspectRatio: '1:1', imageSize: '2K' }
    );

    // Turn 1: 使用快速指令 — 增亮
    await studio.switchToRefine();
    await studio.selectRound(0);
    await studio.clickQuickInstruction('增亮');
    await studio.clickRefine();
    await studio.expectRefineCompleted();

    // Turn 2: 提升锐度
    await studio.selectRound(1);
    await studio.clickQuickInstruction('提升锐度');
    await studio.clickRefine();
    await studio.expectRefineCompleted();

    // LAAJ 评估
    await studio.judgeRound(2);

    // 验证 converged 状态或 issues 显示
    await expect(page.getByText(/SUBJECT_FIDELITY|INSTRUCTION_FOLLOWING/)).toBeVisible();
  });
});

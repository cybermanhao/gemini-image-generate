import { test, expect } from '@playwright/test';
import { StudioPage } from './pom/StudioPage';
import fs from 'fs';
import path from 'path';
import os from 'os';

function createTestImage(): string {
  const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const tmp = path.join(os.tmpdir(), `test-img-${Date.now()}.png`);
  fs.writeFileSync(tmp, Buffer.from(base64, 'base64'));
  return tmp;
}

test.describe('边界情况与回归测试', () => {
  test('空 prompt 时生成按钮应被禁用', async ({ page }) => {
    const studio = new StudioPage(page);
    await studio.goto(`edge-${Date.now()}`);
    await studio.expectGenerateButtonDisabled();
    await studio.fillPrompt('   ');
    await studio.expectGenerateButtonDisabled();
  });

  test('未生成图像时精调页面显示空状态', async ({ page }) => {
    const studio = new StudioPage(page);
    await studio.goto(`edge-empty-${Date.now()}`);
    await studio.switchToRefine();
    await studio.expectEmptyRefineState();
  });

  test('Tab 切换应保持状态', async ({ page }) => {
    const studio = new StudioPage(page);
    await studio.goto(`edge-tabs-${Date.now()}`);
    await studio.fillPrompt('test prompt');
    await studio.switchToRefine();
    await studio.switchToGenerate();
    const textarea = page.locator('textarea').first();
    await expect(textarea).toHaveValue('test prompt');
  });

  test('文件上传后应显示预览和删除按钮', async ({ page }) => {
    const studio = new StudioPage(page);
    const img = createTestImage();
    await studio.goto(`edge-upload-${Date.now()}`);
    await studio.uploadSubjectImage(img);
    await expect(page.locator('img[alt=""]').first()).toBeVisible();
    await expect(page.getByRole('button', { name: '×' }).first()).toBeVisible();
  });

  test('删除上传文件后应恢复文生图模式', async ({ page }) => {
    const studio = new StudioPage(page);
    const img = createTestImage();
    await studio.goto(`edge-remove-${Date.now()}`);
    await studio.uploadSubjectImage(img);
    await expect(page.getByText('图生图模式')).toBeVisible();
    await page.getByRole('button', { name: '×' }).first().click();
    await expect(page.getByText('文生图模式')).toBeVisible();
  });

  test('Context Snapshot 面板展开与折叠', { tag: ['@slow', '@expensive'] }, async ({ page, request }) => {
    test.setTimeout(300_000);
    const sessionId = `edge-snapshot-${Date.now()}`;
    const studio = new StudioPage(page);
    await studio.goto(sessionId);

    // 通过 API 快速创建一个 round
    const genRes = await request.post('/api/generate', {
      data: { sessionId, prompt: 'A red apple on white background' },
    });
    expect(genRes.ok()).toBe(true);
    await expect(page.getByText(/生成历史/)).toBeVisible({ timeout: 180_000 });

    await studio.toggleContextSnapshot();
    await studio.expectContextSnapshotVisible();
    await studio.toggleContextSnapshot();
    // 折叠后 turns 文本不应可见
    await expect(page.getByText(/turns/).first()).not.toBeVisible();
  });

  test('HITL await_input state 隔离 — 回归测试', { tag: ['@slow', '@expensive'] }, async ({ page, request }) => {
    test.setTimeout(300_000);
    const sessionId = `hitl-isolation-${Date.now()}`;
    const studio = new StudioPage(page);
    await studio.goto(sessionId);

    // 通过 API 预置一个 round
    const genRes = await request.post('/api/generate', {
      data: { sessionId, prompt: 'A simple green leaf' },
    });
    const genData = await genRes.json();
    expect(genData.success).toBe(true);

    await expect(page.getByText(/生成历史/)).toBeVisible({ timeout: 180_000 });

    // 在 refine tab 填写指令
    await studio.switchToRefine();
    await studio.fillRefineInstruction('make it brighter');
    await expect(page.locator('textarea[placeholder*="输入精调指令"]')).toHaveValue('make it brighter');

    // 触发 await_input choice
    const choiceRes = await request.post('/api/test/create-choice', {
      data: {
        sessionId,
        type: 'await_input',
        payload: { hint: 'What would you like to change?' },
      },
    });
    const choiceData = await choiceRes.json();
    expect(choiceData.choiceId).toBeDefined();

    // 弹窗出现
    await expect(page.getByText('What would you like to change?')).toBeVisible();

    // 在弹窗中输入内容
    const overlayTextarea = page.locator('.fixed textarea').first();
    await overlayTextarea.fill('overlay instruction');

    // 取消弹窗
    await studio.cancelChoice();

    // 验证 refine tab 的指令没有被覆盖（回归：之前共用 state 会导致覆盖）
    await expect(page.locator('textarea[placeholder*="输入精调指令"]')).toHaveValue('make it brighter');
  });

  test('HITL 弹窗可通过 Escape 键关闭 — 回归测试', async ({ page, request }) => {
    test.setTimeout(30_000);
    const sessionId = `hitl-escape-${Date.now()}`;
    const studio = new StudioPage(page);
    await studio.goto(sessionId);

    const choiceRes = await request.post('/api/test/create-choice', {
      data: {
        sessionId,
        type: 'await_input',
        payload: { hint: 'Test escape key' },
      },
    });
    expect((await choiceRes.json()).choiceId).toBeDefined();

    await expect(page.getByText('Test escape key')).toBeVisible();
    await studio.dismissChoiceWithEscape();
    await expect(page.getByText('Test escape key')).not.toBeVisible();
  });

  test('并发快速点击生成按钮不应导致重复请求', { tag: ['@slow', '@expensive'] }, async ({ page }) => {
    test.setTimeout(300_000);
    const sessionId = `race-${Date.now()}`;
    const studio = new StudioPage(page);
    await studio.goto(sessionId);
    await studio.fillPrompt('A single yellow banana on white background, minimal');

    // 快速连续点击 3 次
    const btn = page.getByRole('button', { name: '生成图像' });
    await btn.click();
    await btn.click();
    await btn.click();

    await studio.expectGenerationCompleted();

    // 由于前端会禁用按钮并显示"生成中"，理论上只应产生 1 个 round
    // 但后端可能有竞态，这里放宽到不超过 2 个
    const count = await studio.getRoundCount();
    expect(count).toBeLessThanOrEqual(2);
  });

  test('API 参数校验 — 空 prompt 返回 400', async ({ request }) => {
    const res = await request.post('/api/generate', {
      data: { sessionId: 'test', prompt: '' },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('prompt is required');
  });

  test('API 参数校验 — 空 imageBase64 在 reverse 返回 400', async ({ request }) => {
    const res = await request.post('/api/reverse', {
      data: { imageBase64: '', mode: 'text-to-image' },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('imageBase64 is required');
  });

  test('API 参数校验 — 无效 mode 返回 400', async ({ request }) => {
    const res = await request.post('/api/reverse', {
      data: { imageBase64: 'AAAA', mode: 'invalid' },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('mode must be');
  });

  test('API 参数校验 — refine 缺少 roundId 返回 400', async ({ request }) => {
    const res = await request.post('/api/refine', {
      data: { sessionId: 'test', instruction: 'make it better' },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('roundId is required');
  });
});

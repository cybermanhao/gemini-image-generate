import { Page, expect } from '@playwright/test';

export class StudioPage {
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  // ─── Navigation ─────────────────────────────────────────────────────────────

  async goto(sessionId?: string) {
    const url = sessionId ? `/?session=${sessionId}` : '/';
    await this.page.goto(url);
    await this.expectLoaded();
  }

  async expectLoaded() {
    await expect(this.page.getByText('Gemini Image Studio')).toBeVisible();
  }

  // ─── Tabs ───────────────────────────────────────────────────────────────────

  async switchToGenerate() {
    await this.page.getByRole('button', { name: '生成', exact: true }).click();
    await expect(this.page.getByRole('button', { name: '生成图像' })).toBeVisible();
  }

  async switchToRefine() {
    await this.page.getByRole('button', { name: '精调', exact: true }).click();
  }

  async switchToReverse() {
    await this.page.getByRole('button', { name: '反推', exact: true }).click();
    await expect(this.page.getByText('上传图像进行反推')).toBeVisible();
  }

  // ─── Generate ───────────────────────────────────────────────────────────────

  async fillPrompt(prompt: string) {
    const textarea = this.page.locator('textarea').first();
    await textarea.fill(prompt);
  }

  async selectAspectRatio(ratio: string) {
    await this.page.locator('select').filter({ hasText: ratio }).first().selectOption(ratio);
  }

  async selectImageSize(size: string) {
    await this.page.locator('select').filter({ hasText: size }).first().selectOption(size);
  }

  async selectThinkingLevel(level: 'minimal' | 'high') {
    await this.page.locator('select').filter({ hasText: level }).first().selectOption(level);
  }

  async uploadSubjectImage(filePath: string) {
    const fileInput = this.page.locator('input[type="file"]').nth(0);
    await fileInput.setInputFiles(filePath);
    await expect(this.page.getByText('图生图模式')).toBeVisible();
  }

  async uploadStyleRef(filePath: string) {
    const fileInput = this.page.locator('input[type="file"]').nth(1);
    await fileInput.setInputFiles(filePath);
  }

  async clickGenerate() {
    await this.page.getByRole('button', { name: '生成图像' }).click();
  }

  async expectGenerationStarted() {
    await expect(this.page.getByRole('button', { name: /生成中/ })).toBeVisible();
  }

  async expectGenerationCompleted(timeout = 180_000) {
    await expect(this.page.getByText(/生成历史/)).toBeVisible({ timeout });
    await expect(this.page.locator('img[alt="result"]').first()).toBeVisible({ timeout });
  }

  async generate(prompt: string, opts?: {
    aspectRatio?: string;
    imageSize?: string;
    thinkingLevel?: 'minimal' | 'high';
    subjectFile?: string;
    styleRefFile?: string;
  }) {
    await this.switchToGenerate();
    await this.fillPrompt(prompt);
    if (opts?.aspectRatio) await this.selectAspectRatio(opts.aspectRatio);
    if (opts?.imageSize) await this.selectImageSize(opts.imageSize);
    if (opts?.thinkingLevel) await this.selectThinkingLevel(opts.thinkingLevel);
    if (opts?.subjectFile) await this.uploadSubjectImage(opts.subjectFile);
    if (opts?.styleRefFile) await this.uploadStyleRef(opts.styleRefFile);
    await this.clickGenerate();
    await this.expectGenerationStarted();
    await this.expectGenerationCompleted();
  }

  // ─── Rounds ─────────────────────────────────────────────────────────────────

  async selectRound(turn: number) {
    const btn = this.page.getByRole('button', { name: new RegExp(`Round ${turn} \\\\.`) });
    await btn.click();
    await expect(this.page.getByRole('heading', { name: new RegExp(`Round ${turn} 详情`) })).toBeVisible();
  }

  getRoundCount() {
    return this.page.locator('button', { hasText: /Round \d+/ }).count();
  }

  // ─── Refine ─────────────────────────────────────────────────────────────────

  async fillRefineInstruction(text: string) {
    const textarea = this.page.locator('textarea[placeholder*="输入精调指令"]');
    await textarea.fill(text);
  }

  async clickRefine() {
    await this.page.getByRole('button', { name: '执行精调' }).click();
  }

  async expectRefineStarted() {
    await expect(this.page.getByRole('button', { name: /精调中/ })).toBeVisible();
  }

  async expectRefineCompleted(timeout = 120_000) {
    await expect(this.page.locator('img[alt="result"]').first()).toBeVisible({ timeout });
  }

  async refine(instruction: string, opts?: { turn?: number; aspectRatio?: string; imageSize?: string }) {
    await this.switchToRefine();
    if (opts?.turn != null) await this.selectRound(opts.turn);
    if (opts?.aspectRatio) {
      await this.page.locator('select').filter({ hasText: opts.aspectRatio }).nth(1).selectOption(opts.aspectRatio);
    }
    if (opts?.imageSize) {
      await this.page.locator('select').filter({ hasText: opts.imageSize }).nth(2).selectOption(opts.imageSize);
    }
    await this.fillRefineInstruction(instruction);
    await this.clickRefine();
    await this.expectRefineStarted();
    await this.expectRefineCompleted();
  }

  // ─── Judge ──────────────────────────────────────────────────────────────────

  async clickJudge() {
    await this.page.getByRole('button', { name: 'LAAJ 评估' }).first().click();
  }

  async expectJudgeCompleted(timeout = 30_000) {
    await expect(this.page.getByText('SUBJECT_FIDELITY')).toBeVisible({ timeout });
    await expect(this.page.getByText(/\/ 5/).first()).toBeVisible();
  }

  async judgeRound(turn?: number) {
    await this.switchToRefine();
    if (turn != null) await this.selectRound(turn);
    await this.clickJudge();
    await this.expectJudgeCompleted();
  }

  // ─── Reverse ────────────────────────────────────────────────────────────────

  async uploadReverseImage(filePath: string) {
    await this.page.locator('input[type="file"]').setInputFiles(filePath);
  }

  async selectReverseMode(mode: 'text-to-image' | 'image-to-image') {
    await this.page.locator(`input[type="radio"][value="${mode}"]`).check();
  }

  async clickReverse() {
    await this.page.getByRole('button', { name: '开始反推' }).click();
  }

  async expectReverseCompleted(timeout = 30_000) {
    await expect(this.page.getByText('反推结果').first()).toBeVisible({ timeout });
  }

  async reverse(filePath: string, mode: 'text-to-image' | 'image-to-image') {
    await this.switchToReverse();
    await this.uploadReverseImage(filePath);
    await this.selectReverseMode(mode);
    await this.clickReverse();
    await this.expectReverseCompleted();
  }

  // ─── Human-in-the-loop ──────────────────────────────────────────────────────

  async expectChoiceOverlay(question?: string, timeout = 10_000) {
    if (question) {
      await expect(this.page.getByText(question)).toBeVisible({ timeout });
    } else {
      await expect(this.page.getByText('Option A')).toBeVisible({ timeout });
    }
  }

  async chooseOption(option: 'A' | 'B', reason?: string) {
    await this.page.getByText(`Option ${option}`).click();
    if (reason) {
      await this.page.locator('input[placeholder*="Reason"]').fill(reason);
    }
  }

  async cancelChoice() {
    await this.page.getByRole('button', { name: 'Cancel' }).click();
  }

  async submitHitlInstruction(instruction: string) {
    const textarea = this.page.locator('.fixed textarea').first();
    await textarea.fill(instruction);
    await this.page.getByRole('button', { name: 'Submit' }).click();
    await expect(this.page.getByText('What would you like to change?')).not.toBeVisible();
  }

  async dismissChoiceWithEscape() {
    // Focus overlay container so keydown reaches the onKeyDown handler
    await this.page.locator('.fixed').first().focus();
    await this.page.keyboard.press('Escape');
  }

  // ─── Context Snapshot ───────────────────────────────────────────────────────

  async toggleContextSnapshot() {
    await this.page.getByRole('button', { name: '上下文快照' }).click();
  }

  async expectContextSnapshotVisible() {
    await expect(this.page.getByText(/turns/)).toBeVisible();
  }

  // ─── Quick Actions ──────────────────────────────────────────────────────────

  async clickQuickInstruction(label: string) {
    await this.page.getByRole('button', { name: label }).click();
  }

  // ─── Error / Empty states ───────────────────────────────────────────────────

  async expectGenerateButtonDisabled() {
    await expect(this.page.getByRole('button', { name: '生成图像' })).toBeDisabled();
  }

  async expectRefineButtonDisabled() {
    await expect(this.page.getByRole('button', { name: '执行精调' })).toBeDisabled();
  }

  async expectEmptyRefineState() {
    await expect(this.page.getByText('先生成一张图像')).toBeVisible();
  }
}

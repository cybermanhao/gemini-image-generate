import { test, expect } from '@playwright/test';
import { StudioPage } from './pom/StudioPage';

const SIMPLE_PROMPT = 'A small green leaf on white background, flat lay photo';

test.describe.configure({ mode: 'serial' });

/**
 * E2E: Pure Web Mode — Full generate → refine → judge workflow
 */
test('pure web mode: generate and refine', { tag: ['@slow', '@expensive'] }, async ({ page }) => {
  test.setTimeout(240_000);
  const studio = new StudioPage(page);
  await studio.goto(`web-${Date.now()}`);

  // 1. Generate
  await studio.generate(SIMPLE_PROMPT);

  // 2. Refine
  await studio.refine('Add a soft shadow', { turn: 0 });

  // 3. Judge
  await studio.judgeRound(1);
});

/**
 * E2E: CLI + SSE Sync — External API call auto-reflects in browser
 */
test('sse sync: cli generate appears in browser without refresh', { tag: ['@slow', '@expensive'] }, async ({ page, request }) => {
  test.setTimeout(240_000);
  const sessionId = `sse-${Date.now()}`;
  const studio = new StudioPage(page);
  await studio.goto(sessionId);

  // 1. Verify empty state
  await studio.switchToRefine();
  await studio.expectEmptyRefineState();

  // 2. External API call (simulates CLI calling generate_image)
  const apiRes = await request.post('/api/generate', {
    data: { sessionId, prompt: SIMPLE_PROMPT },
  });
  const body = await apiRes.json();
  expect(body.success, `API error: ${body.error}`).toBe(true);
  expect(body.round).toBeDefined();

  // 3. Browser auto-syncs via SSE — no refresh needed
  await expect(page.getByText(/生成历史/)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('heading', { name: /Round 0/ })).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('img[alt="result"]').first()).toBeVisible();

  // 4. Verify session API reflects the round
  const sessionRes = await request.get(`/api/session/${sessionId}`);
  const sessionData = await sessionRes.json();
  expect(sessionData.exists).toBe(true);
  expect(sessionData.rounds.length).toBe(1);
});

/**
 * E2E: Human-in-the-loop — A/B comparison overlay
 */
test('human-in-the-loop: A/B choice overlay appears and resolves', { tag: ['@slow', '@expensive'] }, async ({ page, request }) => {
  test.setTimeout(240_000);
  const sessionId = `choice-ab-${Date.now()}`;
  const studio = new StudioPage(page);
  await studio.goto(sessionId);

  // 1. Seed two rounds via API (with gap to avoid session race)
  const gen1 = await request.post('/api/generate', {
    data: { sessionId, prompt: SIMPLE_PROMPT },
  });
  const data1 = await gen1.json();
  expect(data1.success, `Gen1 error: ${data1.error}`).toBe(true);

  await page.waitForTimeout(500);

  const gen2 = await request.post('/api/generate', {
    data: { sessionId, prompt: SIMPLE_PROMPT + ' with red tint' },
  });
  const data2 = await gen2.json();
  expect(data2.success, `Gen2 error: ${data2.error}`).toBe(true);

  // Wait for rounds to appear in browser
  await studio.switchToRefine();
  await expect(page.getByRole('heading', { name: /Round 1/ })).toBeVisible({ timeout: 180_000 });

  // Small gap before creating choice to ensure SSE connection is stable
  await page.waitForTimeout(300);

  // 2. Create a pending choice via test helper endpoint
  const choiceRes = await request.post('/api/test/create-choice', {
    data: {
      sessionId,
      type: 'ab_compare',
      payload: {
        question: 'Which image is better?',
        optionA: { roundId: data1.round.id, turn: 0, imageBase64: data1.round.imageBase64 },
        optionB: { roundId: data2.round.id, turn: 1, imageBase64: data2.round.imageBase64 },
      },
    },
  });
  const choiceData = await choiceRes.json();
  expect(choiceData.choiceId).toBeDefined();

  // 3. Overlay should appear via SSE
  await studio.expectChoiceOverlay('Which image is better?');

  // 4. Click Option A with reason
  await studio.chooseOption('A', 'Better lighting');

  // 5. Overlay disappears
  await expect(page.getByText('Which image is better?')).not.toBeVisible();
});

/**
 * E2E: Human-in-the-loop — await_input overlay flow
 */
test('human-in-the-loop: await_input overlay accepts instruction', async ({ page, request }) => {
  test.setTimeout(30_000);
  const sessionId = `choice-input-${Date.now()}`;
  const studio = new StudioPage(page);
  await studio.goto(sessionId);

  // Create await_input choice
  const choiceRes = await request.post('/api/test/create-choice', {
    data: {
      sessionId,
      type: 'await_input',
      payload: { hint: 'What refinement do you want?' },
    },
  });
  expect((await choiceRes.json()).choiceId).toBeDefined();

  await expect(page.getByText('What refinement do you want?')).toBeVisible();

  // Submit instruction via overlay
  await studio.submitHitlInstruction('Make the colors more vibrant');

  // Overlay should disappear
  await expect(page.getByText('What refinement do you want?')).not.toBeVisible();
});

/**
 * E2E: Agent Auto Mode — Full generate -> judge -> refine -> done loop
 *
 * This test exercises the real autoRefine pipeline with live Gemini API calls.
 * It verifies that the agent can complete the full closed-loop without human
 * intervention and that the Web UI syncs all rounds via SSE.
 */
test('agent auto mode: generate and auto-refine until converged', { tag: ['@slow', '@expensive'] }, async ({ page, request }) => {
  test.setTimeout(600_000);
  const sessionId = `auto-${Date.now()}`;
  const studio = new StudioPage(page);

  // 1. Agent calls generate with autoRefine=true
  const genRes = await request.post('/api/generate', {
    data: {
      sessionId,
      prompt: SIMPLE_PROMPT,
      autoRefine: true,
      maxRounds: 3,
    },
  });
  const genBody = await genRes.json();
  expect(genBody.success).toBe(true);
  expect(genBody.status).toBe('running');
  expect(genBody.sessionId).toBe(sessionId);

  // 2. Poll session status until done or error (max ~10 min)
  let status: any;
  for (let i = 0; i < 120; i++) {
    await page.waitForTimeout(5_000);
    const res = await request.get(`/api/session/${sessionId}/status`);
    status = await res.json();
    if (status.status === 'done' || status.status === 'error') break;
  }

  // Print error details for debugging when auto loop fails
  if (status.status === 'error') {
    console.log('[AUTO MODE ERROR]', JSON.stringify(status.error, null, 2));
  }
  expect(status.status).toBe('done');
  expect(status.roundsCount).toBeGreaterThanOrEqual(1);
  expect(status.mode).toBe('auto');

  // 3. Web UI auto-syncs all rounds via SSE — no refresh needed
  await studio.goto(sessionId);
  await expect(page.getByText(/生成历史/)).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('img[alt="result"]').first()).toBeVisible();

  // All rounds should be visible in the history
  for (let i = 0; i < status.roundsCount; i++) {
    await expect(page.getByRole('heading', { name: new RegExp(`Round ${i}`) })).toBeVisible();
  }

  // 4. Last round has LAAJ scores
  const lastRound = status.currentRound;
  expect(lastRound).toBeDefined();
  expect(lastRound.scores).toBeDefined();
  expect(Object.keys(lastRound.scores).length).toBeGreaterThanOrEqual(1);

  // 5. Convergence metadata sanity checks
  expect(status.converged || status.refineCount <= 3).toBe(true);
});

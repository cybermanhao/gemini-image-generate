/**
 * Screenshot [pic_N] drag-and-drop feature.
 * Calls API directly to generate an image, then captures the refine tab.
 */
import { chromium } from '@playwright/test';
import fs from 'fs';
import path from 'path';

const BASE_URL = 'http://localhost:3456';
const OUT_DIR = path.resolve(process.cwd(), '..', 'screenshots');

async function screenshotPage(page: any, name: string) {
  const file = path.join(OUT_DIR, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  console.log(`📸 ${file}`);
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log('🎭 Launching browser...');
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  // 1. Open page first so SSE connection is established
  const sessionId = 'picn-demo-' + Date.now();
  await page.goto(`${BASE_URL}?session=${sessionId}`);
  await page.waitForSelector('text=Gemini Image Studio');
  await page.waitForTimeout(500);

  // 2. Call API directly to generate an image
  console.log('🎨 Generating image via API...');
  const apiRes = await page.evaluate(async (sid) => {
    const res = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: sid,
        prompt: 'A cute cartoon cat sitting on a windowsill, watercolor style, soft colors',
        aspectRatio: '1:1',
        imageSize: '1K',
        thinkingLevel: 'minimal',
      }),
    });
    return { status: res.status, body: await res.json() };
  }, sessionId);

  console.log(`   API status: ${apiRes.status}`);
  if (apiRes.status !== 200) {
    console.log('   API response:', JSON.stringify(apiRes.body));
    throw new Error(`API failed: ${apiRes.status}`);
  }
  console.log(`   Round created: ${apiRes.body.round.id}`);

  // 3. Refresh page so getSession loads the existing rounds
  await page.reload();
  await page.waitForSelector('text=Gemini Image Studio');
  await page.waitForTimeout(800);
  console.log('   Page reloaded with rounds');

  // 4. Switch to Refine tab and select the round
  await page.getByRole('button', { name: '精调', exact: true }).click();
  await page.waitForTimeout(300);
  await page.locator('button:has(img[src^="data:image/png;base64,"])').first().click();
  await page.waitForTimeout(300);

  // 5. Try to drag the round image into the composer
  // The pool images include the round image. Find any pool image and drag.
  const poolImages = page.locator('img').filter({ has: page.locator('') }).or(
    page.locator('[class*="pool"] img')
  ).or(
    page.locator('button img')
  );

  // Find composer — look for contenteditable or the instruction composer wrapper
  const composer = page.locator('[contenteditable="true"]').first().or(
    page.locator('div[class*="composer"]').first()
  ).or(
    page.locator('div[role="textbox"]').first()
  );

  let dragged = false;
  try {
    const src = page.locator('button:has(img)').first().locator('img');
    const dest = composer;
    if (await src.count() > 0 && await dest.count() > 0) {
      await src.dragTo(dest, { force: true, timeout: 5000 });
      dragged = true;
      console.log('   Drag completed');
      await page.waitForTimeout(800);
    }
  } catch (e) {
    console.log('   Drag failed, proceeding with plain screenshot:', (e as Error).message);
  }

  // 6. Scroll the main container to bottom to reveal the instruction composer
  await page.evaluate(() => {
    const main = document.querySelector('main');
    if (main) main.scrollTop = main.scrollHeight;
  });
  await page.waitForTimeout(500);
  await screenshotPage(page, '05-picn-dragdrop');

  await browser.close();
  console.log('\n✅ Screenshot saved to', OUT_DIR);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

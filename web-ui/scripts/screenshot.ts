/**
 * Auto-screenshot script for README enrichment.
 * Uses Pokemon API data as generation prompt example,
 * Waifu.im image as reverse-engineering example.
 */
import { chromium, type Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';

const BASE_URL = 'http://localhost:3456';
const OUT_DIR = path.resolve(process.cwd(), '..', 'screenshots');

async function fetchPokemon(name: string) {
  const res = await fetch(`https://pokeapi.co/api/v2/pokemon/${name}`);
  if (!res.ok) throw new Error(`Pokemon API failed: ${res.status}`);
  return res.json();
}

async function fetchWaifuImage(): Promise<Buffer> {
  // waifu.pics API — returns random SFW anime image
  const res = await fetch('https://api.waifu.pics/sfw/waifu');
  if (!res.ok) throw new Error(`Waifu API failed: ${res.status}`);
  const data = await res.json();
  const imgRes = await fetch(data.url);
  return Buffer.from(await imgRes.arrayBuffer());
}

async function screenshotPage(page: Page, name: string) {
  const file = path.join(OUT_DIR, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  console.log(`📸 ${file}`);
  return file;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log('🔍 Fetching Pokemon data...');
  const pikachu = await fetchPokemon('pikachu');
  const types = pikachu.types.map((t: any) => t.type.name).join('/');
  const pokemonPrompt = `A cute ${types}-type Pokemon named ${pikachu.name}, ${pikachu.height / 10}m tall, ${pikachu.weight / 10}kg, yellow fur, red cheeks, lightning bolt tail, full body portrait, clean white background, anime style, high detail`;
  console.log(`   Prompt: ${pokemonPrompt.slice(0, 80)}...`);

  console.log('🔍 Fetching Waifu image...');
  const waifuBuf = await fetchWaifuImage();
  const waifuPath = path.join(OUT_DIR, 'waifu-example.jpg');
  fs.writeFileSync(waifuPath, waifuBuf);
  console.log(`   Saved: ${waifuPath}`);

  console.log('🎭 Launching browser...');
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  // ── Screenshot 1: Generate Tab (empty) ──
  console.log('📸 Screenshot 1: Generate Tab (empty)');
  await page.goto(`${BASE_URL}?session=readme-demo`);
  await page.waitForSelector('text=Gemini Image Studio');
  await page.waitForTimeout(500);
  await screenshotPage(page, '01-generate-empty');

  // ── Screenshot 2: Generate Tab (with Pokemon prompt) ──
  console.log('📸 Screenshot 2: Generate Tab (Pokemon prompt)');
  await page.locator('textarea[placeholder*="描述你想要生成的图像"]').fill(pokemonPrompt);
  await page.locator('select').nth(0).selectOption('1:1');
  await page.locator('select').nth(1).selectOption('2K');
  await page.waitForTimeout(300);
  await screenshotPage(page, '02-generate-pokemon');

  // ── Screenshot 3: Reverse Tab (with Waifu image) ──
  console.log('📸 Screenshot 3: Reverse Tab (Waifu image)');
  await page.getByRole('button', { name: '反推', exact: true }).click();
  await page.waitForTimeout(300);
  const fileInput = page.locator('input[type="file"]').first();
  await fileInput.setInputFiles(waifuPath);
  await page.waitForTimeout(800);
  await screenshotPage(page, '03-reverse-waifu');

  // ── Screenshot 4: Refine Tab (empty state) ──
  console.log('📸 Screenshot 4: Refine Tab (empty state)');
  await page.getByRole('button', { name: '精调', exact: true }).click();
  await page.waitForTimeout(300);
  await screenshotPage(page, '04-refine-empty');

  await browser.close();
  console.log('\n✅ All screenshots saved to', OUT_DIR);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

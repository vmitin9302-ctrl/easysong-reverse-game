import { chromium, devices, expect as baseExpect } from '@playwright/test';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';

const origin = process.env.QA_WEB_URL || 'https://xn--80aadskjyjbavcy.xn--p1ai';
const expect = baseExpect.configure({ timeout: 35000 });
const output = path.resolve(process.env.QA_OUTPUT || 'work/browser-qa');
await mkdir(output, { recursive: true });
const clip = Buffer.alloc(44 + 16000 * 2 * 3);
clip.write('RIFF'); clip.writeUInt32LE(clip.length - 8, 4); clip.write('WAVEfmt ', 8);
clip.writeUInt32LE(16, 16); clip.writeUInt16LE(1, 20); clip.writeUInt16LE(1, 22);
clip.writeUInt32LE(16000, 24); clip.writeUInt32LE(32000, 28); clip.writeUInt16LE(2, 32);
clip.writeUInt16LE(16, 34); clip.write('data', 36); clip.writeUInt32LE(clip.length - 44, 40);
for (let i = 0; i < 48000; i++) clip.writeInt16LE(Math.round(10000 * Math.sin(i * 2 * Math.PI * 440 / 16000)), 44 + i * 2);
const audioPath = path.join(output, 'microphone.wav');
await writeFile(audioPath, clip);
const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${audioPath}`] });
const errors = [];
const failures = [];
const contexts = [];
const pages = [];
try {
  for (const options of [{ viewport: { width: 1440, height: 1000 } }, { ...devices['iPhone 13'], defaultBrowserType: undefined }]) {
    const context = await browser.newContext({ ...options, permissions: ['microphone'] });
    contexts.push(context);
    if (process.env.QA_LOCAL_DIST) {
      await context.route(`${origin}/**`, async (route) => {
        const pathname = new URL(route.request().url()).pathname;
        const file = path.resolve(process.env.QA_LOCAL_DIST, pathname === '/' ? 'index.html' : `.${pathname}`);
        if (!file.startsWith(path.resolve(process.env.QA_LOCAL_DIST) + path.sep)) return route.abort();
        try { await route.fulfill({ body: await readFile(file), contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' }); }
        catch { await route.continue(); }
      });
    }
    const page = await context.newPage();
    page.setDefaultTimeout(35000);
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('requestfailed', (request) => failures.push({ failure: request.failure()?.errorText, path: new URL(request.url()).pathname }));
    page.on('response', (response) => {
      if (response.status() >= 400) failures.push({ status: response.status(), path: new URL(response.url()).pathname });
    });
    pages.push(page);
  }
  const [one, two] = pages;
  await one.goto(origin);
  await one.getByRole('button', { name: '🔗 Вдвоём на разных устройствах' }).click();
  const invite = one.locator('a[href*="?invite="]');
  await expect(invite).toBeVisible();
  const inviteUrl = await invite.getAttribute('href');
  await two.goto(inviteUrl);
  await expect(one.getByPlaceholder('Например: сегодня отличный день')).toBeVisible();
  for (let round = 1; round <= 2; round++) {
    console.log(`Browser round ${round}: phrase and recording`);
    const challenger = round === 1 ? one : two;
    const responder = round === 1 ? two : one;
    const phrase = round === 1 ? 'Сегодня отличный день' : 'Завтра будет солнце';
    await challenger.getByPlaceholder('Например: сегодня отличный день').fill(phrase);
    await challenger.waitForTimeout(6200);
    await expect(challenger.getByPlaceholder('Например: сегодня отличный день')).toHaveValue(phrase);
    await challenger.getByRole('button', { name: 'Сохранить и записать' }).click();
    await challenger.getByRole('button', { name: 'Разрешить микрофон' }).click();
    await challenger.locator('.mic-button').click();
    await challenger.waitForTimeout(1500);
    await challenger.locator('.mic-button').click();
    await expect(challenger.getByText('Так услышит соперник')).toBeVisible();
    await challenger.getByRole('button', { name: 'Слушать наоборот' }).click();
    await expect(challenger.getByRole('button', { name: 'Слушать наоборот' })).toBeEnabled();
    await challenger.getByRole('button', { name: 'Отправить сопернику' }).click();
    console.log(`Browser round ${round}: challenge sent`);
    await expect(responder.getByText('Послушай звук наоборот')).toBeVisible();
    await responder.reload();
    await expect(responder.getByText('Послушай звук наоборот')).toBeVisible();
    await responder.getByRole('button', { name: 'Слушать запись', exact: false }).click();
    await responder.getByRole('button', { name: '🎙 Повторить услышанное' }).click();
    await responder.locator('.mic-button').click();
    await responder.waitForTimeout(1500);
    await responder.locator('.mic-button').click();
    await expect(responder.getByText('Угадай исходную фразу')).toBeVisible();
    await expect(challenger.getByText('Послушай, что получилось у соперника')).toBeVisible();
    await responder.getByRole('button', { name: '▶ Слушать свою запись нормально' }).click();
    await responder.getByPlaceholder('Напиши свою догадку').fill(phrase);
    await responder.getByRole('button', { name: 'Ответить', exact: true }).click();
    for (const [index, page] of pages.entries()) {
      await expect(page.locator('.score-ring')).toHaveText('100%');
      await page.screenshot({ path: path.join(output, `round-${round}-player-${index + 1}.png`), fullPage: true });
    }
    await challenger.getByRole('button', { name: round === 1 ? 'Продолжить' : 'Общий результат', exact: true }).click();
    await responder.getByRole('button', { name: round === 1 ? 'Продолжить' : 'Общий результат', exact: true }).click();
  }
  for (const page of pages) await expect(page.getByText('ОНЛАЙН-ДУЭЛЬ ЗАВЕРШЕНА')).toBeVisible();
  expect(errors).toEqual([]);
  // Navigation cancels in-flight requests; activity may arrive after a game transition.
  // Neither is a failed game action. Keep them visible in the report.
  const unexpected = failures.filter((item) => item.failure !== 'net::ERR_ABORTED' && !(item.status === 409 && item.path.endsWith('/activity')));
  expect(unexpected).toEqual([]);
  console.log(JSON.stringify({ passed: true, scenarios: ['desktop + mobile Chromium', 'invite', 'draft heartbeat', 'MediaRecorder WAV upload', 'reverse playback', 'refresh participant resume', 'two rounds', 'shared scores', 'finish'], errors, unexpected, expectedNetworkEvents: failures }));
} catch (error) {
  for (const [index, page] of pages.entries()) {
    await page.screenshot({ path: path.join(output, `failure-${index}.png`), fullPage: true }).catch(() => {});
    console.error(`Player ${index + 1}: ${(await page.locator('body').innerText()).slice(0, 2000)}`);
  }
  console.error(JSON.stringify({ errors, failures }));
  throw error;
} finally {
  await browser.close();
}

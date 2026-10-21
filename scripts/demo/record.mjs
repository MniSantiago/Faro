// Graba el recorrido del GIF del README sobre el Faro de demostración (scripts/demo/start.ts) y lo deja en WebM.
// Necesita Playwright, que no es dependencia del proyecto. Instálalo aparte y pasa la carpeta:
//   npm i --prefix /tmp/pw playwright@1.60.0 && npx --prefix /tmp/pw playwright install chromium
//   PLAYWRIGHT_FROM=/tmp/pw/ node scripts/demo/record.mjs <carpeta-de-salida>
// Luego scripts/demo/gif.sh convierte el vídeo en docs/demo.gif.
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(process.env.PLAYWRIGHT_FROM ? path.resolve(process.env.PLAYWRIGHT_FROM) + '/' : import.meta.url);
const { chromium } = require('playwright');

const BASE = process.env.FARO_DEMO_URL ?? 'http://127.0.0.1:3299';
const out = path.resolve(process.argv[2] ?? 'demo-video');
const size = { width: 1280, height: 800 };

// Cursor visible en el vídeo (Playwright no graba el del sistema).
const CURSOR = `
  addEventListener('DOMContentLoaded', () => {
    const c = document.createElement('div');
    c.id = 'demo-cursor';
    c.style.cssText = 'position:fixed;z-index:99999;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;' +
      'background:rgba(245,185,66,.85);box-shadow:0 0 0 3px rgba(245,185,66,.3);pointer-events:none;left:-40px;top:-40px;transition:transform .12s';
    document.body.appendChild(c);
    addEventListener('mousemove', (e) => { c.style.left = e.clientX + 'px'; c.style.top = e.clientY + 'px'; }, true);
    addEventListener('mousedown', () => { c.style.transform = 'scale(.7)'; }, true);
    addEventListener('mouseup', () => { c.style.transform = ''; }, true);
  });`;

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: size, deviceScaleFactor: 1, colorScheme: 'dark', recordVideo: { dir: out, size } });
await context.addInitScript(CURSOR);
const page = await context.newPage();
const pause = (ms) => page.waitForTimeout(ms);

/** Lleva el cursor al elemento con un movimiento visible y hace clic. */
async function click(locator) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 18 });
  await pause(250);
  await locator.click();
}
async function type(locator, text) {
  await click(locator);
  await locator.pressSequentially(text, { delay: 45 });
}
/** Espera a que la tarea quede hecha (el agente trabaja, pasan las comprobaciones y Faro la integra). */
async function untilDone() {
  await page.getByText('Hecha', { exact: true }).first().waitFor({ timeout: 120_000 });
  await pause(1200);
}

async function newTask(projectId, title, description) {
  await page.goto(`${BASE}/#/nueva?p=${projectId}`);
  await pause(900);
  await type(page.getByLabel('Título'), title);
  await type(page.getByLabel('Descripción'), description);
  await pause(500);
  await click(page.getByRole('button', { name: 'Crear y arrancar' }));
}

// 1. Una tarea en un proyecto de un repo: el agente trabaja, pasan las comprobaciones y Faro la integra.
await newTask('blog', 'Filtrar entradas por etiqueta', 'Una función byTag que no distinga mayúsculas, con su test.');
await untilDone();
await page.mouse.wheel(0, 350);
await pause(2200);
await page.mouse.wheel(0, -350);
await pause(800);

// 2. Cambio de proyecto: una tarea sobre dos repos a la vez, que se integran juntos.
const picker = page.locator('nav select, aside select').first();
await click(picker);
await picker.selectOption('tienda');
await pause(1000);
await newTask('tienda', 'Mostrar el total del carrito', 'La API calcula el total y la app lo muestra bajo la lista.');
await untilDone();
await page.mouse.wheel(0, 400);
await pause(2500);
await page.mouse.wheel(0, -400);
await pause(1200);

await context.close();
await browser.close();
console.log(`vídeo en ${out}`);

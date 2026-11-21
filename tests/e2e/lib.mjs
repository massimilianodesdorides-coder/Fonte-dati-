// Strumenti per i test dell'interfaccia: serve demo.html e pilota un browser vero.
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ROOT } from '../lib/db.mjs';

export const IDS = {
  org1: 'a0000000-0000-4000-8000-000000000001', org2: 'a0000000-0000-4000-8000-000000000002',
  marco: 'b0000000-0000-4000-8000-000000000001', nina: 'b0000000-0000-4000-8000-000000000002',
  nico: 'b0000000-0000-4000-8000-000000000003', hilda: 'b0000000-0000-4000-8000-000000000005',
  giulia: 'b0000000-0000-4000-8000-000000000006', luca: 'b0000000-0000-4000-8000-000000000007',
};

export async function startServer() {
  const file = path.join(ROOT, 'demo.html');
  if (!fs.existsSync(file)) throw new Error('demo.html non trovato: esegui prima "python3 tools/build.py"');
  const html = fs.readFileSync(file);
  const srv = http.createServer((q, r) => { r.setHeader('content-type', 'text/html; charset=utf-8'); r.end(html); });
  await new Promise(ok => srv.listen(0, '127.0.0.1', ok));
  return { url: `http://127.0.0.1:${srv.address().port}/`, close: () => new Promise(ok => srv.close(ok)) };
}

export async function launch() {
  const opts = process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {};
  if (!opts.executablePath && fs.existsSync('/opt/pw-browsers/chromium')) opts.executablePath = '/opt/pw-browsers/chromium';
  return chromium.launch(opts);
}

// Una "sessione" = pagina nuova con database demo nuovo; raccoglie gli errori della console.
export async function session(browser, url, { width = 420, height = 900 } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error' && !/fonts\.g|ERR_TUNNEL|ERR_NAME|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  await page.goto(url);
  await page.waitForSelector('.hero', { timeout: 60000 });
  const wait = (ms = 700) => page.waitForTimeout(ms);
  const s = {
    page, errors, wait, ctx,
    async toast() { await wait(500); const t = await page.$('.toast'); return t ? (await t.textContent()).trim() : ''; },
    async as(id) { await page.click('text=Strumenti demo'); await page.click(`[data-dt=login][data-id="${id}"]`); await wait(); },
    async enter(id) { await page.click(`button[data-id="${id}"]`); await wait(); },
    async tool(k) { await page.click('text=Strumenti demo'); await page.click(`[data-dt=${k}]`); await wait(); await page.keyboard.press('Escape'); await wait(300); },
    async tab(name) { await page.click(`.tabs >> text=${name}`); await wait(); },
    async openGala() { await page.click('[data-act=openEvent]:has-text("Gala")'); await page.waitForSelector('text=Barman per il Gala'); },
    role(title) { return page.locator(`.card:has(h3:has-text("${title}"))`).first(); },
    async submit() { await page.click('.sheet button[type=submit]'); await wait(); },
    async close() { await ctx.close(); },
  };
  return s;
}

// controlli di accessibilità con axe-core: restituisce le violazioni gravi
export async function axe(page, { impact = ['serious', 'critical'] } = {}) {
  const require = createRequire(import.meta.url);
  await page.addScriptTag({ path: require.resolve('axe-core/axe.min.js') });
  const res = await page.evaluate(async () => await window.axe.run(document, { runOnly: ['wcag2a', 'wcag2aa'] }));
  return res.violations.filter(v => impact.includes(v.impact)).map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, help: v.help, sample: v.nodes[0].html.slice(0, 120) }));
}

// codice fiscale valido calcolato in modo indipendente (per i test)
const ODD = { 0: 1, 1: 0, 2: 5, 3: 7, 4: 9, 5: 13, 6: 15, 7: 17, 8: 19, 9: 21, A: 1, B: 0, C: 5, D: 7, E: 9, F: 13, G: 15, H: 17, I: 19, J: 21, K: 2, L: 4, M: 18, N: 20, O: 11, P: 3, Q: 6, R: 8, S: 12, T: 14, U: 16, V: 10, W: 22, X: 25, Y: 24, Z: 23 };
const cl = s => s.toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Z]/g, '');
const cons = s => cl(s).replace(/[AEIOU]/g, ''), vow = s => cl(s).replace(/[^AEIOU]/g, '');
export function makeCf(first, last, y, m, d, female) {
  const nm = cons(first).length >= 4 ? cons(first)[0] + cons(first)[2] + cons(first)[3] : (cons(first) + vow(first) + 'XXX').slice(0, 3);
  const body = (cons(last) + vow(last) + 'XXX').slice(0, 3) + nm + String(y).slice(-2) + 'ABCDEHLMPRST'[m - 1] + String(female ? d + 40 : d).padStart(2, '0') + 'H501';
  let t = 0; [...body].forEach((ch, i) => { t += i % 2 === 0 ? ODD[ch] : (/\d/.test(ch) ? +ch : ch.charCodeAt(0) - 65); });
  return body + String.fromCharCode(65 + t % 26);
}

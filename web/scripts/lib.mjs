// Shared helpers for the performance scripts (soak.mjs, frames.mjs, load.mjs): start a throwaway demo console that
// serves a production build, open it in headless Chromium, and navigate inside the app without reloading the page.
// Everything the console writes goes to a temporary directory that is removed on exit.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPARKLINE = resolve(WEB, '../server/.venv/bin/sparkline');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Start `sparkline --demo` on 127.0.0.1:port serving `dist`. Returns { url, stop }.
 * @param {{ port: number, dist?: string, speed?: number }} opts
 */
export async function startDemo({ port, dist = join(WEB, 'dist'), speed = 1 }) {
  const taken = await fetch(`http://127.0.0.1:${port}/healthz`).then(() => true, () => false);
  if (taken) throw new Error(`port ${port} is already in use (pick another with --port)`);
  const dir = mkdtempSync(join(tmpdir(), 'sparkline-perf-'));
  const config = join(dir, 'demo.toml');
  writeFileSync(config, `data_dir = "${join(dir, 'data')}"\n`);
  const args = ['--demo', '--demo-speed', String(speed), '--config', config, '--bind', '127.0.0.1', '--port', String(port), '--web-dist', dist, '--log-level', 'warning'];
  const proc = spawn(SPARKLINE, args, { stdio: ['ignore', 'ignore', 'inherit'] });
  const url = `http://127.0.0.1:${port}`;
  let exited = false;
  proc.on('exit', () => { exited = true; });
  const stop = async () => {
    if (!exited) {
      proc.kill('SIGTERM');
      for (let i = 0; i < 50 && !exited; i++) await sleep(100);
      if (!exited) proc.kill('SIGKILL');
    }
    rmSync(dir, { recursive: true, force: true });
  };
  for (let i = 0; i < 100; i++) {
    if (exited) break;
    try {
      if ((await fetch(`${url}/healthz`)).ok) return { url, stop };
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  await stop();
  throw new Error(`demo console did not start on port ${port}`);
}

/** Client-side navigation (wouter follows pushState + popstate): the page, its heap and its stores survive. */
export async function navigate(page, path) {
  await page.evaluate((p) => {
    history.pushState(null, '', p);
    dispatchEvent(new PopStateEvent('popstate'));
  }, path);
}

/** True once the overview shows live numbers (on two of the three demo node cards: spark3 drops out on schedule). */
export const overviewLive = () =>
  [...document.querySelectorAll('.ov-card')].filter((c) => /\d/.test(c.querySelector('.ov-card__stats .num')?.textContent ?? '')).length >= 2; // the demo takes spark3 offline for a while

export async function waitLive(page, timeout = 30_000) {
  await page.waitForFunction(overviewLive, null, { timeout });
}

/** Start a simulated benchmark run on the demo console; returns its id. */
export async function startBench(url, benchId, nodes, params = {}) {
  const res = await fetch(`${url}/api/v1/bench/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bench_id: benchId, nodes, params, confirm: true }),
  });
  if (!res.ok) throw new Error(`start ${benchId}: HTTP ${res.status} ${await res.text()}`);
  return (await res.json()).id;
}

export const quantile = (sorted, q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : NaN);

/** Least-squares line through (x, y): { slope, intercept }. */
export function fitLine(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
  }
  const slope = sxx ? sxy / sxx : 0;
  return { slope, intercept: my - slope * mx };
}

/** `--name value` / `--flag` command-line options with defaults from env. */
export function option(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}

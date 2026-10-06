// Shareable summary card: drawn to a canvas at 2x in the current theme's colours, previewed in a dialog, saved as a
// PNG or copied to the clipboard (where the browser allows images on the clipboard).
import { Check, Copy, Download } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useThemeVersion } from '../../charts/theme';
import { Button } from '../../design/components/Button';
import { Dialog } from '../../design/components/Dialog';
import type { BenchRun, BenchSpec } from '../../lib/types';
import { useCluster } from '../../store/cluster';
import { formatDateTime, formatValue, headlineResults, nodesText, paramsSummary, resultDelta, runFacts, servedModel, signedFormat, unitText } from './model';

export const CARD_W = 600;
export const CARD_H = 340;
const SCALE = 2;

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

function fit(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > max) t = t.slice(0, -1);
  return `${t}…`;
}

/** Up to two lines that fit `max` (words wrap; only a second line that still overflows gets an ellipsis). */
function wrap2(ctx: CanvasRenderingContext2D, text: string, max: number): string[] {
  if (ctx.measureText(text).width <= max) return [text];
  const words = text.split(' ');
  let first = '';
  while (words.length && ctx.measureText(first ? `${first} ${words[0] ?? ''}` : (words[0] ?? '')).width <= max) first = first ? `${first} ${words.shift() ?? ''}` : (words.shift() ?? '');
  if (!first) return [fit(ctx, text, max)];
  return [first, fit(ctx, words.join(' '), max)].filter(Boolean);
}

export function drawShareCard(canvas: HTMLCanvasElement, run: BenchRun, spec: BenchSpec | undefined, regressionPct: number): void {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string, fb: string) => cs.getPropertyValue(name).trim() || fb;
  const font = v('--font-sans', 'system-ui, sans-serif');
  const c = {
    bg: v('--surface-2', '#18191e'),
    glow: v('--bg-glow-1', 'rgba(98,116,255,0.16)'),
    text1: v('--text-1', '#f3f4f6'),
    text2: v('--text-2', '#a8acb5'),
    text3: v('--text-3', '#8b8f99'),
    sep: v('--separator-strong', 'rgba(255,255,255,0.14)'),
    accent: v('--accent-fill', '#4b5ee4'),
    ok: v('--ok-text', '#62db9a'),
    warn: v('--warn-text', '#f6c566'),
    crit: v('--crit-text', '#ff8c85'),
  };
  canvas.width = CARD_W * SCALE;
  canvas.height = CARD_H * SCALE;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(SCALE, 0, 0, SCALE, 0, 0);
  ctx.clearRect(0, 0, CARD_W, CARD_H);

  // Surface + ambient glow + hairline.
  roundRect(ctx, 0, 0, CARD_W, CARD_H, 24);
  ctx.save();
  ctx.clip();
  ctx.fillStyle = c.bg;
  ctx.fillRect(0, 0, CARD_W, CARD_H);
  const g = ctx.createRadialGradient(80, -40, 10, 80, -40, 420);
  g.addColorStop(0, c.glow);
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, CARD_W, CARD_H);
  ctx.restore();
  ctx.strokeStyle = c.sep;
  ctx.lineWidth = 1;
  roundRect(ctx, 0.5, 0.5, CARD_W - 1, CARD_H - 1, 24);
  ctx.stroke();

  const pad = 32;
  // Wordmark.
  roundRect(ctx, pad, pad, 26, 26, 8);
  ctx.fillStyle = c.accent;
  ctx.fill();
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  const s = 26 / 32;
  [[7, 19.5], [11, 19.5], [13.5, 12.5], [17.5, 24.5], [20.5, 15.5], [22, 19.5], [25, 19.5]].forEach(([x = 0, y = 0], i) => {
    const px = pad + x * s;
    const py = pad + y * s;
    if (i) ctx.lineTo(px, py);
    else ctx.moveTo(px, py);
  });
  ctx.stroke();
  ctx.fillStyle = c.text1;
  ctx.font = `650 15px ${font}`;
  ctx.textBaseline = 'middle';
  ctx.fillText('Sparkline', pad + 36, pad + 13);
  ctx.fillStyle = c.text3;
  ctx.font = `500 12px ${font}`;
  ctx.textAlign = 'right';
  ctx.fillText(formatDateTime(run.finished_ts ?? run.created_ts), CARD_W - pad, pad + 13);
  ctx.textAlign = 'left';

  // Title + context.
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = c.text1;
  ctx.font = `700 26px ${font}`;
  ctx.fillText(fit(ctx, spec?.name ?? run.bench_id, CARD_W - pad * 2), pad, 104);
  ctx.fillStyle = c.text2;
  ctx.font = `400 13px ${font}`;
  const sub = [nodesText(run.bench_id, run.nodes), servedModel(run.results), paramsSummary(spec, run.params, 2)].filter(Boolean).join('  ·  ');
  ctx.fillText(fit(ctx, sub, CARD_W - pad * 2), pad, 126);

  // Headline results.
  const heads = headlineResults(run.results, 3);
  const colW = (CARD_W - pad * 2) / Math.max(1, heads.length);
  heads.forEach((r, i) => {
    const x = pad + i * colW;
    ctx.fillStyle = c.text3;
    ctx.font = `600 11px ${font}`;
    wrap2(ctx, `${r.label}${r.node_id && run.nodes.length > 1 ? ` · ${r.node_id}` : ''}`.toUpperCase(), colW - 16).forEach((line, j, all) => {
      ctx.fillText(line, x, 172 - (all.length - 1 - j) * 14);
    });
    ctx.fillStyle = c.text1;
    ctx.font = `700 ${heads.length > 2 ? 36 : 44}px ${font}`;
    const num = signedFormat(r)(r.value);
    ctx.fillText(num, x, heads.length > 2 ? 214 : 220);
    const nw = ctx.measureText(num).width;
    ctx.fillStyle = c.text2;
    ctx.font = `500 15px ${font}`;
    ctx.fillText(unitText(r.unit), x + nw + 6, heads.length > 2 ? 214 : 220);
    const d = resultDelta(r, regressionPct);
    ctx.font = `600 12px ${font}`;
    if (d) {
      ctx.fillStyle = d.regression ? c.crit : d.tone === 'better' ? c.ok : d.tone === 'worse' ? c.warn : c.text2;
      const word = d.regression ? 'Regression' : d.tone === 'better' ? 'better' : d.tone === 'worse' ? 'worse' : 'same';
      ctx.fillText(fit(ctx, heads.length > 2 ? `${d.text} · ${word}` : `${d.text} vs baseline · ${word}`, colW - 16), x, 244);
    } else {
      ctx.fillStyle = c.text3;
      ctx.fillText(run.baseline_for ? 'Baseline run' : 'No baseline', x, 244);
    }
  });
  if (!heads.length) {
    ctx.fillStyle = c.text2;
    ctx.font = `500 15px ${font}`;
    ctx.fillText('No results', pad, 210);
  }

  // Footer: environment.
  ctx.strokeStyle = c.sep;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(pad, 278.5);
  ctx.lineTo(CARD_W - pad, 278.5);
  ctx.stroke();
  const f = runFacts(run);
  const env = [f.gpu, f.driver ? `Driver ${f.driver}` : null, f.cuda ? `CUDA ${f.cuda}` : null].filter(Boolean).join('  ·  ') || 'Environment not recorded';
  ctx.fillStyle = c.text2;
  ctx.font = `500 12px ${font}`;
  ctx.fillText(fit(ctx, env, CARD_W - pad * 2 - 120), pad, 306);
  ctx.fillStyle = c.text3;
  ctx.textAlign = 'right';
  ctx.fillText(`Run ${run.id.slice(0, 8)}`, CARD_W - pad, 306);
  ctx.textAlign = 'left';
}

const canCopyImages = () => typeof ClipboardItem !== 'undefined' && 'clipboard' in navigator && typeof navigator.clipboard.write === 'function';

export function ShareCardDialog({ run, spec, onClose }: { run: BenchRun; spec: BenchSpec | undefined; onClose: () => void }) {
  const theme = useThemeVersion();
  const regressionPct = useCluster((s) => s.cluster?.settings.regression_pct ?? 5);
  const [png, setPng] = useState<{ url: string; blob: Blob } | null>(null);
  const [copied, setCopied] = useState<'idle' | 'done' | 'failed'>('idle');

  useEffect(() => {
    let cancelled = false;
    void document.fonts.ready.then(() => {
      if (cancelled) return;
      const canvas = document.createElement('canvas');
      drawShareCard(canvas, run, spec, regressionPct);
      canvas.toBlob((blob) => {
        if (!blob || cancelled) return;
        setPng({ url: URL.createObjectURL(blob), blob });
      }, 'image/png');
    });
    return () => { cancelled = true; };
  }, [run, spec, regressionPct, theme]);
  // Revoke a PNG only once its replacement is shown (or on close), so the download link never points at a revoked URL.
  useEffect(() => () => { if (png) URL.revokeObjectURL(png.url); }, [png]);

  const fileName = `sparkline-${run.bench_id}-${new Date((run.finished_ts ?? run.created_ts) * 1000).toISOString().slice(0, 10)}.png`;
  const copy = () => {
    if (!png) return;
    navigator.clipboard.write([new ClipboardItem({ 'image/png': png.blob })]).then(
      () => { setCopied('done'); },
      () => { setCopied('failed'); },
    );
  };
  const heads = headlineResults(run.results, 3).map((r) => `${r.label} ${formatValue(r.value)} ${unitText(r.unit)}`).join(', ');

  return (
    <Dialog
      open
      onClose={onClose}
      title="Share card"
      size="lg"
      description="A summary of this run in the current theme, ready to paste into a chat or a report."
      footer={
        <>
          <span className="bench-share__status" role="status">
            {copied === 'done' ? 'Copied to the clipboard' : copied === 'failed' ? 'The browser blocked the clipboard — download instead' : ''}
          </span>
          {canCopyImages() ? (
            <Button variant="secondary" icon={copied === 'done' ? <Check /> : <Copy />} disabled={!png} onClick={copy}>Copy image</Button>
          ) : null}
          {png ? (
            <a className="btn btn--primary btn--md" href={png.url} download={fileName}>
              <span className="btn__icon" aria-hidden="true"><Download /></span>Download PNG
            </a>
          ) : (
            <Button variant="primary" icon={<Download />} disabled>Download PNG</Button>
          )}
        </>
      }
    >
      <div className="bench-share__preview" style={{ aspectRatio: `${CARD_W} / ${CARD_H}` }}>
        {png ? <img src={png.url} width={CARD_W} height={CARD_H} alt={`Sparkline share card: ${spec?.name ?? run.bench_id} on ${nodesText(run.bench_id, run.nodes)}. ${heads}.`} /> : null}
      </div>
    </Dialog>
  );
}

// @vitest-environment node
import { ESLint, Linter } from 'eslint';
import tseslint from 'typescript-eslint';

const PLUGIN = 'sparkline';
const RULE = `${PLUGIN}/gpu-index`;

const flagged = [
  's.gpu[0]',
  'info.gpus[0]',
  's?.gpu?.[0]',
  's.gpu.at(0)',
  'info?.gpus.at(-1)',
  'gpus[0]',
  'gpu[1]',
  'gpus?.[0]',
  'gpus.at(-1)',
  'gpu?.at(0)',
  "s['gpu'][0]",
  "info['gpus'].at(0)",
  'const [g] = s.gpu',
  'const [a, b] = info.gpus',
  'const [g] = s?.gpu',
  'const [g] = gpus',
  '[g] = s.gpu',
  'const { gpu: [g] } = s',
  'const { gpus: [a, b] } = info',
  '[...s.gpu][0]',
  'Array.from(s.gpu)[0]',
  's.gpu.filter(Boolean)[0]',
  's.gpu.toReversed()[0]',
  's.gpu.find((_, i) => i === 0)',
  'info.gpus.map((g) => g.name)[0]',
  '[...s.gpu].toReversed().at(0)',
  'const [g] = s.gpu.filter(Boolean)',
  's.gpu.reduce((a, g, i) => a, 0)',
  '(s.gpu ?? [])[0]',
  '(ok ? s.gpu : [])[0]',
  'const { gpu: [g] = [] } = s',
  's.gpu.pop()',
  'info.gpus.shift()',
  'const copy = [...s.gpu]; copy[0]',
  'const hot = s.gpu.filter(Boolean); hot.at(0)',
  's.gpu.slice(0, 1)',
  'info.gpus.slice(1)',
  'let x; x = s.gpu; x[0]',
  'structuredClone(s.gpu)[0]',
  's.gpu.values().next().value',
  'const {0: z} = s.gpu',
  '({ 0: g } = s.gpu)',
  'Object.values(s.gpu)[0]',
  '[].concat(s.gpu)[0]',
  'for (const [i, g] of s.gpu.entries()) use(i, g)',
  's.gpu.with(0, g)',
  'const { gpu: r } = s; r[0]',
  'const { gpu: a = [] } = s; a[0]',
  'const { gpus: g } = maybe ?? { gpus: [] }; g[0]',
  'const { gpu: r } = s; r.at(0)',
  'const { gpu: r } = s; r.slice(1)',
  'const { gpu: r } = s; const [first] = r',
  '({ gpu: r }) => r[0]',
  'function f({ gpus: list }) { return list.at(0) }',
  'let r; ({ gpu: r } = s); r[0]',
  'const { info: { gpus: list } } = node; list[0]',
  'const gpus = load(); gpus.keys()',
];

const allowed = [
  'gpuAt(s.gpu, 0)',
  'gpuAt(info?.gpus, 0)',
  's.gpu.map((g) => g.index)',
  's.gpu.length',
  'gpus.find((g) => g.index === 0)',
  'const { gpu } = s',
  'for (const g of s.gpu) use(g)',
  'const [first] = s.cores',
  'values[0]',
  's.gpu.find((g) => g.index === 0)',
  '[...s.cores][0]',
  'Array.from(values)[0]',
  's.gpu.filter(Boolean).length',
  'const { cores: [c] } = s',
  's.gpu.toSorted((a, b) => b.temp_c - a.temp_c)[0]',
  '(s.cores ?? [])[0]',
  'const copy = [...s.cores]; copy[0]',
  'const names = s.gpu.map((g) => g.name); names.length',
  's.gpu.slice()',
  'const { length } = s.gpu',
  'let x; x = s.cores; x[0]',
  'structuredClone(s.cores)[0]',
  'for (const g of s.gpu.values()) use(g)',
  'Object.values(s.cores)[0]',
  'const { gpu: r } = s; r.length',
  'const { gpu: r } = s; gpuAt(r, 0)',
  'const { cores: r } = s; r[0]',
  's.errors.gpu?.slice(0, 80)',
  's.errors.gpu?.[0]',
  'errors.gpu?.slice(0, 80)',
  'const { gpu: msg } = s.errors; msg?.slice(0, 80)',
  'let msg; ({ gpu: msg } = s.errors); msg?.[0]',
  "const gpus = new Map([[0, 'a']]); [...gpus.keys()]",
  "const gpus = new Map([[0, 'a']]); [...gpus.entries()]",
  'const gpus = new Set([0]); [...gpus.keys()]',
];

async function lint(): Promise<(code: string) => number> {
  const config = (await new ESLint().calculateConfigForFile('src/lib/gpu.ts')) as Linter.Config;
  const plugin = config.plugins?.[PLUGIN] ?? {};
  const rule = config.rules?.[RULE];
  const linter = new Linter({ configType: 'flat' });
  const only: Linter.Config[] = [{ files: ['**/*.ts'], languageOptions: { parser: tseslint.parser }, plugins: { [PLUGIN]: plugin }, rules: { [RULE]: rule ?? 'off' } }];
  return (code) => linter.verify(`let g, a, b; ${code};`, only, 'probe.ts').filter((m) => m.ruleId === RULE).length;
}

describe('the lint rule that makes code read a GPU by its index', () => {
  it.each(flagged)('flags %s', async (code) => {
    expect((await lint())(code)).toBe(1);
  });

  it.each(allowed)('allows %s', async (code) => {
    expect((await lint())(code)).toBe(0);
  });
});

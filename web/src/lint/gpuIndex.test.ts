// @vitest-environment node
import { ESLint, Linter } from 'eslint';
import tseslint from 'typescript-eslint';

const RULE = 'no-restricted-syntax';

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
];

async function lint(): Promise<(code: string) => number> {
  const config = (await new ESLint().calculateConfigForFile('src/lib/gpu.ts')) as Linter.Config;
  const rule = config.rules?.[RULE];
  const linter = new Linter({ configType: 'flat' });
  const only: Linter.Config[] = [{ files: ['**/*.ts'], languageOptions: { parser: tseslint.parser }, rules: { [RULE]: rule ?? 'off' } }];
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

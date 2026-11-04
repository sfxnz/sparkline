import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import jsxA11y from 'eslint-plugin-jsx-a11y';

/** Matches when `at` is a GPU list: `gpus`, `x.gpu`, `x?.gpu`, `x['gpus']`. */
const gpuList = (at) => [`${at}.name`, `${at}.property.name`, `${at}.property.value`, `${at}.expression.property.name`].map((k) => `[${k}=/^gpus?$/]`).join(', ');

export default tseslint.config(
  { ignores: ['dist', 'playwright-report', 'test-results', 'screenshots', 'node_modules'] },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.strictTypeChecked, jsxA11y.flatConfigs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      'no-restricted-syntax': [
        'error',
        ...[
          'MemberExpression[computed=true]:matches(OBJ)',
          "CallExpression[callee.property.name='at']:matches(CALLEE)",
          "VariableDeclarator[id.type='ArrayPattern']:matches(INIT)",
          "AssignmentExpression[left.type='ArrayPattern']:matches(RIGHT)",
        ].map((selector) => ({
          selector: selector.replace(/OBJ|CALLEE|INIT|RIGHT/, (at) => gpuList({ OBJ: 'object', CALLEE: 'callee.object', INIT: 'init', RIGHT: 'right' }[at])),
          message: 'Read a GPU by its index with gpuAt() (lib/gpu.ts): a sample lists only the GPUs that reported, so position 0 can be another vendor.',
        })),
      ],
    },
  },
  {
    files: ['eslint.config.js'],
    extends: [js.configs.recommended],
    languageOptions: { globals: globals.node },
  },
);

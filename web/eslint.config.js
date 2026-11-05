import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import gpuIndex from './eslint-rules/gpu-index.js';

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
    plugins: { 'react-hooks': reactHooks, sparkline: { rules: { 'gpu-index': gpuIndex } } },
    rules: {
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      'sparkline/gpu-index': 'error',
    },
  },
  {
    files: ['eslint.config.js', 'eslint-rules/*.js'],
    extends: [js.configs.recommended],
    languageOptions: { globals: globals.node },
  },
);

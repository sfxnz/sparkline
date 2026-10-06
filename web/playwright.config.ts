import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT ?? 5180);
/** The demo console the flow tests run against (started below with a throwaway data dir). */
const DEMO_PORT = Number(process.env.E2E_DEMO_PORT ?? 9702);
const DEMO_DIR = '.e2e-demo'; // git-ignored; recreated on every run so acks and settings start clean

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
  webServer: [
    {
      // Simulated spark1-3, including the scripted thermal episode, stalls and spark3 going offline.
      command: [
        `rm -rf ${DEMO_DIR} && mkdir -p ${DEMO_DIR}`,
        `printf 'data_dir = "%s"\\n' "$PWD/${DEMO_DIR}/data" > ${DEMO_DIR}/demo.toml`,
        `exec ../server/.venv/bin/sparkline --demo --config ${DEMO_DIR}/demo.toml --bind 127.0.0.1 --port ${DEMO_PORT}`,
      ].join(' && '),
      url: `http://127.0.0.1:${DEMO_PORT}/healthz`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      // The production build behind vite preview, which proxies /api (REST + WS) to the demo console. Tests that
      // need a specific console state stub /api per test instead.
      command: `npm run build && npx vite preview --port ${PORT} --strictPort --host 127.0.0.1`,
      url: `http://127.0.0.1:${PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: { SPARKLINE_URL: `http://127.0.0.1:${DEMO_PORT}` },
    },
  ],
});

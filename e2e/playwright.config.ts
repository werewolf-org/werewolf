import { defineConfig, devices } from '@playwright/test';
import path from 'path';

// Browser end-to-end: a real Vite dev server serving the real frontend, proxying
// /socket.io to a real backend. One browser context per player, i.e. one phone each.

const BACKEND_PORT = Number(process.env.E2E_BACKEND_PORT ?? 3210);
const FRONTEND_PORT = Number(process.env.E2E_FRONTEND_PORT ?? 5273);
const repoRoot = path.resolve(__dirname, '..');

// Two Playwright runs share nothing but these ports, so a second concurrent run (another
// agent, another CI job) must pick different ones:
//   E2E_BACKEND_PORT=3211 E2E_FRONTEND_PORT=5274 npm run test:e2e
// Never reuse a server when the ports were chosen explicitly: a stale dev server on the
// same port would silently serve old code and produce impossible results.
const useFixedPorts = process.env.E2E_BACKEND_PORT === undefined && process.env.E2E_FRONTEND_PORT === undefined;
const reuseExistingServer = useFixedPorts && !process.env.CI;

export default defineConfig({
    testDir: path.resolve(__dirname, 'specs'),
    // Keep artifacts per port so two concurrent runs do not overwrite each other.
    outputDir: path.resolve(__dirname, 'test-results', String(FRONTEND_PORT)),
    // A phone flow with animated CSS is slower than an API test; keep it generous.
    timeout: 45_000,
    expect: { timeout: 10_000 },
    workers: process.env.CI ? 1 : 2,
    retries: process.env.CI ? 1 : 0,
    reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
    use: {
        baseURL: `http://localhost:${FRONTEND_PORT}`,
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
    },
    projects: [
        {
            name: 'mobile-chromium',
            use: {
                ...devices['iPhone 13'],
                // The device descriptor defaults to WebKit; chromium keeps the download small.
                browserName: 'chromium',
            },
        },
    ],
    webServer: [
        {
            command: 'npm start',
            cwd: path.resolve(repoRoot, 'backend'),
            port: BACKEND_PORT,
            env: { PORT: String(BACKEND_PORT) },
            reuseExistingServer,
            timeout: 60_000,
        },
        {
            command: `npx vite --mode e2e --port ${FRONTEND_PORT} --strictPort`,
            cwd: path.resolve(repoRoot, 'frontend'),
            url: `http://localhost:${FRONTEND_PORT}`,
            env: { API_PROXY_TARGET: `http://localhost:${BACKEND_PORT}` },
            reuseExistingServer,
            timeout: 60_000,
        },
    ],
});

import { defineConfig } from '@playwright/test';
import { normalizeBasePath, mountPath } from './shared/mount.ts';

const basePath = normalizeBasePath(process.env.APP_BASE_PATH);

export default defineConfig({
  testDir: './tests', testMatch: '**/*.spec.ts',
  fullyParallel: false, workers: 1, timeout: 35_000,
  outputDir: '.data/browser-results',
  reporter: 'list',
  use: {
    baseURL: `http://127.0.0.1:4311${basePath}`,
    browserName: 'chromium',
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } }
      : process.env.CI ? {} : { channel: 'chrome' }),
    trace: 'retain-on-failure', screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1440, height: 1000 } } },
    { name: 'mobile', use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } },
  ],
  webServer: {
    command: 'node --import tsx scripts/e2e-server.ts',
    url: `http://127.0.0.1:4311${mountPath('/api/health', basePath)}`, reuseExistingServer: false,
    timeout: 20_000,
  },
});

import { defineConfig } from '@playwright/test'

const baseURL = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:5173'
const disableWebServer = process.env.PLAYWRIGHT_DISABLE_WEBSERVER === '1'
const webServerCommand = process.env.PLAYWRIGHT_SERVER_COMMAND || 'npm run dev -- --host 127.0.0.1'
const webServerUrl = process.env.PLAYWRIGHT_SERVER_URL || baseURL
const browserChannel = process.env.PLAYWRIGHT_CHANNEL || undefined
const browserArgs = process.env.PLAYWRIGHT_CONTAINER === '1'
  ? ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-crash-reporter']
  : undefined

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  reporter: 'list',
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  webServer: disableWebServer
    ? undefined
    : {
        command: webServerCommand,
        url: webServerUrl,
        reuseExistingServer: !process.env.CI,
      },
  projects: [
    {
      name: 'desktop',
      use: { browserName: 'chromium', channel: browserChannel, launchOptions: { args: browserArgs }, viewport: { width: 1280, height: 720 } },
    },
    {
      name: 'tablet',
      use: { browserName: 'chromium', channel: browserChannel, launchOptions: { args: browserArgs }, viewport: { width: 768, height: 1024 } },
    },
    {
      name: 'mobile',
      use: { browserName: 'chromium', channel: browserChannel, launchOptions: { args: browserArgs }, viewport: { width: 390, height: 844 } },
    },
  ],
})

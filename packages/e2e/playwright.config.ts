import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  reporter: 'list',
  use: {
    baseURL: process.env.BASE_URL || 'http://localhost:8080',
    headless: true,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
})


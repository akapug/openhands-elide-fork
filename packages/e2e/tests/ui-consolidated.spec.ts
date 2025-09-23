import { test, expect } from '@playwright/test'

// Minimal checks for consolidated UI: core controls, accordions, and defaults

test.describe('Consolidated UI', () => {
  test('shows Target Status and core controls', async ({ page }) => {
    await page.goto('/')

    // Title visible
    await expect(page.getByRole('heading', { level: 1, name: 'Elide-Bench' })).toBeVisible()

    // Target Status block
    await expect(page.getByRole('heading', { level: 3, name: 'Target Status' })).toBeVisible()

    // Core controls
    await expect(page.getByRole('button', { name: /Run Full Suite/i })).toBeVisible()
    await expect(page.getByRole('button', { name: /Check Health|Checking/i })).toBeVisible()
  })

  test('accordions exist and Comparative is open by default', async ({ page }) => {
    await page.goto('/')

    const streaming = page.locator('#sec-streaming')
    const http = page.locator('#sec-http')
    const conc = page.locator('#sec-concurrency')
    const comp = page.locator('#sec-comparative')
    const results = page.locator('#sec-results')

    await expect(streaming).toBeVisible()
    await expect(http).toBeVisible()
    await expect(conc).toBeVisible()
    await expect(comp).toBeVisible()
    await expect(results).toBeVisible()

    // Comparative details should be open by default
    await expect(comp).toHaveJSProperty('open', true)

    // Start servers checkbox present (existence check)
    const startServersLabels = await page.locator('label:has-text("Start servers")').count()
    expect(startServersLabels).toBeGreaterThan(0)
  })

  test('health check button toggles and does not crash', async ({ page }) => {
    await page.goto('/')
    const btn = page.getByRole('button', { name: /Check Health|Checking/ })
    await expect(btn).toBeVisible()
    await btn.click()
    // It may show Checking… momentarily; ensure page still alive and Target Status heading present
    await expect(page.getByRole('heading', { level: 3, name: 'Target Status' })).toBeVisible()
  })
})


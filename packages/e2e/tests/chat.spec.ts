import { test, expect } from '@playwright/test'

test('loads UI and shows title', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByText('OpenHands–Elide')).toBeVisible()
})


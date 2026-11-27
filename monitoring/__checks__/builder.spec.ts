import { test, expect } from '@playwright/test'

// The live builder on GitHub Pages: https://camduncalfe.github.io/agent-pfp/
const SITE = process.env.SITE_URL ?? 'https://camduncalfe.github.io/agent-pfp/'

/** Width and height from a PNG's IHDR chunk, or null when the bytes aren't a PNG. */
function pngSize(bytes: Buffer): { width: number; height: number } | null {
  const signature = '89504e470d0a1a0a'
  if (bytes.length < 24 || bytes.subarray(0, 8).toString('hex') !== signature) return null
  if (bytes.subarray(12, 16).toString('ascii') !== 'IHDR') return null
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

test('a visitor builds an alien pfp and downloads it at GitHub size', async ({ page }) => {
  await page.goto(SITE)

  // The site's index page sends the visitor on to the builder, which opens the alien style.
  await expect(page).toHaveURL(/\/web\/\?style=alien$/)
  await expect(page.locator('#character-pick')).toHaveText('Alien')
  const randomize = page.locator('#randomize')
  await expect(randomize).toBeEnabled({ timeout: 20_000 })

  // The preview is drawn from the layers: every pixel of the 1024 px canvas is covered.
  const preview = page.locator('#preview')
  const covered = await preview.evaluate((canvas: HTMLCanvasElement) => {
    const { data } = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height)
    let opaque = 0
    for (let i = 3; i < data.length; i += 4) if (data[i] === 255) opaque++
    return { width: canvas.width, height: canvas.height, opaque }
  })
  expect(covered.width).toBe(1024)
  expect(covered.opaque).toBe(covered.width * covered.height)

  // Randomize picks new traits. Five trait tabs follow Character.
  const picks = page.locator('.pick')
  await expect(picks).toHaveCount(6)
  const before = await picks.allTextContents()
  let after = before
  for (let tries = 0; tries < 5 && after.join('|') === before.join('|'); tries++) {
    await randomize.click()
    after = await picks.allTextContents()
  }
  expect(after, 'Randomize changed at least one trait').not.toEqual(before)
  expect(after[0]).toBe('Alien')

  // Download at GitHub size and check the file is a 500 x 500 PNG.
  await page.getByLabel('GitHub (500 x 500)').check()
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#download').click(),
  ])
  expect(download.suggestedFilename()).toBe('agent-pfp-alien-500.png')
  const chunks: Buffer[] = []
  for await (const chunk of await download.createReadStream()) chunks.push(chunk as Buffer)
  const bytes = Buffer.concat(chunks)
  expect(pngSize(bytes)).toEqual({ width: 500, height: 500 })
  expect(bytes.length).toBeGreaterThan(50_000)
})

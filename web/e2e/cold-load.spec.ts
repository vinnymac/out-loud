import { test, expect, type Page } from "@playwright/test";

// Proves the web build's defining path end-to-end in a real browser:
//   interstitial → opt-in → model downloads from CDN → app reveals →
//   type + play → audio chunks produced (no Tauri, no local server).

const ARTIFACTS = "e2e/artifacts";

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text()}`);
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

test("cold load → download model → synthesize speech", async ({ page }) => {
  const errors = collectErrors(page);

  await page.goto("/");

  // 1. First-run interstitial: explains the one-time download, gates the app.
  const downloadBtn = page.getByRole("button", { name: "Download & start" });
  await expect(downloadBtn).toBeVisible();
  await expect(page.getByText(/about\s+\d+\s*MB/i)).toBeVisible();
  await page.screenshot({ path: `${ARTIFACTS}/01-interstitial.png` });

  // 2. Opt in — this kicks off the model + espeak + ORT downloads in the worker.
  await downloadBtn.click();

  // 3. Wait for the app to be revealed (warm) OR a loud engine error. The model
  //    is ~86 MB, so allow several minutes.
  const textarea = page.locator("textarea");
  const engineError = page.getByText("Couldn't load the voice engine");
  const outcome = await Promise.race([
    textarea.waitFor({ state: "visible", timeout: 5 * 60 * 1000 }).then(() => "ready" as const),
    engineError.waitFor({ state: "visible", timeout: 5 * 60 * 1000 }).then(() => "error" as const),
  ]).catch(() => "timeout" as const);

  await page.screenshot({ path: `${ARTIFACTS}/02-after-download.png`, fullPage: true });
  expect(outcome, `engine did not become ready. errors:\n${errors.join("\n")}`).toBe("ready");

  // 4. Type a short phrase and play it.
  await textarea.fill("Hello from Out Loud, running entirely in your browser.");
  const playBtn = page.getByRole("button", { name: "Play", exact: true });
  await expect(playBtn).toBeVisible();
  await playBtn.click();

  // 5. Success: the Download-audio button enables only after a real audio chunk
  //    has been produced and decoded — proof the in-browser synthesis works.
  const downloadAudioBtn = page.getByRole("button", { name: /Download audio/i });
  await expect(downloadAudioBtn).toBeEnabled({ timeout: 90_000 });

  // And no error banner surfaced.
  const errorBanner = page.getByRole("alert");
  expect(await errorBanner.isVisible().catch(() => false)).toBe(false);
  await page.screenshot({ path: `${ARTIFACTS}/03-synthesizing.png`, fullPage: true });

  // Surface any console/page errors for the record (don't hard-fail on benign
  // ones, but the meaningful gates above must have passed).
  if (errors.length) console.log(`[note] page errors during run:\n${errors.join("\n")}`);
});

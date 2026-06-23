// Ad-hoc code-sign the built macOS .app so its signature is VALID.
//
// `tauri build` does NOT sign the bundle when there's no Apple Developer ID —
// contrary to a common assumption, it leaves the .app entirely UNSIGNED. That's
// fatal on macOS:
//   • arm64 code must carry at least an ad-hoc signature to execute at all; an
//     unsigned Apple-Silicon build is killed on launch.
//   • a quarantined unsigned download (any arch) trips Finder's
//     "…is damaged and can't be opened. You should move it to the Trash."
//     dialog — that message is the "no usable signature" Gatekeeper state.
//
// A valid ad-hoc signature fixes both: the arm64 binary launches, and a
// quarantined download shows the bypassable "unidentified developer → Open
// Anyway" prompt (or clears with `xattr -cr`) instead of "damaged".
//
// For a zero-friction download (no prompt at all) you still need Developer ID
// signing + notarization — CI does that when APPLE_SIGNING_IDENTITY is set, so
// when it is, we skip here and let the Developer ID step be authoritative.
//
// Crashes loudly: if signing or verification fails, the build fails (a silently
// broken signature is worse than a failed build).
import { execFileSync } from "node:child_process";
import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TAURI = join(__dirname, "..");
const APP = join(TAURI, "src-tauri", "target", "release", "bundle", "macos", "Out Loud.app");

function log(msg) {
  console.log(`[sign] ${msg}`);
}

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  if (process.platform !== "darwin") {
    log("not macOS — nothing to sign.");
    return;
  }
  if (process.env.APPLE_SIGNING_IDENTITY) {
    log("APPLE_SIGNING_IDENTITY is set — leaving signing to the Developer ID step.");
    return;
  }
  if (!(await exists(APP))) {
    throw new Error(`No .app at ${APP}. Run \`tauri build\` first.`);
  }

  log(`ad-hoc signing ${APP}`);
  // --deep re-signs the nested onnxruntime dylib too, sealing the whole bundle.
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", APP], { stdio: "inherit" });
  // Verify the seal is valid, or fail the build (no silently-broken .app ships).
  execFileSync("codesign", ["--verify", "--deep", "--strict", "--verbose=2", APP], {
    stdio: "inherit",
  });
  log("ad-hoc signature is valid.");
  log(
    "note: without Developer ID + notarization, a downloaded DMG still needs a one-time " +
      "right-click → Open (or `xattr -cr`). Set APPLE_SIGNING_IDENTITY in CI for a clean install."
  );
}

main().catch((err) => {
  console.error(`[sign] FAILED: ${err.message}`);
  process.exit(1);
});

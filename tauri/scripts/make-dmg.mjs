// Build the distributable DMG with LZMA (ULMO) compression — the smallest
// download that still opens on macOS 10.15+ (2019), comfortably within our
// "don't drop 3–4-year-old macOS" support floor.
//
// We own this step instead of Tauri's `dmg` bundle target: that target runs an
// AppleScript to lay out the installer window, which HANGS in a headless/CI
// session (no Apple Events). tauri.conf.json therefore builds only the `app`
// target and we package the DMG here. See scripts/stage-resources.mjs.
//
// Two paths:
//   1. If a DMG already exists at the canonical path (e.g. Tauri's styled `dmg`
//      target was run on an interactive login), recompress it to ULMO with
//      `hdiutil convert` — preserves the styled window AND shrinks it.
//   2. Otherwise, assemble a plain folder (.app + /Applications symlink) and
//      `hdiutil create -format ULMO`.
//
// Crashes loudly if the .app is missing or hdiutil fails — a missing installer
// is a build failure, not something to paper over.
import { execFileSync } from "node:child_process";
import { rm, mkdir, mkdtemp, readFile, stat, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TAURI = join(__dirname, "..");
const BUNDLE = join(TAURI, "src-tauri", "target", "release", "bundle");
const APP = join(BUNDLE, "macos", "Out Loud.app");
const DMG_DIR = join(BUNDLE, "dmg");

const FORMAT = "ULMO"; // LZMA — macOS 10.15+
const VOLNAME = "Out Loud";

function log(m) {
  console.log(`[dmg] ${m}`);
}

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

// Match Tauri's DMG naming so the artifact path is stable across both paths.
function archTag() {
  if (process.arch === "arm64") return "aarch64";
  if (process.arch === "x64") return "x64";
  return process.arch;
}

async function main() {
  if (process.platform !== "darwin") {
    throw new Error("make-dmg.mjs is macOS-only (uses hdiutil/ditto).");
  }
  if (!(await exists(APP))) {
    throw new Error(`No app bundle at ${APP}. Run \`tauri build\` first.`);
  }

  const { version } = JSON.parse(await readFile(join(TAURI, "package.json"), "utf8"));
  const out = join(DMG_DIR, `Out Loud_${version}_${archTag()}.dmg`);
  await mkdir(DMG_DIR, { recursive: true });
  // Always rebuild from the freshly-built .app — never recompress a stale DMG.
  await rm(out, { force: true });

  const stage = await mkdtemp(join(BUNDLE, "dmg-stage-"));
  try {
    log("assembling installer folder (.app + /Applications)…");
    // ditto copies the bundle faithfully (symlinks, perms, resource forks).
    execFileSync("ditto", [APP, join(stage, "Out Loud.app")], { stdio: "inherit" });
    await symlink("/Applications", join(stage, "Applications"));
    log(`creating ${FORMAT} DMG from ${APP}…`);
    execFileSync(
      "hdiutil",
      ["create", "-volname", VOLNAME, "-srcfolder", stage, "-ov", "-format", FORMAT, out],
      { stdio: "inherit" }
    );
  } finally {
    await rm(stage, { recursive: true, force: true });
  }

  const sz = execFileSync("du", ["-h", out], { encoding: "utf8" }).split("\t")[0];
  log(`done: ${out} (${sz})`);
}

main().catch((err) => {
  console.error(`[dmg] FAILED: ${err.message}`);
  process.exit(1);
});

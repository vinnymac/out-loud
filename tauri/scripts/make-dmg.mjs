// Build the distributable DMG with LZMA (ULMO) compression — the smallest
// download that still opens on macOS 10.15+ (2019).
//
// We own this step instead of Tauri's `dmg` bundle target: that target runs an
// AppleScript to lay out the installer window, which HANGS in a headless/CI
// session (no Apple Events). tauri.conf.json builds only the `app` target and we
// package the DMG here. We build per-arch NATIVE bundles (target/release/bundle) —
// not a universal binary; see .github/workflows/release.yml for why.
//
// Crashes loudly if the .app is missing or hdiutil fails.
import { execFileSync } from "node:child_process";
import { rm, mkdir, mkdtemp, readFile, stat, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TAURI = join(__dirname, "..");
const TARGET = join(TAURI, "src-tauri", "target");
const APP_NAME = "Out Loud.app";

const BUNDLE = join(TARGET, "release", "bundle");

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

// Tag by the running Node's arch: "x64" under the Rosetta x86_64 Node, "aarch64"
// on Apple Silicon. Matches the artifact globs in release.yml.
function archTag() {
  if (process.arch === "arm64") return "aarch64";
  if (process.arch === "x64") return "x64";
  return process.arch;
}

async function main() {
  if (process.platform !== "darwin") {
    throw new Error("make-dmg.mjs is macOS-only (uses hdiutil/ditto).");
  }

  const bundle = BUNDLE;
  if (!(await exists(join(bundle, "macos", APP_NAME)))) {
    throw new Error(`No ${APP_NAME} under ${bundle}. Run \`tauri build\` first.`);
  }

  const app = join(bundle, "macos", APP_NAME);
  const dmgDir = join(bundle, "dmg");
  const { version } = JSON.parse(await readFile(join(TAURI, "package.json"), "utf8"));
  const out = join(dmgDir, `Out Loud_${version}_${archTag()}.dmg`);
  await mkdir(dmgDir, { recursive: true });
  await rm(out, { force: true }); // always rebuild from the fresh .app

  const stage = await mkdtemp(join(bundle, "dmg-stage-"));
  try {
    log(`assembling installer folder from ${app}…`);
    // ditto copies the bundle faithfully (symlinks, perms, resource forks).
    execFileSync("ditto", [app, join(stage, APP_NAME)], { stdio: "inherit" });
    await symlink("/Applications", join(stage, "Applications"));
    log(`creating ${FORMAT} DMG…`);
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

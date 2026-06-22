// Assembles the resources the native Rust engine needs at runtime, bundled by
// `tauri build` into Contents/Resources/ and resolved by src-tauri/src/engine_host.rs.
//
// The engine is in-process Rust now (no Node, no ffmpeg). We ship:
//   resources/onnxruntime/libonnxruntime.1.20.1.dylib  ← ONNX Runtime (stripped)
//   resources/espeak/espeak-ng-data/                    ← espeak-ng voice/dict data
//   resources/models/                                   ← Kokoro ONNX model + voices
//   resources/openapi.yaml                              ← served at /api/v1/openapi.yaml
//
// Crash loudly on any missing piece — a half-staged bundle that "builds" but
// can't speak is worse than a failed build.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { rm, mkdir, cp, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TAURI = join(__dirname, ".."); // …/tauri
const REPO = join(TAURI, ".."); // …/out-loud
const SRC_TAURI = join(TAURI, "src-tauri");
const RES = join(SRC_TAURI, "resources");

const PLATFORM = process.platform; // darwin | win32 | linux
const ARCH = process.arch; // x64 | arm64

// The Intel-compatible ONNX Runtime — last release with a macOS x86_64 binary.
const MB = 1024 * 1024;

// The onnxruntime binary filename per OS (as shipped by onnxruntime-node 1.20.1).
function ortDylibName() {
  if (PLATFORM === "win32") return "onnxruntime.dll";
  if (PLATFORM === "darwin") return "libonnxruntime.1.20.1.dylib";
  return "libonnxruntime.so.1.20.1";
}

// Recursive copy with clean-replace semantics (cross-platform; no rsync).
async function copyTree(src, dest) {
  await rm(dest, { recursive: true, force: true });
  await mkdir(dirname(dest), { recursive: true });
  await cp(src, dest, { recursive: true });
}

function log(msg) {
  console.log(`[stage] ${msg}`);
}

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function dirSize(p) {
  try {
    return execFileSync("du", ["-sh", p], { encoding: "utf8" }).split("\t")[0];
  } catch {
    return "?";
  }
}

// Strip a Mach-O of local/debug symbols (keeps exported ORT C-API symbols), then
// re-ad-hoc-sign so macOS will still load it. Crashes loudly on tool failure.
async function stripMachO(p, label) {
  if (PLATFORM === "win32") return;
  const before = (await stat(p)).size;
  execFileSync("strip", ["-x", p], { stdio: "inherit" });
  if (PLATFORM === "darwin") {
    execFileSync("codesign", ["--force", "--sign", "-", p], { stdio: "inherit" });
  }
  const after = (await stat(p)).size;
  log(`stripped ${label}: ${(before / MB).toFixed(0)}MB -> ${(after / MB).toFixed(0)}MB`);
}

// ---- 1. ONNX Runtime dylib (sourced from the onnxruntime-node dev dependency) -

async function stageOnnxRuntime() {
  const napi = join(TAURI, "node_modules/onnxruntime-node/bin/napi-v3");
  const name = ortDylibName();
  const destDir = join(RES, "onnxruntime");
  await rm(destDir, { recursive: true, force: true });
  await mkdir(destDir, { recursive: true });

  // Per-arch native staging: pick the dylib matching this Node's arch. The macOS
  // x64 build runs under an x86_64 Node (Rosetta), so process.arch is "x64" there
  // and "arm64" on Apple Silicon — each ships its own native onnxruntime. (We do
  // NOT build a universal binary; see .github/workflows/release.yml for why.)
  const srcDir = join(napi, PLATFORM, ARCH);
  if (!(await exists(srcDir))) {
    throw new Error(
      `onnxruntime-node binaries not found at ${srcDir}. Run \`npm ci\` in tauri/ ` +
        `(onnxruntime-node@1.20.1 is a build-time source for the ${PLATFORM}/${ARCH} runtime).`
    );
  }
  const src = join(srcDir, name);
  if (!(await exists(src))) {
    const have = (await fs.promises.readdir(srcDir)).join(", ");
    throw new Error(`Expected ${name} in ${srcDir}; found: ${have}`);
  }

  if (PLATFORM === "win32") {
    // Copy onnxruntime.dll + any sibling provider DLLs. No strip on Windows.
    for (const f of await fs.promises.readdir(srcDir)) {
      if (f.endsWith(".dll")) await cp(join(srcDir, f), join(destDir, f));
    }
  } else {
    const dest = join(destDir, name);
    await cp(src, dest);
    await fs.promises.chmod(dest, 0o755);
    await stripMachO(dest, "onnxruntime");
  }
  log(`staged ONNX Runtime (${await dirSize(destDir)})`);
}

// ---- 2. espeak-ng-data ------------------------------------------------------

async function stageEspeakData() {
  // espeak-ng-data is vendored at the repo root (trimmed to the 8 supported
  // languages, ~4 MB). Platform-independent, so the build is reproducible and
  // cross-platform with no system install (brew/apt/download) required.
  const src = join(REPO, "espeak-ng-data");
  if (!(await exists(join(src, "phontab")))) {
    throw new Error(`Vendored espeak-ng-data not found at ${src} (expected a phontab file).`);
  }
  await copyTree(src, join(RES, "espeak", "espeak-ng-data"));
  log(`staged espeak-ng-data (${await dirSize(join(RES, "espeak"))})`);
}

// ---- 3. models + openapi ----------------------------------------------------

async function stageModels() {
  const src = join(REPO, "models");
  if (!(await exists(join(src, "model_q8f16.onnx")))) {
    throw new Error(`Models not found at ${src}.`);
  }
  await copyTree(src, join(RES, "models"));
  log(`staged models (${await dirSize(join(RES, "models"))})`);
}

async function stageOpenApi() {
  const src = join(REPO, "docs", "app", "openapi.yaml");
  if (await exists(src)) {
    await cp(src, join(RES, "openapi.yaml"));
    log("staged openapi.yaml");
  } else {
    log(`note: ${src} not found — /api/v1/openapi.yaml will 404`);
  }
}

// ---- main -------------------------------------------------------------------

async function main() {
  log(`host: ${PLATFORM}/${ARCH}`);
  await mkdir(RES, { recursive: true });
  await stageOnnxRuntime();
  await stageEspeakData();
  await stageModels();
  await stageOpenApi();
  log(`done. total resources: ${await dirSize(RES)}`);
}

main().catch((err) => {
  console.error(`[stage] FAILED: ${err.message}`);
  process.exit(1);
});

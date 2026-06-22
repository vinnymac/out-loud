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
const ORT_DYLIB = "libonnxruntime.1.20.1.dylib";
const MB = 1024 * 1024;

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
  if (PLATFORM !== "darwin") {
    throw new Error("stage-resources currently targets macOS only");
  }
  const dest = join(RES, "onnxruntime", ORT_DYLIB);
  const src = join(
    TAURI,
    "node_modules/onnxruntime-node/bin/napi-v3",
    PLATFORM,
    ARCH,
    ORT_DYLIB
  );
  if (!(await exists(src))) {
    throw new Error(
      `ONNX Runtime dylib not found at ${src}. Run \`npm install\` in tauri/ ` +
        `(onnxruntime-node@1.20.1 is a build-time source for the Intel dylib).`
    );
  }
  await mkdir(dirname(dest), { recursive: true });
  await cp(src, dest);
  await fs.promises.chmod(dest, 0o755);
  await stripMachO(dest, "onnxruntime");
  log(`staged ONNX Runtime (${await dirSize(join(RES, "onnxruntime"))})`);
}

// ---- 2. espeak-ng-data ------------------------------------------------------

async function stageEspeakData() {
  // Complete compiled espeak-ng 1.52 data. Source order: env override, then the
  // common Homebrew locations. (TODO: trim to the 8 supported languages; vendor
  // a portable copy for CI instead of relying on a local install.)
  const candidates = [
    process.env.OUT_LOUD_ESPEAK_DATA,
    "/usr/local/Cellar/espeak-ng/1.52.0/share/espeak-ng-data",
    "/opt/homebrew/share/espeak-ng-data",
    "/usr/share/espeak-ng-data",
  ].filter(Boolean);

  let src = null;
  for (const c of candidates) {
    if (await exists(join(c, "phontab"))) {
      src = c;
      break;
    }
  }
  if (!src) {
    throw new Error(
      `Complete espeak-ng-data not found (looked for phontab in: ${candidates.join(", ")}). ` +
        `Install espeak-ng (\`brew install espeak-ng\`) or set OUT_LOUD_ESPEAK_DATA.`
    );
  }
  const dest = join(RES, "espeak", "espeak-ng-data");
  await rm(join(RES, "espeak"), { recursive: true, force: true });
  await mkdir(dirname(dest), { recursive: true });
  // rsync preserves the tree; --delete keeps it clean across rebuilds.
  execFileSync("rsync", ["-a", "--delete", src + "/", dest + "/"], { stdio: "inherit" });

  // Trim to the supported languages. ~22 MB of the 25 MB is per-language `*_dict`
  // files for ~110 languages we don't use (ru_dict alone is 8 MB). espeak loads a
  // dict only when its language is selected, so dropping unused ones is safe. We
  // keep the shared phoneme tables (phon*, intonations), lang/, voices/, and the
  // dicts for our 8 languages (en covers en-us + en-gb).
  const keepDicts = new Set([
    "en_dict", "es_dict", "it_dict", "pt_dict", "hi_dict", "ja_dict", "cmn_dict",
  ]);
  let removedDicts = 0;
  let removedBytes = 0;
  for (const entry of await fs.promises.readdir(dest)) {
    if (entry.endsWith("_dict") && !keepDicts.has(entry)) {
      const p = join(dest, entry);
      removedBytes += (await stat(p)).size;
      await rm(p, { force: true });
      removedDicts++;
    }
  }
  // MBROLA phoneme data + sound icons are unused (we emit IPA, not synthesis).
  await rm(join(dest, "mbrola_ph"), { recursive: true, force: true });
  await rm(join(dest, "soundicons"), { recursive: true, force: true });
  log(
    `trimmed espeak: dropped ${removedDicts} unused dicts (~${(removedBytes / MB).toFixed(0)}MB)`
  );
  log(`staged espeak-ng-data from ${src} (${await dirSize(join(RES, "espeak"))})`);
}

// ---- 3. models + openapi ----------------------------------------------------

async function stageModels() {
  const src = join(REPO, "electron", "models");
  if (!(await exists(join(src, "model_q8f16.onnx")))) {
    throw new Error(`Models not found at ${src}.`);
  }
  execFileSync("rsync", ["-a", "--delete", src + "/", join(RES, "models") + "/"], {
    stdio: "inherit",
  });
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

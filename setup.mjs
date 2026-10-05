// One-time setup (Node 18+). After this, the app runs fully offline: no Python, no backend, no CDN.
import { mkdir, writeFile, access, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "web");
const HF = "https://huggingface.co/heman10x/rlcd-modernbert-151m/resolve/main/";
const ORT = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/";
const TJS = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.3.3/dist/transformers.js";

// SHA-256 values from the upstream artifacts/ARTIFACTS.json manifest
const SHA = {
  "model_fp16.onnx": "4db28305590c714e33c2cacb75a57ec941c72bb210e1266ba2c7d77e85ddc526",
  "model.onnx": "4ae01f822538b000fa0e55859d4b3e6b40871d860149397e8784428b2a42ee5e",
  "calibrator_hf.json": "9686e84bb6fb90a8ceabb6994fb9c18ac6a64272d5c413c5f12bed1ee4ccb1b3",
  "tokenizer.json": "8bb449eb0c037aae44115b65905bb339b8f3f74eb37067c19127feb3c0755723",
  "tokenizer_config.json": "fb54f027372062b2ca52282efb04d178a8b57167a00cd8f4e816515823a2c016",
};
const sha = b => createHash("sha256").update(b).digest("hex");
const exists = p => access(p).then(() => true, () => false);
async function get(url, dest, optional = false) {
  if (await exists(dest)) { console.log("have", dest); return true; }
  const r = await fetch(url);
  if (!r.ok) { if (optional) return false; throw new Error(`${url} -> HTTP ${r.status}`); }
  const buf = Buffer.from(await r.arrayBuffer());
  const want = SHA[dest.split(/[\\/]/).pop()];
  if (want && sha(buf) !== want) throw new Error(`Checksum mismatch for ${dest}`);
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, buf);
  console.log("saved", dest);
  return true;
}

// Libraries
for (const f of ["ort.all.bundle.min.mjs", "ort-wasm-simd-threaded.wasm", "ort-wasm-simd-threaded.mjs",
                 "ort-wasm-simd-threaded.jsep.wasm", "ort-wasm-simd-threaded.jsep.mjs"])
  await get(ORT + f, join(root, "vendor/ort", f), true);
await get(TJS, join(root, "vendor/transformers/transformers.js"));

// Model: prefer fp16 (smaller, parity-tested upstream), else fp32 model.onnx
if (!(await get(HF + "model_fp16.onnx", join(root, "model/model_fp16.onnx"), true)))
  await get(HF + "model.onnx", join(root, "model/model.onnx"));
// Tokenizer + calibrator.json ship with this project (already checksummed); only fetch if you deleted them.
for (const f of ["tokenizer.json", "tokenizer_config.json"]) await get(HF + f, join(root, "model", f));
await get("https://raw.githubusercontent.com/Heman10x-NGU/Verdict-open-jev/main/artifacts/calibrator.json",
          join(root, "model/calibrator.json"), true);
// The Hugging Face copy of calibrator.json (299 bytes) differs from the per-K one in GitHub main.
// Saved separately for comparison; the app uses model/calibrator.json (per-K) unless you replace it.
await get(HF + "calibrator.json", join(root, "model/calibrator_hf.json"), true);
console.log("\nDone. Run: node serve.mjs   then open http://localhost:8080");

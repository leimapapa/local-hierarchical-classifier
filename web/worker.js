// Local Verdict (rlcd-modernbert-151m) inference worker.
// Prefers vendored libraries in ./vendor/ (fully offline); falls back to CDN only if they are missing.
let ort, AutoTokenizer, env;
let session = null, tokenizer = null, contract = null, calibrator = {temperature: 1.0, per_k: {}}, backend = "WASM";
const MAX_TOKENS = 512; // Verdict v1.4 engine budget (labels + question + context). We error instead of silently truncating.

async function tryImport(local, cdn) {
  try { return await import(local); }
  catch (e) { console.warn(`Local ${local} missing, using CDN`, e); return await import(cdn); }
}

async function deps() {
  if (ort) return;
  ort = await tryImport("./vendor/ort/ort.all.bundle.min.mjs",
    "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/ort.all.bundle.min.mjs");
  ort.env.wasm.numThreads = 1;
  const localWasm = await fetch("./vendor/ort/ort-wasm-simd-threaded.wasm", {method: "HEAD"}).then(r => r.ok).catch(() => false);
  ort.env.wasm.wasmPaths = localWasm ? new URL("./vendor/ort/", self.location.href).href
                                     : "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/";
  const mod = await tryImport("./vendor/transformers/transformers.js",
    "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.3.3/dist/transformers.js");
  AutoTokenizer = mod.AutoTokenizer; env = mod.env;
  env.allowLocalModels = true;
  env.allowRemoteModels = false;
  env.localModelPath = new URL("./", self.location.href).href;
}

async function fetchFirst(urls) {
  for (const u of urls) {
    const r = await fetch(u);
    if (r.ok) { postMessage({type: "STATUS", message: `Loading ${u} ...`}); return {url: u, buf: await r.arrayBuffer()}; }
  }
  throw new Error(`None of these exist: ${urls.join(", ")}. See README step 1.`);
}

async function init() {
  await deps();
  contract = await (await fetch("./prompt_contract.json", {cache: "no-store"})).json();

  // Temperature comes from the downloaded calibrator, not a hardcoded constant.
  const cal = await fetch("./model/calibrator.json", {cache: "no-store"});
  if (!cal.ok) throw new Error("web/model/calibrator.json is missing. Run: node setup.mjs");
  calibrator = await cal.json();

  for (const f of ["tokenizer.json", "tokenizer_config.json"]) {
    const r = await fetch(`./model/${f}`, {method: "HEAD"});
    if (!r.ok) throw new Error(`${new URL(`./model/${f}`, self.location.href).href} -> HTTP ${r.status}. ` +
      `Serve the project's web/ folder as the site root, or run: node setup.mjs`);
  }
  tokenizer = await AutoTokenizer.from_pretrained("model", {local_files_only: true});

  const {url, buf} = await fetchFirst(["./model/model_fp16.onnx", "./model/model.onnx"]);
  try {
    if (navigator.gpu) {
      session = await ort.InferenceSession.create(buf, {executionProviders: ["webgpu"], graphOptimizationLevel: "all"});
      backend = "WebGPU";
    }
  } catch (e) { console.warn("WebGPU failed, using WASM", e); session = null; }
  if (!session) {
    session = await ort.InferenceSession.create(buf, {executionProviders: ["wasm"], graphOptimizationLevel: "all"});
    backend = "WASM";
  }
  postMessage({type: "READY", backend, modelFile: url});
}

// The published calibrator is per option count (K). Use exact K if fitted, else the nearest fitted K.
function temperatureFor(k) {
  const table = calibrator.per_k || {};
  const keys = Object.keys(table).map(Number).filter(n => table[n] > 0);
  if (keys.length) {
    const best = keys.reduce((a, b) => Math.abs(b - k) < Math.abs(a - k) ? b : a);
    return {T: Number(table[best]), source: best === k ? `per_k[${k}]` : `per_k[${best}] (nearest to K=${k})`};
  }
  return {T: Number(calibrator.temperature) || 1.0, source: "scalar"};
}

function softmax(values, T) {
  const s = values.map(v => v / T), m = Math.max(...s);
  const e = s.map(v => Math.exp(v - m)), t = e.reduce((a, b) => a + b, 0);
  return e.map(v => v / t);
}

function buildPrompt(question, text, candidates) {
  const q = question || contract.default_question;
  const body = contract.input_template.replace("{question}", () => q).replace("{context}", () => text);
  const labels = candidates.map(c => `${contract.label_marker}${c.label}`).join("");
  return `${labels}${contract.sep_marker}${body}`;
}

async function countTokens(prompt) {
  const tok = await tokenizer(prompt, {truncation: false});
  return {tok, n: tok.input_ids.dims?.[1] ?? tok.input_ids.length};
}

async function infer({text, question, candidates}) {
  if (!session) throw new Error("Engine is not initialized.");
  if (candidates.length > contract.max_candidates)
    throw new Error(`Too many candidates (${candidates.length}); max ${contract.max_candidates}.`);

  // No truncation: a truncated prompt silently drops <<SEP>> and the context, giving garbage output.
  const {tok, n} = await countTokens(buildPrompt(question, text, candidates));
  if (n > MAX_TOKENS)
    throw new Error(`Prompt is ${n} tokens (limit ${MAX_TOKENS}). Shorten the node descriptions or the input text.`);

  const t0 = performance.now();
  const out = await session.run({input_ids: tok.input_ids, attention_mask: tok.attention_mask});
  const elapsed = performance.now() - t0;

  const raw = out.logits?.data;
  if (!raw) throw new Error(`No 'logits' output. Outputs: ${Object.keys(out).join(", ")}`);
  const logits = Array.from(raw).slice(0, candidates.length);
  const {T: temperature, source: temperatureSource} = temperatureFor(candidates.length);
  const probs = softmax(logits, temperature);
  return {
    backend, elapsedMs: elapsed, tokenCount: n, temperature, temperatureSource,
    probabilities: candidates.map((c, i) => ({id: c.id, name: c.name, probability: probs[i], logit: logits[i]}))
  };
}

// Token cost of every menu with an EMPTY input text, so the UI can warn before anyone runs a query.
async function measure({items}) {
  const out = [];
  for (const it of items) out.push({key: it.key, name: it.name, tokens: (await countTokens(buildPrompt(it.question, "", it.candidates))).n});
  return {budget: MAX_TOKENS, items: out};
}

self.onmessage = async ev => {
  const {type, reqId} = ev.data;
  try {
    if (type === "INIT") await init();
    else if (type === "INFER") postMessage({type: "RESULT", reqId, result: await infer(ev.data.payload)});
    else if (type === "MEASURE") postMessage({type: "MEASURED", reqId, result: await measure(ev.data.payload)});
  } catch (err) { postMessage({type: "ERROR", reqId, message: err?.message || String(err)}); }
};

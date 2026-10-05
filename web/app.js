import {classify, validateTaxonomy, allMenus, ABSTENTION_ID} from "./taxonomy.js";

const state = {tax: null, worker: null, ready: false, threshold: 0.85, beam: 2, pending: new Map(), seq: 0};
const $ = s => document.querySelector(s);
const esc = v => String(v).replace(/[&<>"]/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"}[c]));
const pct = p => `${(100 * p).toFixed(1)}%`;
const setStatus = m => { $("#status").textContent = m; };

// ---- worker RPC: one awaited call per hierarchy level ----
function rpc(type, payload) {
  return new Promise((resolve, reject) => {
    const reqId = ++state.seq;
    state.pending.set(reqId, {resolve, reject});
    state.worker.postMessage({type, reqId, payload});
  });
}

function initWorker() {
  state.worker = new Worker("worker.js", {type: "module"});
  state.worker.onmessage = ({data}) => {
    if (data.type === "STATUS") return setStatus(data.message);
    if (data.type === "READY") {
      state.ready = true;
      $("#backend").textContent = data.backend;
      setStatus("Model ready. Nothing is sent to a server by this app.");
      $("#run").disabled = false;
      return checkBudgets();
    }
    const p = state.pending.get(data.reqId);
    if (data.type === "ERROR" && !p) { setStatus(`Error: ${data.message}`); return; }
    if (!p) return;
    state.pending.delete(data.reqId);
    data.type === "ERROR" ? p.reject(new Error(data.message)) : p.resolve(data.result);
  };
  state.worker.postMessage({type: "INIT"});
}

// ---- taxonomy loading / rendering ----
function setTaxonomy(tax, label) {
  const problems = validateTaxonomy(tax);
  if (problems.length) {
    $("#warnings").innerHTML = problems.slice(0, 6).map(esc).join("<br>");
    setStatus(`Invalid taxonomy: ${problems[0]}`);
    return;
  }
  state.tax = tax;
  $("#taxName").textContent = tax.name ?? label ?? "Custom taxonomy";
  $("#warnings").textContent = "";
  $("#result").innerHTML = "Classify some text to see the path through the hierarchy.";
  renderTree(); renderExamples();
  if (state.ready) checkBudgets();
}

function countLeaves(n) { return n.children?.length ? n.children.reduce((a, c) => a + countLeaves(c), 0) : 1; }
function maxDepth(n) { return n.children?.length ? 1 + Math.max(...n.children.map(maxDepth)) : 0; }

function renderTree() {
  const node = n => n.children?.length
    ? `<details open><summary>${esc(n.name)} <span class="d">· ${n.children.length}</span></summary>${n.children.map(node).join("")}</details>`
    : `<div class="leaf">${esc(n.name)}${n.description ? ` <span class="d">— ${esc(n.description)}</span>` : ""}</div>`;
  $("#tree").innerHTML = state.tax.root.children.map(node).join("");
  $("#candidateCount").textContent = `${countLeaves(state.tax.root)} outcomes · ${maxDepth(state.tax.root)} levels · ${allMenus(state.tax).length} menus`;
}

function renderExamples() {
  const box = $("#examples"); box.innerHTML = "";
  const ex = state.tax.examples ?? [];
  ex.forEach(e => {
    const b = document.createElement("button");
    b.type = "button"; b.textContent = e.title;
    b.onclick = () => { $("#context").value = e.text; };
    box.append(b);
  });
  if (ex[0]) $("#context").value = ex[0].text;
}

async function checkBudgets() {
  try {
    const items = allMenus(state.tax).map(m => ({key: m.key, name: m.name, question: m.question, candidates: m.candidates}));
    const {budget, items: res} = await rpc("MEASURE", {items});
    const RESERVE = 120;   // tokens left for the text to classify
    const over = res.filter(r => r.tokens + RESERVE > budget);
    $("#warnings").innerHTML = over.length
      ? `Token budget warning (limit ${budget}, ~${RESERVE} reserved for your text):<br>` +
        over.map(r => `• "${esc(r.name)}" menu uses ${r.tokens} tokens: shorten its children's descriptions or add a level.`).join("<br>")
      : "";
  } catch (e) { $("#warnings").textContent = `Budget check failed: ${e.message}`; }
}

// ---- result rendering ----
function renderResult(r) {
  const b = r.best;
  const routeClass = {ACCEPT: "accept", REVIEW: "review", ABSTAIN: "abstain"}[r.route];
  const names = b.path.map((n, i) => `<span>${esc(n.name)}${!b.abstained && i === b.path.length - 1 ? ` <small>${pct(b.confidence)}</small>` : ""}</span>`);
  if (b.abstained) names.push(`<span class="muted">⊘ insufficient evidence <small>${pct(b.confidence)}</small></span>`);
  const title = b.abstained ? (b.path.length ? "Partial: could not narrow further" : "No confident match") : "Best match";
  const renderStep = (s, i, final = false) => {
    const chosen = b.abstained && i === b.steps.length - 1 ? ABSTENTION_ID : b.path[i]?.id;
    const rows = [...s.probabilities].sort((x, y) => y.probability - x.probability);
    const label = i === 0
      ? (final ? "Top-level choices" : "Top-level routing (category score does not affect acceptance)")
      : `Choices within ${s.nodeName}`;
    return `<div class="step"><div class="eyebrow">${esc(label)}</div>
      <div class="muted small">${esc(s.question)} · ${s.tokenCount ?? "?"} tokens · T=${s.temperature?.toFixed?.(2) ?? "?"}</div>
      <div class="bars">${rows.map(x => `<div class="row ${x.id === chosen ? "chosen" : ""}">
        <div class="row-top"><span>${esc(x.name)}</span><span>${pct(x.probability)}</span></div>
        <div class="bar"><div style="width:${100 * x.probability}%"></div></div></div>`).join("")}</div></div>`;
  };
  const finalStep = b.steps.at(-1);
  const earlierSteps = b.steps.slice(0, -1).map((s, i) => renderStep(s, i)).join("");
  const alts = r.alternatives.filter(a => a.confidence >= 0.02).map(a => `<div class="alt">${esc(a.abstained ? `${a.path.map(n => n.name).join(" › ") || "(root)"} › ⊘ abstain` : a.path.map(n => n.name).join(" › "))} · final choice ${pct(a.confidence)}</div>`).join("");
  const categoryComparisons = r.categoryAttempts.length > 1
    ? `<div style="margin-top:10px"><div class="eyebrow">Category comparison</div>${r.categoryAttempts.map(a =>
      `<div class="alt">${esc(a.categoryName)} · final choice ${pct(a.confidence)}${a.selected ? " · selected" : ""}</div>`
    ).join("")}</div>`
    : "";
  const status = b.abstained
    ? `ABSTAIN · insufficient evidence at this level (${pct(b.confidence)})`
    : `${r.route} · final choice ${pct(b.confidence)} · τ ${(r.threshold * 100).toFixed(0)}%`;
  $("#result").innerHTML = `
    <div class="eyebrow">${title}</div>
    <div class="path">${names.join('<span class="arrow">›</span>') || "—"}</div>
    <div class="route ${routeClass}">${status}</div>
    <div class="meta">${esc($("#backend").textContent)} · ${r.ms.toFixed(0)} ms total · ${r.calls} model call${r.calls === 1 ? "" : "s"} · beam ${r.beam}</div>
    ${categoryComparisons}
    ${alts ? `<div style="margin-top:10px"><div class="eyebrow">Runner-up paths</div>${alts}</div>` : ""}
    ${renderStep(finalStep, b.steps.length - 1, true)}
    ${earlierSteps ? `<details style="margin-top:10px"><summary>Earlier routing scores</summary>${earlierSteps}</details>` : ""}`;
}

// ---- run ----
$("#run").addEventListener("click", async () => {
  if (!state.ready || !state.tax) return;
  const text = $("#context").value.trim();
  if (!text) return setStatus("Enter some text to classify.");
  $("#run").disabled = true; $("#result").innerHTML = ""; setStatus("Running local model…");
  let calls = 0;
  const t0 = performance.now();
  try {
    const r = await classify(state.tax, text,
      async ({candidates, question, text}) => { calls++; return rpc("INFER", {candidates, question, text}); },
      {beam: state.beam, threshold: state.threshold});
    renderResult({...r, ms: performance.now() - t0, calls});
    setStatus("Done.");
  } catch (e) { setStatus(`Error: ${e.message}`); }
  $("#run").disabled = false;
});

$("#threshold").addEventListener("input", e => { state.threshold = +e.target.value; $("#thresholdValue").textContent = state.threshold.toFixed(2); });
$("#beam").addEventListener("input", e => { state.beam = +e.target.value; $("#beamValue").textContent = state.beam; });

$("#taxFile").addEventListener("change", async e => {
  const f = e.target.files[0]; if (!f) return;
  try { setTaxonomy(JSON.parse(await f.text()), f.name); } catch (err) { setStatus(`Could not read ${f.name}: ${err.message}`); }
});
$("#taxSelect").addEventListener("change", async e => setTaxonomy(await (await fetch(e.target.value, {cache: "no-store"})).json()));

(async function boot() {
  try {
    const idx = await (await fetch("./taxonomies/index.json", {cache: "no-store"})).json();
    $("#taxSelect").innerHTML = idx.files.map(f => `<option value="${esc(f.file)}">${esc(f.title)}</option>`).join("");
    const wanted = new URLSearchParams(location.search).get("tax");        // ?tax=taxonomies/mine.json
    if (wanted && !idx.files.some(f => f.file === wanted)) $("#taxSelect").insertAdjacentHTML("afterbegin", `<option value="${esc(wanted)}">${esc(wanted)}</option>`);
    $("#taxSelect").value = wanted ?? idx.files[0].file;
    setTaxonomy(await (await fetch($("#taxSelect").value, {cache: "no-store"})).json());
    initWorker();
  } catch (e) { setStatus(`Taxonomy error: ${e.message}`); }
})();

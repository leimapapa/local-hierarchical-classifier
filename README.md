# Local Hierarchical Classifier (Verdict-ModernBERT-151M, browser-only)

Classifies free text into the **leaf of a hierarchy you define** (e.g. `Mammals > Cat`), entirely in the browser.
No Python, no backend, no network after setup. The model is used **frozen**: nothing is trained.

## Run it

Needs Node 18+ once, for setup. Day-to-day use needs only a browser (Chrome/Edge for WebGPU; WASM fallback otherwise).

```bash
node setup.mjs      # vendors onnxruntime-web + transformers.js, downloads model_fp16.onnx (~300 MB), verifies SHA-256
node serve.mjs      # http://localhost:8080   (or VS Code Live Server on web/index.html, or `npx http-server web`)
npm test            # routing/validation/CSV tests (no model needed)
```
Browsers block workers/WASM/fetch on `file://`, so some static server is required. `web/` must be the site root.

## How it works

The model first routes to the highest-scoring top-level category, ignoring `insufficient evidence` at that routing step.
It then sees small menus of that category's children plus `insufficient evidence`, descending until a leaf or abstention.
Small menus (3-9 options) are where the checkpoint is most accurate and best calibrated, versus one flat menu of every leaf.

- **Top-level routing**: the highest-scoring real category is tried first, even if its score is low or `insufficient evidence` scores higher. If its best final choice is below the accept threshold, the runner-up category is also tried; the category with the higher final-choice score is selected. Top-level category scores do not affect acceptance.
- **Beam width** (UI slider): explore the top-N candidate branches within the selected category, ranked by their conditional probabilities. It does not reconsider the top-level category.
- **Abstention** below the top level stops there and returns the partial path (e.g. "it's a Mammal, can't tell which").
- **Accept policy**: ACCEPT when the final choice within the selected category reaches the threshold; otherwise REVIEW. The displayed confidence is for that final sibling choice, not a product with the top-level score.
- **Temperature** comes from `web/model/calibrator.json`, per menu size K (nearest fitted K if exact is missing).

## Use your own hierarchy

Load any JSON file in the UI ("Load your own taxonomy JSON..."), or put it in `web/taxonomies/`, list it in `web/taxonomies/index.json`, or open `?tax=taxonomies/mine.json`.

```json
{
  "name": "My taxonomy",
  "question": "Which group best matches this description?",
  "root": { "children": [
    { "id": "mammal", "name": "Mammals", "description": "warm-blooded, fur, nurse their young",
      "children": [ { "id": "cat", "name": "Cat", "description": "retractable claws, whiskers, purrs" } ] }
  ]},
  "examples": [ { "title": "Cat", "text": "A furry pet that purrs...", "expect": "Cat" } ]
}
```
`id` (unique string) and `name` are required on every node; `description`, `question` (per-node override), `examples` are optional.
Any depth is allowed, up to **24 children per node** (one slot is reserved for abstention); add a level if you exceed it.

**From a spreadsheet:** save a CSV with columns `path,description` (`Mammals/Cat,"retractable claws, whiskers"`; rows for internal nodes optional; missing ancestors are auto-created):
```bash
node tools/csv-to-taxonomy.mjs data.csv --name "My taxonomy" --question "Which ...?" > web/taxonomies/mine.json
```

### Writing descriptions that work (the biggest lever)
- **Short and distinguishing**: ~5-15 words of discriminating cues, not definitions. Each prompt must fit 512 tokens *including* your input text; the UI measures every menu on load and warns.
- **Internal nodes must describe what's underneath.** A group label is all the model sees at the upper levels. If `description` is omitted, the label falls back to `Name (leaf, leaf, ...)`, which is a decent default.
- **Make siblings contrastive.** Near-duplicates (Lizard vs Gecko) at the same level is where errors concentrate; group them under a parent so the confusable choice is a small menu of its own.
- Don't reword `insufficient evidence`; it's the trained abstention string.

## Honest limits

- Frozen model, zero-shot on *your* labels: accuracy depends on your domain and wording. Upstream reports 72% top-1 at K=25 flat and ~91% at K=9 on their benchmarks, and weaker on some external sets. Measure on your own labeled examples before trusting it.
- The calibrator was fitted on the authors' data. Treat probabilities as relative confidence and tune the threshold on your own labeled set.
- Hierarchies add a failure mode flat classification lacks: a wrong top-level routing choice cannot be undone by beam search. Check top-level routing accuracy separately on your labeled examples.
- If accuracy is not enough, the next step is fine-tuning (Python, one-off) and dropping the new `model.onnx` + `calibrator.json` into `web/model/`; the app and taxonomy files don't change.

## Files
```
setup.mjs / serve.mjs     one-time setup, static server (Node)
tools/csv-to-taxonomy.mjs CSV -> taxonomy JSON
tests/taxonomy.test.mjs   routing, beam, abstention, validation, CSV
web/taxonomy.js           pure routing logic (browser + Node)
web/worker.js             tokenizer + ONNX inference, per-K temperature, token budgets
web/app.js, index.html    UI
web/taxonomies/           animals (example), instruments (synthetic, 2-level)
web/model/                tokenizer + calibrator (bundled); model downloaded by setup.mjs
```

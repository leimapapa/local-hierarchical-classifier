import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { classify, validateTaxonomy, menuFor, labelFor, allMenus, ABSTENTION_ID } from "../web/taxonomy.js";
import { csvToTaxonomy } from "../tools/csv-to-taxonomy.mjs";

const load = f => JSON.parse(readFileSync(new URL(`../web/taxonomies/${f}.json`, import.meta.url)));
const animals = load("animals");

// Mock scorer: word-stem overlap between the description and each option's whole subtree (name + descriptions),
// softmaxed. It stands in for a semantic model so we test the ROUTING logic, not model accuracy.
const stem = w => w.replace(/(ies|ing|ed|es|s|y)$/, "");
const words = s => new Set((s.toLowerCase().match(/[a-z]+/g) ?? []).filter(w => w.length > 2).map(stem));
const subtreeWords = n => { const out = words(`${n.name} ${n.description ?? ""}`); for (const c of n.children ?? []) for (const w of subtreeWords(c)) out.add(w); return out; };
const mock = (tax, calls = []) => {
  const byId = new Map(); (function walk(n) { for (const c of n.children ?? []) { byId.set(c.id, c); walk(c); } })(tax.root);
  return async ({candidates, question, text}) => {
    calls.push({n: candidates.length, question, labels: candidates.map(c => c.label)});
    const tw = words(text);
    const raw = candidates.map(c => c.id === ABSTENTION_ID ? 0.3 : [...subtreeWords(byId.get(c.id))].filter(w => tw.has(w)).length);
    const e = raw.map(v => Math.exp(2 * v)), z = e.reduce((a, b) => a + b);
    return {probabilities: candidates.map((c, i) => ({id: c.id, probability: e[i] / z})), tokenCount: 100, temperature: 1};
  };
};
const scripted = table => async ({candidates}) => {
  const e = candidates.map(c => Math.exp(table[c.id] ?? 0)), z = e.reduce((a, b) => a + b);
  return {probabilities: candidates.map((c, i) => ({id: c.id, probability: e[i] / z}))};
};

test("samples validate", () => { for (const f of ["animals", "instruments"]) assert.deepEqual(validateTaxonomy(load(f)), []); });

test("routes top-down to the leaf using small menus", async () => {
  const calls = [];
  const r = await classify(animals, animals.examples[0].text, mock(animals, calls));
  assert.equal(r.best.path.map(n => n.name).join(">"), "Mammals>Cat");
  assert.equal(calls.length, 2);                      // greedy: one menu per level
  assert.deepEqual(calls.map(c => c.n), [4, 5]);      // 3 groups+abstain, 4 animals+abstain
  assert.equal(r.route, "ACCEPT");
});

test("all sample examples hit their expected leaf", async () => {
  for (const f of ["animals", "instruments"]) {
    const t = load(f);
    for (const ex of t.examples) {
      const r = await classify(t, ex.text, mock(t), {beam: 2});
      assert.equal(r.best.path.at(-1)?.name, ex.expect, `${f}/${ex.title}`);
    }
  }
});

test("top-level routing ignores abstention and threshold; confidence comes from the selected category", async () => {
  const r = await classify(animals, "x", async ({candidates}) => {
    const scores = candidates.some(c => c.id === "mammal")
      ? {[ABSTENTION_ID]: 8, mammal: 1, reptile: 0, bug: -1}
      : {cat: 2};
    return scripted(scores)({candidates});
  }, {threshold: 0.6});
  assert.equal(r.best.path[0].id, "mammal");
  assert.ok(r.best.steps[0].probabilities.find(p => p.id === "mammal").probability < 0.01);
  assert.ok(r.best.confidence > 0.6);
  assert.equal(r.best.p, r.best.confidence);
  assert.equal(r.route, "ACCEPT");
});

test("abstention still stops classification within the selected category", async () => {
  const r = await classify(animals, "zzz qqq", async ({candidates}) => ({
    probabilities: candidates.map(c => ({id: c.id, probability: c.id === ABSTENTION_ID ? 0.9 : 0.1 / (candidates.length - 1)}))}));
  assert.equal(r.route, "ABSTAIN");
  assert.equal(r.best.path[0].id, "mammal");
});

test("threshold applies only to the final choice within the routed category", async () => {
  const confidentThenWeak = scripted({mammal: 5, cat: 1});
  const r = await classify(animals, "x", confidentThenWeak, {threshold: 0.85});
  assert.equal(r.best.path.at(-1).id, "cat");
  assert.ok(r.best.steps[0].probabilities.find(p => p.id === "mammal").probability > 0.95);
  assert.equal(r.route, "REVIEW");
  assert.ok(r.best.confidence < 0.85);
  const strong = await classify(animals, "x", scripted({mammal: 5, cat: 6}), {threshold: 0.85});
  assert.equal(strong.route, "ACCEPT");
});

test("tries the second category when the first category's final choice is below threshold", async () => {
  const calls = [];
  const r = await classify(animals, "x", async ({candidates}) => {
    const ids = candidates.map(c => c.id);
    calls.push(ids);
    if (ids.includes("mammal")) return {probabilities: [
      {id: "mammal", probability: 0.6}, {id: "reptile", probability: 0.3},
      {id: "bug", probability: 0.08}, {id: ABSTENTION_ID, probability: 0.02}
    ]};
    if (ids.includes("cat")) return {probabilities: [
      {id: "cat", probability: 0.5}, {id: "dog", probability: 0.2},
      {id: "mouse", probability: 0.15}, {id: "giraffe", probability: 0.1},
      {id: ABSTENTION_ID, probability: 0.05}
    ]};
    if (ids.includes("snake")) return {probabilities: [
      {id: "snake", probability: 0.1}, {id: "lizard", probability: 0.1},
      {id: "turtle", probability: 0.75}, {id: ABSTENTION_ID, probability: 0.05}
    ]};
    throw new Error(`Unexpected candidate menu: ${ids.join(",")}`);
  }, {threshold: 0.8});

  assert.equal(calls.length, 3);
  assert.equal(r.best.path.map(n => n.id).join(">"), "reptile>turtle");
  assert.equal(r.best.confidence, 0.75);
  assert.equal(r.route, "REVIEW");
  assert.deepEqual(r.categoryAttempts.map(a => [a.categoryName, a.selected]), [
    ["Mammals", false], ["Reptiles", true]
  ]);
});

test("validation catches duplicates, missing names, oversized menus", () => {
  assert.match(validateTaxonomy({root: {children: [{id: "a", name: "A"}, {id: "a", name: "B"}]}}).join(), /Duplicate id/);
  assert.match(validateTaxonomy({root: {children: [{id: "a"}]}}).join(), /no `name`/);
  const big = {root: {children: Array.from({length: 25}, (_, i) => ({id: "n" + i, name: "N" + i}))}};
  assert.match(validateTaxonomy(big).join(), /limit is 24/);
  assert.match(validateTaxonomy({}).join(), /root/);
});

test("labels: description wins; otherwise names the leaves underneath", () => {
  assert.equal(labelFor({name: "Cat", description: "whiskers"}), "Cat: whiskers");
  assert.equal(labelFor({name: "Pets", children: [{name: "Cat"}, {name: "Dog"}]}), "Pets (Cat, Dog)");
  assert.equal(menuFor(animals.root).at(-1).label, "insufficient evidence");
  assert.ok(allMenus(animals).length === 4);
});

test("csv converter builds ancestors and descriptions, handles quotes", () => {
  const t = csvToTaxonomy('path,description\nMammals,warm-blooded\nMammals/Cat,"whiskers, purrs"\nBugs/Ant,tiny\n');
  assert.deepEqual(validateTaxonomy(t), []);
  assert.equal(t.root.children.length, 2);
  assert.equal(t.root.children[0].children[0].description, "whiskers, purrs");
  assert.equal(t.root.children[1].name, "Bugs");        // auto-created ancestor
});

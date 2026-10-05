// Hierarchical routing on top of a flat "pick one of K labels" scorer. Pure ES module: no DOM, no model code,
// so it runs in the browser and in Node tests. The scorer is injected (see classify()).

export const MAX_CANDIDATES = 25;          // model limit, including the abstention slot
export const ABSTENTION_ID = "__insufficient_evidence__";
export const ABSTENTION_LABEL = "insufficient evidence";   // the string the model was trained on; do not reword

/** Returns a list of human-readable problems (empty list = valid). */
export function validateTaxonomy(tax, maxCandidates = MAX_CANDIDATES) {
  const errors = [], seen = new Set();
  if (!tax || typeof tax !== "object" || !tax.root || typeof tax.root !== "object")
    return ["Taxonomy must be an object with a `root` node."];
  if (!Array.isArray(tax.root.children) || !tax.root.children.length)
    errors.push("`root` needs a non-empty `children` array.");
  (function walk(node, trail) {
    const where = trail.length ? trail.join(" > ") : "root";
    if (node !== tax.root) {
      if (typeof node.id !== "string" || !node.id) errors.push(`Node under "${where}" has no string \`id\`.`);
      else if (seen.has(node.id)) errors.push(`Duplicate id "${node.id}".`);
      else seen.add(node.id);
      if (typeof node.name !== "string" || !node.name.trim()) errors.push(`Node "${node.id ?? "?"}" under "${where}" has no \`name\`.`);
    }
    const kids = node.children ?? [];
    if (kids.length > maxCandidates - 1)
      errors.push(`"${where}" has ${kids.length} children; the limit is ${maxCandidates - 1} (one slot is reserved for abstention). Add an intermediate level.`);
    for (const c of kids) walk(c, [...trail, c.name ?? c.id ?? "?"]);
  })(tax.root, []);
  return errors;
}

function leafNames(node, out = [], cap = 8) {
  for (const c of node.children ?? []) {
    if (out.length >= cap) break;
    if (c.children?.length) leafNames(c, out, cap); else out.push(c.name);
  }
  return out;
}

/** Short, label-like text for one option. Long labels x many options overflow the token budget. */
export function labelFor(node) {
  const desc = (node.description ?? "").trim();
  if (desc) return `${node.name}: ${desc}`;
  if (node.children?.length) return `${node.name} (${leafNames(node).join(", ")})`;
  return node.name;
}

/** The menu shown to the model at one node: its children plus the abstention option. */
export function menuFor(node) {
  return [
    ...node.children.map(c => ({id: c.id, name: c.name, label: labelFor(c)})),
    {id: ABSTENTION_ID, name: "Insufficient evidence", label: ABSTENTION_LABEL}
  ];
}

/** Every internal node with its menu: used to pre-check token budgets. */
export function allMenus(tax) {
  const out = [];
  (function walk(node) {
    if (node.children?.length) {
      out.push({key: node.id ?? "root", name: node.name ?? "root", question: node.question || tax.question, candidates: menuFor(node)});
      node.children.forEach(walk);
    }
  })(tax.root);
  return out;
}

/**
 * Route to the highest-scoring top-level category, then classify within it.
 *   score({candidates, question, text}) -> Promise<{probabilities: [{id, probability}], tokenCount?, temperature?}>
 * Returns the best hypothesis plus alternatives. Each hypothesis has:
 *   path (nodes root->leaf), confidence (final-level probability), steps (per-level menus),
 *   abstained (true if the model said "insufficient evidence" below the top level; path is then partial).
 */
export async function classify(tax, text, score, {beam = 1, threshold = 0.85, defaultQuestion = "Which category best matches this description?"} = {}) {
  const problems = validateTaxonomy(tax);
  if (problems.length) throw new Error(problems[0]);
  const rootCandidates = menuFor(tax.root);
  const rootQuestion = tax.root.question || tax.question || defaultQuestion;
  const rootResult = await score({candidates: rootCandidates, question: rootQuestion, text});
  const rootStep = {
    nodeId: "root", nodeName: "root", question: rootQuestion,
    tokenCount: rootResult.tokenCount, temperature: rootResult.temperature,
    probabilities: rootResult.probabilities.map(r => ({id: r.id, name: rootCandidates.find(c => c.id === r.id)?.name ?? r.id, probability: r.probability}))
  };
  const categories = rootResult.probabilities
    .filter(r => r.id !== ABSTENTION_ID && tax.root.children.some(c => c.id === r.id))
    .sort((a, b) => b.probability - a.probability)
    .map(result => ({...result, node: tax.root.children.find(c => c.id === result.id)}));
  if (!categories.length) throw new Error("The model returned no top-level category score.");

  async function classifyCategory(category) {
    const rootNode = category.node;
    const initial = {node: rootNode, path: [rootNode], steps: [rootStep], p: 1, minP: 1};
    let frontier = rootNode.children?.length ? [initial] : [];
    const finished = rootNode.children?.length ? [] : [{
      ...initial, p: category.probability, minP: category.probability,
      confidence: category.probability, abstained: false
    }];
    while (frontier.length) {
      const next = [];
      for (const h of frontier) {
        const candidates = menuFor(h.node);
        const question = h.node.question || tax.question || defaultQuestion;
        const res = await score({candidates, question, text});
        const step = {
          nodeId: h.node.id ?? "root", nodeName: h.node.name ?? "root", question,
          tokenCount: res.tokenCount, temperature: res.temperature,
          probabilities: res.probabilities.map(r => ({id: r.id, name: candidates.find(c => c.id === r.id)?.name ?? r.id, probability: r.probability}))
        };
        for (const r of res.probabilities) {
          const base = {steps: [...h.steps, step], p: h.p * r.probability, minP: Math.min(h.minP, r.probability)};
          if (r.id === ABSTENTION_ID) { finished.push({...base, confidence: r.probability, node: h.node, path: h.path, abstained: true}); continue; }
          const child = h.node.children.find(c => c.id === r.id);
          if (!child) continue;
          const hyp = {...base, confidence: r.probability, node: child, path: [...h.path, child], abstained: false};
          (child.children?.length ? next : finished).push(hyp);
        }
      }
      next.sort((a, b) => b.p - a.p);
      frontier = next.slice(0, Math.max(1, beam));
    }
    finished.sort((a, b) => b.p - a.p);
    return {best: finished[0], alternatives: finished.slice(1, 4)};
  }

  const categoryRuns = [];
  for (const category of categories.slice(0, 2)) {
    const result = await classifyCategory(category);
    categoryRuns.push({
      categoryId: category.node.id, categoryName: category.node.name,
      categoryProbability: category.probability, ...result
    });
    if (categoryRuns.length === 1 && result.best.confidence >= threshold) break;
  }
  const selected = categoryRuns.reduce((best, current) =>
    current.best.confidence > best.best.confidence ? current : best);
  const best = selected.best;
  const route = best.abstained ? "ABSTAIN" : (best.confidence >= threshold ? "ACCEPT" : "REVIEW");
  return {
    best, route, alternatives: selected.alternatives,
    categoryAttempts: categoryRuns.map(attempt => ({
      categoryId: attempt.categoryId, categoryName: attempt.categoryName,
      categoryProbability: attempt.categoryProbability, confidence: attempt.best.confidence,
      abstained: attempt.best.abstained, selected: attempt === selected
    })),
    threshold, beam
  };
}

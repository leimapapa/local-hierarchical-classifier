// Usage: node tools/csv-to-taxonomy.mjs my_data.csv > web/taxonomies/mine.json [--question "Which ... ?"] [--name "My taxonomy"]
// CSV columns:  path,description        (header row required; `description` optional)
//   path         "/"-separated hierarchy, e.g. Mammals/Cat. Rows may be internal nodes (Mammals) or leaves (Mammals/Cat).
//                Missing ancestors are created automatically.
//   description  short distinguishing text (keep it under ~15 words). Strongly recommended for every row.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function parseCsv(text) {
  const rows = []; let row = [], cur = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ",") { row.push(cur); cur = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(cur); cur = ""; if (row.some(c => c.trim())) rows.push(row); row = []; }
    else cur += ch;
  }
  row.push(cur); if (row.some(c => c.trim())) rows.push(row);
  return rows;
}

export function csvToTaxonomy(text, {name = "My taxonomy", question = "Which category best matches this description?"} = {}) {
  const [header, ...rows] = parseCsv(text);
  const col = n => header.findIndex(h => h.trim().toLowerCase() === n);
  const ip = col("path"), id = col("description");
  if (ip < 0) throw new Error("CSV needs a `path` column.");
  const root = {children: []}, index = new Map();
  const ensure = parts => {
    let parent = root, key = "";
    for (const part of parts) {
      key = key ? `${key}/${part}` : part;
      let n = index.get(key);
      if (!n) { n = {id: key, name: part}; index.set(key, n); (parent.children ??= []).push(n); }
      parent = n;
    }
    return parent;
  };
  for (const r of rows) {
    const parts = (r[ip] ?? "").split("/").map(s => s.trim()).filter(Boolean);
    if (!parts.length) continue;
    const node = ensure(parts);
    const d = id >= 0 ? (r[id] ?? "").trim() : "";
    if (d) node.description = d;
  }
  return {name, question, root};
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), file = args.find(a => !a.startsWith("--") && args[args.indexOf(a) - 1]?.startsWith("--") === false || !a.startsWith("--"));
  const opt = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const input = args.find((a, i) => !a.startsWith("--") && !(args[i - 1] ?? "").startsWith("--"));
  if (!input) { console.error("usage: node tools/csv-to-taxonomy.mjs data.csv [--name N] [--question Q] > out.json"); process.exit(1); }
  process.stdout.write(JSON.stringify(csvToTaxonomy(readFileSync(input, "utf8"), {name: opt("--name"), question: opt("--question")}), null, 1) + "\n");
}

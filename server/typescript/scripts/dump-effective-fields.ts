// Usage: bun scripts/dump-effective-fields.ts <metadataDir>
// Prints stable JSON: { EntityName: [ "fieldName|subType|column|required|default|autoSet", ... ] }
// Sorted by entity then field so diffs are meaningful.
import { MetaDataLoader } from "@metaobjectsdev/metadata";

const dir = process.argv[2];
if (!dir) { console.error("need <metadataDir>"); process.exit(2); }

const res = await MetaDataLoader.fromDirectory(dir);
if (res.errors.length) {
  console.error("LOAD ERRORS:", JSON.stringify(res.errors, null, 2));
  process.exit(1);
}

const out: Record<string, string[]> = {};
function attr(f: any, n: string): string {
  const v = f.attr?.(n);
  return v === undefined || v === null ? "" : String(v);
}
function walk(node: any): void {
  if (!node) return;
  if (node.type === "object" && node.subType === "entity" && node.name && !node.isAbstract) {
    const fields = (node.fields?.() ?? []) as any[];
    out[node.name] = fields
      .map((f) => [f.name, f.subType, attr(f, "column"), attr(f, "required"), attr(f, "default"), attr(f, "autoSet")].join("|"))
      .sort();
  }
  for (const k of (node.children?.() ?? [])) walk(k);
}
walk(res.root);
const sorted: Record<string, string[]> = {};
for (const k of Object.keys(out).sort()) sorted[k] = out[k];
console.log(JSON.stringify(sorted, null, 2));

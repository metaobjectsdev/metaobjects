// Usage:
//   bun scripts/dump-effective-fields.ts <metadataDir>              -> DDL tuple dump
//   bun scripts/dump-effective-fields.ts <metadataDir> --validators -> per-field validators
import { MetaDataLoader } from "@metaobjectsdev/metadata";

const dir = process.argv[2];
const mode = process.argv[3];
if (!dir) { console.error("need <metadataDir>"); process.exit(2); }

const res = await MetaDataLoader.fromDirectory(dir);
if (res.errors.length) {
  console.error("LOAD ERRORS:", JSON.stringify(res.errors, null, 2));
  process.exit(1);
}

function attr(f: any, n: string): string {
  const v = f.attr?.(n);
  return v === undefined || v === null ? "" : String(v);
}
function validatorSig(v: any): string {
  const pattern = v.attr?.("pattern");
  if (pattern !== undefined && pattern !== null) return `${v.subType}:${pattern}`;
  const min = v.attr?.("min"), max = v.attr?.("max");
  const bounds = [min, max].filter((x) => x !== undefined && x !== null).join("..");
  return bounds ? `${v.subType}:${bounds}` : `${v.subType}`;
}

const out: Record<string, any> = {};
function walk(node: any): void {
  if (!node) return;
  if (node.type === "object" && node.subType === "entity" && node.name && !node.isAbstract) {
    const fields = (node.fields?.() ?? []) as any[];
    if (mode === "--validators") {
      const fv: Record<string, string[]> = {};
      for (const f of fields) {
        const vs = (f.validators?.() ?? []) as any[];
        if (vs.length) fv[f.name] = vs.map(validatorSig).sort();
      }
      if (Object.keys(fv).length) out[node.name] = fv;
    } else {
      out[node.name] = fields
        .map((f) => [f.name, f.subType, attr(f, "column"), attr(f, "required"), attr(f, "default"), attr(f, "autoSet")].join("|"))
        .sort();
    }
  }
  for (const k of (node.children?.() ?? [])) walk(k);
}
walk(res.root);
const sorted: Record<string, any> = {};
for (const k of Object.keys(out).sort()) sorted[k] = out[k];
console.log(JSON.stringify(sorted, null, 2));

// Differential fixture generator — random valid metadata, deterministic by seed.

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Intentionally a small subset for fixture generation — @metaobjectsdev/metadata
// exports the full FIELD_SUBTYPES array (including currency, date, object, etc.)
// which is too broad for deterministic round-trip fixtures.  Keep this list in
// sync with the generator's intent: only "safe" primitive types that the TS
// oracle handles without extra provider registration.
const FIELD_SUBTYPES = ["string", "int", "long", "boolean"] as const;

/** Generate a canonical-shaped metadata document deterministically from a seed. */
export function generateMetadata(seed: number): unknown {
  const rand = mulberry32(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const objectCount = 1 + Math.floor(rand() * 4); // 1–4 objects per document
  const children: unknown[] = [];
  for (let o = 0; o < objectCount; o++) {
    const fieldCount = 1 + Math.floor(rand() * 5); // 1–5 fields per object
    const fields: unknown[] = [];
    for (let f = 0; f < fieldCount; f++) {
      fields.push({ [`field.${pick(FIELD_SUBTYPES)}`]: { name: `f${o}_${f}` } });
    }
    children.push({ "object.entity": { name: `Obj${o}`, children: fields } });
  }
  return { "metadata.root": { children } };
}

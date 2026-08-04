// WARN_ENUM_NORMALIZE_AMBIGUOUS — an authoring guard for a silent mis-extraction.
//
// `@normalize: strip` (the DEFAULT) upper-cases and keeps only [A-Z0-9], so it
// erases every separator. When a vocabulary contains a member equal to the
// concatenation of two or more OTHER members, a delimited value fed to that field
// concatenates into a wrong-but-VALID member and coerces successfully:
//
//   values = {READ, WRITE, READWRITE};  input "read|write"  ->  READWRITE
//   (state EXTRACTED, not MALFORMED — wrong-and-green)
//
// The collision is detectable from metadata alone (@values + the effective
// normalize mode), so the loader warns the author at declaration time. It is a
// WARNING, not an error: such a vocabulary is perfectly legal and unambiguous for
// exact matching — only normalize-based coercion is at risk. `collapse` and `none`
// are immune (neither erases a non-[\s_-] delimiter), so the check skips them.

import { describe, expect, test } from "bun:test";
import { MetaDataLoader } from "../src/loader/meta-data-loader.js";
import { InMemoryStringSource } from "../src/loader/meta-data-source.js";
import { WARNING_CODES } from "../src/errors.js";

async function load(doc: unknown) {
  const loader = new MetaDataLoader();
  return loader.load([
    new InMemoryStringSource(JSON.stringify(doc), { id: "test.json" }),
  ]);
}

/** A root-level shared abstract field.enum with the given members + optional @normalize. */
function enumDoc(values: string[], normalize?: string): unknown {
  const decl: Record<string, unknown> = { name: "Access", abstract: true, "@values": values };
  if (normalize !== undefined) decl["@normalize"] = normalize;
  return { "metadata.root": { package: "demo", children: [{ "field.enum": decl }] } };
}

describe("WARN_ENUM_NORMALIZE_AMBIGUOUS registration", () => {
  test("registered in WARNING_CODES", () => {
    expect(WARNING_CODES).toContain("WARN_ENUM_NORMALIZE_AMBIGUOUS");
  });
});

describe("WARN_ENUM_NORMALIZE_AMBIGUOUS detection", () => {
  test("a member equal to the concatenation of two others warns", async () => {
    const { errors, warnings } = await load(enumDoc(["READ", "WRITE", "READWRITE"]));
    // Legal vocabulary — a warning, never an error.
    expect(errors.map((e) => e.message)).toEqual([]);
    const w = warnings.filter((x) => x.code === "WARN_ENUM_NORMALIZE_AMBIGUOUS");
    expect(w.length).toBe(1);
    // The message must name the colliding member AND its segmentation, or the
    // author cannot act on it.
    expect(w[0]!.message).toContain("READWRITE");
    expect(w[0]!.message).toContain("READ");
    expect(w[0]!.message).toContain("WRITE");
  });

  test("a three-way concatenation warns (word-break, not just pairs)", async () => {
    const { warnings } = await load(enumDoc(["A", "B", "C", "ABC"]));
    const w = warnings.filter((x) => x.code === "WARN_ENUM_NORMALIZE_AMBIGUOUS");
    expect(w.length).toBe(1);
    expect(w[0]!.message).toContain("ABC");
  });

  test("separator variants still collide after stripping", async () => {
    // SOCIAL_ATTACK strips to SOCIALATTACK == SOCIAL + ATTACK.
    const { warnings } = await load(enumDoc(["SOCIAL", "ATTACK", "SOCIAL_ATTACK"]));
    expect(warnings.filter((x) => x.code === "WARN_ENUM_NORMALIZE_AMBIGUOUS").length).toBe(1);
  });

  test("a vocabulary with no concatenation collision is silent", async () => {
    const { warnings } = await load(enumDoc(["FRIENDLY", "HOSTILE", "NEUTRAL"]));
    expect(warnings.filter((x) => x.code === "WARN_ENUM_NORMALIZE_AMBIGUOUS")).toEqual([]);
  });

  test("a member is not a concatenation of ITSELF (no self-match)", async () => {
    const { warnings } = await load(enumDoc(["READ", "WRITE"]));
    expect(warnings.filter((x) => x.code === "WARN_ENUM_NORMALIZE_AMBIGUOUS")).toEqual([]);
  });
});

describe("WARN_ENUM_NORMALIZE_AMBIGUOUS mode gating", () => {
  test("@normalize: collapse is immune — no warning", async () => {
    const { warnings } = await load(enumDoc(["READ", "WRITE", "READWRITE"], "collapse"));
    expect(warnings.filter((x) => x.code === "WARN_ENUM_NORMALIZE_AMBIGUOUS")).toEqual([]);
  });

  test("@normalize: none is immune — no warning", async () => {
    const { warnings } = await load(enumDoc(["READ", "WRITE", "READWRITE"], "none"));
    expect(warnings.filter((x) => x.code === "WARN_ENUM_NORMALIZE_AMBIGUOUS")).toEqual([]);
  });

  test("@normalize: strip stated explicitly warns exactly as the default does", async () => {
    const { warnings } = await load(enumDoc(["READ", "WRITE", "READWRITE"], "strip"));
    expect(warnings.filter((x) => x.code === "WARN_ENUM_NORMALIZE_AMBIGUOUS").length).toBe(1);
  });
});

describe("WARN_ENUM_NORMALIZE_AMBIGUOUS scope", () => {
  test("warns once at the declaring node, not on every field that extends it", async () => {
    const { warnings } = await load({
      "metadata.root": {
        package: "demo",
        children: [
          { "field.enum": { name: "Access", abstract: true, "@values": ["READ", "WRITE", "READWRITE"] } },
          {
            "object.entity": {
              name: "Doc",
              children: [
                { "source.rdb": { "@table": "docs" } },
                { "field.long": { name: "id" } },
                { "field.enum": { name: "a", extends: "Access" } },
                { "field.enum": { name: "b", extends: "Access" } },
                { "identity.primary": { name: "id", "@fields": "id" } },
              ],
            },
          },
        ],
      },
    });
    expect(warnings.filter((x) => x.code === "WARN_ENUM_NORMALIZE_AMBIGUOUS").length).toBe(1);
  });
});

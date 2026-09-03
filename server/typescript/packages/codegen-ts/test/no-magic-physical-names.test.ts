// NO MAGIC STRINGS — the gate that makes "generated code references the constant"
// checkable instead of asserted.
//
// The `<Entity>Names` artifact exists so a physical database name is spelled ONCE per
// run. That guarantee is worth nothing unless every generator actually REFERENCES it,
// and nothing proved that: the gaps were found by reading generators one at a time,
// which is exactly the method that misses the next one.
//
// METHOD — a DE-BLINDED fixture. Every physical name below is deliberately impossible
// for a generator to produce by accident: it is not the snake_case of its field name,
// not the pluralization of its object name, and carries a `zz_phys_` prefix nothing
// else in the codebase uses. So a generator that embeds a literal cannot be confused
// with one that derived the same string by coincidence — if the token appears in a
// file, that file hard-coded it.
//
// The assertion is the inverse of the usual one: each de-blinded token must appear in
// the Names artifact and NOWHERE ELSE. A failure names the file and the token, so the
// gate enumerates the remaining gaps by itself rather than relying on someone to list
// them.
//
// This is the same de-blinding that unmasked the `@column` defects in the persistence
// corpus (0.24.5): a fixture whose physical names ARE the derivable ones cannot tell a
// reference from a re-derivation.

import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { runGen, defineConfig } from "../src/index.js";
import {
  entityFile, queriesFile, routesFile, namesFile, barrel,
} from "../src/generators/index.js";

// ---------------------------------------------------------------------------
// The de-blinded fixture.
// ---------------------------------------------------------------------------
// Every physical name is `zz_phys_*` and deliberately UNRELATED to the logical name
// it belongs to, so no derivation can produce it.
const TABLE = "zz_phys_tbl_alpha";        // NOT pluralize(snake("Customer"))
const COL_ID = "zz_phys_col_ident";       // NOT snake("id")
const COL_EMAIL = "zz_phys_col_mail";     // NOT snake("email")
const COL_FK = "zz_phys_col_owner";       // NOT snake("customerId")
const ORDER_TABLE = "zz_phys_tbl_beta";   // NOT pluralize(snake("Order"))
const ORDER_ID = "zz_phys_col_okey";
const VIEW = "zz_phys_view_gamma";        // NOT "v_" + snake("CustomerSummary")
const VO_COL = "zz_phys_col_street";
const JSONB_COL = "zz_phys_col_blob";     // a single-jsonb-column value object
const WT_TABLE = "zz_phys_tbl_delta";     // a write-through entity's table...
const WT_VIEW = "zz_phys_view_delta";     // ...and its replica view
const WT_ID = "zz_phys_col_acct";         // the write-through entity's key column

/**
 * How a physical name is expected to reach generated output today.
 *
 * A `knownLiteral` is PINNED, not exempted: the gate asserts the literal is still there,
 * so the day a generator starts referencing a constant instead, the pin fails and says
 * "promote it". A known gap that stops being a gap without anyone noticing is how a
 * ledger rots.
 */
type Reach = "constant" | "knownLiteral";

/** Every de-blinded token, with the constant a generator should have referenced. */
const TOKENS: ReadonlyArray<{
  readonly literal: string;
  readonly shouldUse: string;
  readonly reach: Reach;
  readonly why?: string;
}> = [
  { literal: TABLE,       shouldUse: "CustomerNames.name",                  reach: "constant" },
  { literal: COL_ID,      shouldUse: "CustomerNames.fields.id.column",      reach: "constant" },
  { literal: COL_EMAIL,   shouldUse: "CustomerNames.fields.email.column",   reach: "constant" },
  { literal: ORDER_TABLE, shouldUse: "OrderNames.name",                     reach: "constant" },
  { literal: ORDER_ID,    shouldUse: "OrderNames.fields.id.column",         reach: "constant" },
  { literal: COL_FK,      shouldUse: "OrderNames.fields.customerId.column", reach: "constant" },
  { literal: VIEW,        shouldUse: "CustomerSummaryNames.name",           reach: "constant" },
  { literal: VO_COL,      shouldUse: "CustomerNames.fields.street.column",  reach: "constant" },
  { literal: JSONB_COL,   shouldUse: "CustomerNames.fields.profile.column", reach: "constant" },
  { literal: WT_TABLE,    shouldUse: "AccountNames.name",                   reach: "constant" },
  { literal: WT_ID,       shouldUse: "AccountNames.fields.id.column",       reach: "constant" },
  {
    literal: WT_VIEW, shouldUse: "(no constant exists)", reach: "knownLiteral",
    why:
      "A write-through entity has TWO physical names; <Entity>Names carries the PRIMARY " +
      "source's only (resolveObjectNames). The replica view name has no slot in the " +
      "artifact's schema, so there is nothing for the read path to reference.",
  },
];

const MODEL = {
  "metadata.root": {
    package: "acme",
    children: [
      {
        // A value object: no source, so no `AddressNames` — its members reach output only
        // through the owning entity's column.
        "object.value": {
          name: "Address",
          children: [{ "field.string": { name: "road", "@column": "zz_phys_col_road" } }],
        },
      },
      {
        "object.entity": {
          name: "Customer",
          children: [
            { "source.rdb": { "@table": TABLE } },
            { "field.long":   { name: "id",    "@column": COL_ID } },
            { "field.string": { name: "email", "@column": COL_EMAIL, "@required": true } },
            { "field.string": { name: "street", "@column": VO_COL } },
            { "field.object": { name: "profile", "@column": JSONB_COL, "@objectRef": "Address", "@storage": "jsonb" } },
            { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
          ],
        },
      },
      {
        // A projection: its physical name comes from viewName() (own read-only sources),
        // a DIFFERENT resolver than the table path — documented today as never reaching
        // a names constant.
        "object.projection": {
          name: "CustomerSummary",
          children: [
            { "source.rdb": { "@kind": "view", "@view": VIEW } },
            { "field.long":   { name: "id",    extends: "Customer.id" } },
            { "field.string": { name: "email", children: [{ "origin.passthrough": { "@from": "Customer.email" } }] } },
            { "identity.primary": { name: "pk", extends: "Customer.pk" } },
          ],
        },
      },
      {
        "object.entity": {
          name: "Order",
          children: [
            { "source.rdb": { "@table": ORDER_TABLE } },
            { "field.long": { name: "id",         "@column": ORDER_ID } },
            { "field.long": { name: "customerId", "@column": COL_FK } },
            { "identity.primary":   { name: "pk", "@fields": "id", "@generation": "increment" } },
            { "identity.reference": { name: "customerRef", "@fields": "customerId", "@references": "Customer" } },
            {
              "relationship.association": {
                name: "customer", "@cardinality": "one", "@objectRef": "Customer",
              },
            },
          ],
        },
      },
      {
        // Write-through: writes go to the table, reads to the replica view — TWO physical
        // names on one object, only one of which the names artifact can hold today.
        "object.entity": {
          name: "Account",
          children: [
            { "source.rdb": { "@table": WT_TABLE, "@role": "primary" } },
            { "source.rdb": { "@kind": "view", "@view": WT_VIEW, "@role": "replica" } },
            { "field.long": { name: "id", "@column": WT_ID } },
            { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
          ],
        },
      },
    ],
  },
};

/** Every file the run wrote, as { relative path -> content }. */
function readTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else out[relative(root, full)] = readFileSync(full, "utf8");
    }
  };
  walk(root);
  return out;
}

/** A names artifact is the ONE file allowed to spell a physical name literally. */
const isNamesArtifact = (path: string): boolean => path.endsWith(".names.ts");

async function generate(): Promise<Record<string, string>> {
  const loader = new MetaDataLoader();
  const { root, errors } = await loader.load([
    new InMemoryStringSource(JSON.stringify(MODEL), { id: "no-magic.json" }),
  ]);
  // A gate whose fixture the loader would reject proves nothing.
  expect(errors.map((e) => e.message)).toEqual([]);

  const dir = mkdtempSync(join(tmpdir(), "no-magic-"));
  try {
    await runGen({
      config: defineConfig({
        outDir: dir,
        extStyle: "none",
        dbImport: "~/server/db",
        dialect: "sqlite",
        // namesFile() IS in the run: this gate measures the ON arm. The OFF arm
        // legitimately emits literals — that is the documented fallback.
        generators: [namesFile(), entityFile(), queriesFile(), routesFile(), barrel()],
      }),
      metadata: root,
    });
    return readTree(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("no magic physical names in generated output", () => {
  it("emits a names artifact carrying every de-blinded physical name", async () => {
    const tree = await generate();
    const names = Object.entries(tree).filter(([p]) => isNamesArtifact(p));
    // Teeth: if no names artifact were emitted at all, every assertion below would
    // pass vacuously (nothing to find the literal in, nothing to compare against).
    expect(names.length).toBeGreaterThan(0);
    const all = names.map(([, c]) => c).join("\n");
    const missing = TOKENS
      .filter((t) => t.reach === "constant" && !all.includes(t.literal))
      .map((t) => `${t.literal} appears in no names artifact — ${t.shouldUse} cannot exist`);
    expect(missing.sort()).toEqual([]);
  });

  it("references the constant everywhere else — no generated file spells one literally", async () => {
    const tree = await generate();
    const offenders: string[] = [];
    for (const [path, content] of Object.entries(tree)) {
      if (isNamesArtifact(path)) continue;
      for (const { literal, shouldUse, reach } of TOKENS) {
        if (reach !== "constant") continue;
        if (content.includes(literal)) {
          offenders.push(`${path}: hard-codes "${literal}" — should reference ${shouldUse}`);
        }
      }
    }
    // Reported as a sorted list rather than a boolean, so a failure enumerates every
    // remaining gap in one run instead of one per fix-and-rerun cycle.
    expect(offenders.sort()).toEqual([]);
  });

  it("actually REFERENCES each constant — absence of the literal is not use of the constant", async () => {
    // The teeth for the test above. "No file contains the literal" is satisfied just as
    // well by a generator that emits NOTHING, or by one that emits a name it derived
    // instead of read. This asserts the positive: for every de-blinded name, some
    // generated file that is not the names artifact carries the constant REFERENCE.
    //
    // Without this the gate would have gone green on a port whose names artifact has no
    // consumer at all — which is exactly the state Java and Python are in.
    const tree = await generate();
    const consumers = Object.entries(tree).filter(([p]) => !isNamesArtifact(p));
    const body = consumers.map(([, c]) => c).join("\n");
    const unreferenced = TOKENS
      .filter((t) => t.reach === "constant" && !body.includes(t.shouldUse))
      .map(({ literal, shouldUse }) => `${shouldUse} (for "${literal}") is referenced by no generated file`);
    expect(unreferenced.sort()).toEqual([]);
  });

  it("lets no physical name escape that is not a declared known literal", async () => {
    // The exhaustive form, and the strongest statement this gate can make. TOKENS says what
    // each KNOWN name should do; this says there is nothing ELSE. Every physical name in the
    // fixture is `zz_phys_`-prefixed, so any such token appearing outside a names artifact is
    // a physical name that escaped, whether or not anyone thought to list it.
    //
    // Equality in BOTH directions. A new escape fails — including one from a generator added
    // after this test was written, which a hand-maintained list would miss. And so does a
    // knownLiteral quietly fixed: a "known gaps" list nothing re-checks is how a ledger ends
    // up describing a codebase that moved on.
    const tree = await generate();
    const escaped = new Set(
      Object.entries(tree)
        .filter(([p]) => !isNamesArtifact(p))
        .flatMap(([, c]) => c.match(/zz_phys_\w+/g) ?? []),
    );
    const declared = TOKENS.filter((t) => t.reach === "knownLiteral").map((t) => t.literal);
    expect([...escaped].sort()).toEqual(declared.sort());
  });
});

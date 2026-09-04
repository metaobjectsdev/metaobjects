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
//
// WHAT THE FIXTURE MUST CONTAIN is the other half, and the half that failed first. This
// gate ran green for its whole life over a fixture with no TPH pair, no `field.enum`, no
// `identity.secondary`, no `index.lookup`, no callable source, no `@schema`, no `@isArray`
// and no abstract base — and on one dialect. Every one of those shapes is handled on its
// own code path, so the green meant "the paths we happened to model are clean", which is
// a much smaller claim than the one the gate's name makes. Adding them found four escapes
// and one silently-dropped name. A gate is only ever as wide as its fixture, so treat the
// model below as the load-bearing part of this file and add to it whenever a generator
// grows a new path.
//
// ONE category is out of this method's reach, and it is worth naming rather than leaving a
// reader to assume otherwise: a RELATIONSHIP-SYNTHESIZED foreign-key column — the column a
// parent-side `relationship.composition @cardinality: many` contributes to the child's
// table when the child declares no field for it. That name is DERIVED (the relationship's
// short name + "Id", through the naming strategy), never declared, so there is no physical
// name to de-blind and nothing for a generator to restate. It is a different defect class —
// a name computed twice by two derivations — and `<Entity>Names` has no constant for it
// because it belongs to no field of any object.

import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { runGen, defineConfig } from "../src/index.js";
import {
  entityFile, queriesFile, routesFile, namesFile, callableFile, barrel,
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

// --- Shapes the original fixture did not contain -----------------------------------
// Each block below exists because a generator handles it on a DIFFERENT code path from
// the plain-entity one above, and a path no fixture reaches is a path this gate cannot
// speak for. The list is not decorative: every one of them turned up an escape or a
// silently-dropped name the moment it was added.
const WIDGET_TABLE = "zz_phys_tbl_wid";   // the index/enum/schema entity's table
const TPH_TABLE = "zz_phys_tbl_veh";      // a TPH discriminator base's table
const TPH_ID = "zz_phys_col_vid";
const TPH_DISC = "zz_phys_col_kind";      // the discriminator column
const TPH_SUB_COL = "zz_phys_col_doors";  // a SUBTYPE's own column, folded into the base table
const SCHEMA = "zz_phys_sch_one";         // @schema on a source.rdb
const ENUM_COL = "zz_phys_col_stat";      // a string-backed field.enum (drives a CHECK)
const ENUM_INT_COL = "zz_phys_col_grad";  // an int-backed field.enum (@intValueMap)
const ARRAY_COL = "zz_phys_col_tags";     // an @isArray field
const ALT_COL = "zz_phys_col_alt";        // the column an identity.secondary keys on
const SEC_INDEX = "zz_phys_idx_sec";      // an identity.secondary's own name
const LKP_INDEX = "zz_phys_idx_lkp";      // an index.lookup's own name
const ABS_COL = "zz_phys_col_bid";        // a column declared on an ABSTRACT base
const PROC = "zz_phys_proc_alpha";        // a storedProc source's physical name
const PROC_ARG_COL = "zz_phys_col_since";
const PROC_OUT_COL = "zz_phys_col_total";
// The enum columns also produce composite CHECK-constraint names (#293's
// `<table>_<column>_chk`), and they are deliberately NOT bound here. Two `const`s holding
// those names used to sit at this spot, read by nothing, under a comment claiming "the
// exhaustive test below sees them as `zz_phys_` tokens whether or not anyone names them".
// That has it backwards: correct output COMPOSES the CHECK name from the two constants at
// runtime, so no `zz_phys_` literal appears for the scan to see — and if a generator ever
// did spell one, the scan's both-directions equality would fail it as an undeclared token
// with no row to book it against, which is the protection. The names were never the thing
// under test; the composition is, and `secondary-index-name-parity` owns that.

/**
 * How a physical name reaches generated output today.
 *
 * Both non-`constant` values are PINNED, not exempted: the gate asserts the literal is
 * still there, so the day a generator starts referencing a constant instead, the pin
 * fails and says "promote it". A known gap that stops being a gap without anyone
 * noticing is how a ledger rots.
 *
 * The two are kept APART because they are not the same claim, and collapsing them is how
 * a defect acquires the standing of a ruling. A `knownLiteral` is STRUCTURAL — there is
 * no constant to reference, and none should be expected. An `escape` is a DEFECT — the
 * constant exists, in an artifact this very run emits, and a generator spelled the name
 * again anyway. Every `escape` row is additionally required to have a reachable constant
 * (see the last test), so no row can sit here claiming a fix is impossible when it is
 * merely undone.
 *
 * `dropped` is the third failure mode and the one this gate was BLIND to until the fixture
 * grew a shape that has one. An escape spells a name twice; a dropped name is spelled
 * ZERO times — the artifact carries it, no generator reads it, and the binding silently
 * takes a default instead. Every "does any file contain this literal" assertion passes
 * for it, which is why the REFERENCE test is the load-bearing one and why a dropped name
 * needs a row that pins its absence rather than merely tolerating it.
 */
type Reach = "constant" | "knownLiteral" | "escape" | "dropped";

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

  // --- TPH: a discriminator base folds its subtypes' own columns into one table ------
  { literal: TPH_TABLE,   shouldUse: "VehicleNames.name",                   reach: "constant" },
  { literal: TPH_ID,      shouldUse: "VehicleNames.fields.id.column",       reach: "constant" },
  { literal: TPH_DISC,    shouldUse: "VehicleNames.fields.kind.column",     reach: "constant" },
  { literal: TPH_SUB_COL, shouldUse: "CarNames.fields.doors.column",     reach: "constant" },

  // --- the enum / index / schema entity ---------------------------------------------
  { literal: WIDGET_TABLE,  shouldUse: "WidgetNames.name",                    reach: "constant" },
  { literal: ENUM_COL,      shouldUse: "WidgetNames.fields.status.column",    reach: "constant" },
  { literal: ENUM_INT_COL,  shouldUse: "WidgetNames.fields.grade.column",     reach: "constant" },
  { literal: ARRAY_COL,     shouldUse: "WidgetNames.fields.tags.column",      reach: "constant" },
  { literal: ALT_COL,       shouldUse: "WidgetNames.fields.alt.column",       reach: "constant" },
  { literal: ABS_COL,       shouldUse: "WidgetNames.fields.id.column",        reach: "constant" },
  {
    literal: SCHEMA, shouldUse: "WidgetNames.schema", reach: "dropped",
    why:
      "`@schema` reaches the names artifact and NO generator anywhere reads it: TS's " +
      "resolveTableSchema feeds names.ts and the view-DDL builder only, so the postgres " +
      "binding emits `pgTable(Names.name, …)` with no schema and the table lands in the " +
      "default schema. C# (Table() is DbTable ?? Name) and Kotlin Exposed do the same. " +
      "This is a BEHAVIOUR bug that happens to show up here, not a naming nit — and it " +
      "is pinned rather than merely absent so that wiring @schema fails this row and " +
      "says 'promote it' instead of passing unnoticed.",
  },

  // --- the callable (stored procedure) ----------------------------------------------
  { literal: PROC,         shouldUse: "ProcOutNames.name",                   reach: "constant" },
  { literal: PROC_OUT_COL, shouldUse: "ProcOutNames.fields.total.column",    reach: "constant" },

  // --- index names: a category with no slot in the artifact -------------------------
  {
    literal: SEC_INDEX, shouldUse: "(no constant exists)", reach: "knownLiteral",
    why:
      "An index's database name IS its metamodel `name` — an identity.secondary and an " +
      "index.lookup have no `@column`-style physical spelling to diverge from, so there " +
      "is nothing here for a generator to RESTATE. ObjectNames carries kind/name/schema/" +
      "fields and no index slot. The real risk for these names is codegen and migrate " +
      "computing them differently, which is a parity question rather than a magic-string " +
      "one, and is owned by `secondary-index-name-parity.test.ts`. Pinned so that the day " +
      "the artifact grows an index slot, this row fails and says 'promote it'.",
  },
  {
    literal: LKP_INDEX, shouldUse: "(no constant exists)", reach: "knownLiteral",
    why: "As SEC_INDEX — an index.lookup's database name is its metamodel `name`.",
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
        // An ABSTRACT base carrying a field. Its column reaches output only through the
        // concrete entity that extends it, on the resolving-accessor path (ADR-0039) —
        // a different lookup from a field declared in place.
        "object.entity": {
          name: "AbstractKeyed",
          abstract: true,
          children: [{ "field.long": { name: "id", "@column": ABS_COL } }],
        },
      },
      {
        // TPH. The base's table absorbs every concrete subtype's own columns, so this is
        // the one shape where a generator emits a column belonging to a DIFFERENT entity
        // than the one whose names artifact it has in hand.
        "object.entity": {
          name: "Vehicle",
          "@discriminator": "kind",
          children: [
            { "source.rdb": { "@table": TPH_TABLE } },
            { "field.long":   { name: "id",   "@column": TPH_ID } },
            { "field.string": { name: "kind", "@column": TPH_DISC } },
            { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
          ],
        },
      },
      {
        "object.entity": {
          name: "Car",
          extends: "Vehicle",
          "@discriminatorValue": "Car",
          children: [{ "field.int": { name: "doors", "@column": TPH_SUB_COL } }],
        },
      },
      {
        // @schema, both field.enum arms (string- and int-backed, each of which emits a
        // CHECK constraint), an @isArray column, an identity.secondary and an
        // index.lookup — five paths the original fixture reached none of.
        "object.entity": {
          name: "Widget",
          extends: "AbstractKeyed",
          children: [
            { "source.rdb": { "@table": WIDGET_TABLE, "@schema": SCHEMA } },
            { "field.enum":   { name: "status", "@column": ENUM_COL, "@values": ["OPEN", "SHUT"] } },
            { "field.enum":   { name: "grade",  "@column": ENUM_INT_COL, "@values": ["LO", "HI"],
                                "@intValueMap": { LO: 1, HI: 2 } } },
            { "field.string": { name: "tags", isArray: true, "@column": ARRAY_COL } },
            { "field.string": { name: "alt", "@column": ALT_COL } },
            { "identity.primary":   { name: "pk", "@fields": "id", "@generation": "increment" } },
            { "identity.secondary": { name: SEC_INDEX, "@fields": ["alt"] } },
            { "index.lookup":       { name: LKP_INDEX, "@fields": ["status"] } },
          ],
        },
      },
      {
        // FR-015 — a stored-procedure projection and its @parameterRef value object.
        // `callableFile()` is a THIRD physical-name resolver (callableSource), reached by
        // no other generator, so a fixture without one leaves that whole path unmeasured.
        // PROC_ARG_COL carries no TOKENS row on purpose: a value object has no source and
        // so no <Vo>Names, and the callable binds its arguments POSITIONALLY, so the column
        // name is never emitted by anything. It is still declared here so the exhaustive
        // test would convict a generator that started spelling it.
        "object.value": {
          name: "ProcArgs",
          children: [{ "field.long": { name: "since", "@column": PROC_ARG_COL } }],
        },
      },
      {
        "object.projection": {
          name: "ProcOut",
          children: [
            { "source.rdb": { "@kind": "storedProc", "@proc": PROC, "@parameterRef": "ProcArgs" } },
            { "field.long": { name: "total", "@column": PROC_OUT_COL } },
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

/**
 * The dialects this gate runs. Not a formality: a column's type mapping, an index's
 * emitted form and the whole enum-CHECK path differ per dialect, so a gate that runs one
 * of them speaks for one of them. The postgres arm is also the only place `@schema` can
 * possibly be honoured — SQLite has no schema concept — so running sqlite alone made the
 * dropped-schema question unaskable.
 */
const DIALECTS = ["sqlite", "postgres"] as const;

async function generate(dialect: (typeof DIALECTS)[number]): Promise<Record<string, string>> {
  // STRICT deliberately. `new MetaDataLoader()` defaults to strict:false, so the
  // assertion below used to prove only that the fixture parses — not that it is legal
  // under the sealed registry (ADR-0023), which is the rule an adopter's model actually
  // faces. A gate is allowed to model shapes; it is not allowed to model shapes that
  // would not load. The unregistered-attribute bug class this whole stream chased
  // (`@procName`, `@param`) survived for exactly this reason on another port.
  const loader = new MetaDataLoader({ strict: true });
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
        dialect,
        // namesFile() IS in the run: this gate measures the ON arm. The OFF arm
        // legitimately emits literals — that is the documented fallback.
        generators: [
          namesFile(), entityFile(), queriesFile(), routesFile(), callableFile(), barrel(),
        ],
      }),
      metadata: root,
    });
    return readTree(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const dialect of DIALECTS) {
describe(`no magic physical names in generated output (${dialect})`, () => {
  it("emits a names artifact carrying every de-blinded physical name", async () => {
    const tree = await generate(dialect);
    const names = Object.entries(tree).filter(([p]) => isNamesArtifact(p));
    // Teeth: if no names artifact were emitted at all, every assertion below would
    // pass vacuously (nothing to find the literal in, nothing to compare against).
    expect(names.length).toBeGreaterThan(0);
    const all = names.map(([, c]) => c).join("\n");
    const missing = TOKENS
      // A composite escape (`shouldUse` is a template expression) is COMPOSED from two
      // constants rather than being one, so no artifact carries it whole; the names it
      // restates each carry a row of their own.
      .filter((t) => t.reach !== "knownLiteral" && !t.shouldUse.startsWith("`"))
      .filter((t) => !all.includes(t.literal))
      .map((t) => `${t.literal} appears in no names artifact — ${t.shouldUse} cannot exist`);
    expect(missing.sort()).toEqual([]);
  });

  it("references the constant everywhere else — no generated file spells one literally", async () => {
    const tree = await generate(dialect);
    const offenders: string[] = [];
    // A declared escape can CONTAIN a constant's literal as a substring — the enum CHECK
    // name is `<table>_<column>_chk`, so scanning raw content reports the table and the
    // column a second time for a restatement already booked against the composite. Mask
    // the declared literals first, so a residual hit is a standalone restatement and each
    // defect is reported against exactly one row.
    // Longest literal FIRST: the composite CHECK name contains a shorter escape, and
    // masking the short one first dismantles the composite so it never matches, leaving
    // the table name it wraps to be reported as a standalone hit it is not.
    const declaredLiterals = TOKENS
      .filter((t) => t.reach === "escape" || t.reach === "knownLiteral")
      .map((t) => t.literal)
      .sort((a, b) => b.length - a.length);
    const masked = (content: string): string =>
      declaredLiterals.reduce((acc, lit) => acc.split(lit).join(""), content);
    for (const [path, content] of Object.entries(tree)) {
      if (isNamesArtifact(path)) continue;
      const body = masked(content);
      for (const { literal, shouldUse, reach } of TOKENS) {
        if (reach !== "constant") continue;
        if (body.includes(literal)) {
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
    const tree = await generate(dialect);
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
    const tree = await generate(dialect);
    const escaped = new Set(
      Object.entries(tree)
        .filter(([p]) => !isNamesArtifact(p))
        .flatMap(([, c]) => c.match(/zz_phys_\w+/g) ?? []),
    );
    const declared = TOKENS
      .filter((t) => t.reach === "knownLiteral" || t.reach === "escape")
      .map((t) => t.literal);
    expect([...escaped].sort()).toEqual(declared.sort());
  });

  it("proves every `escape` is a defect and not a structural impossibility", async () => {
    // The row type lets an author write `escape` with a `shouldUse` naming a constant that
    // does not exist — which would read as "we know about it" while being unfixable, the
    // most comfortable possible state for a defect to sit in. So: for every escape, the
    // constant it should have used must be REACHABLE — its owning names artifact emitted,
    // by this same run, carrying the literal. That turns each row into a claim that can be
    // acted on today, and it is what separates these rows from the knownLiteral ones above.
    const tree = await generate(dialect);
    const names = Object.entries(tree).filter(([p]) => isNamesArtifact(p)).map(([, c]) => c).join("\n");
    const unreachable = TOKENS
      .filter((t) => t.reach === "escape")
      // The composite CHECK names are built FROM two constants rather than being one, so
      // the reachability question for them is about their parts, which have rows of their own.
      .filter((t) => !t.shouldUse.startsWith("`"))
      .filter((t) => !names.includes(t.literal))
      .map((t) => `${t.literal} is marked an escape but ${t.shouldUse} is in no names artifact`);
    expect(unreachable.sort()).toEqual([]);
  });

  it("pins each `dropped` name as carried-but-unread, so wiring it up fails this row", async () => {
    // The counterpart to the reference test, for the failure mode that test cannot state.
    // A `dropped` row asserts BOTH halves of its own claim: the artifact carries the name
    // (so a consumer could read it) and no generated file references the constant (so none
    // does). Asserting the second half is the point — it is a pin on a DEFECT, and the day
    // a generator starts honouring the name this row fails and demands promotion to
    // `constant`, rather than the fix landing with nothing to notice it.
    const tree = await generate(dialect);
    const names = Object.entries(tree).filter(([p]) => isNamesArtifact(p)).map(([, c]) => c).join("\n");
    const body = Object.entries(tree).filter(([p]) => !isNamesArtifact(p)).map(([, c]) => c).join("\n");
    const wrong = TOKENS.filter((t) => t.reach === "dropped").flatMap((t) => [
      ...(names.includes(t.literal) ? [] : [`${t.literal} is marked dropped but no names artifact carries it`]),
      ...(body.includes(t.shouldUse) ? [`${t.shouldUse} IS referenced now — promote "${t.literal}" to reach: "constant"`] : []),
    ]);
    expect(wrong.sort()).toEqual([]);
  });
});
}

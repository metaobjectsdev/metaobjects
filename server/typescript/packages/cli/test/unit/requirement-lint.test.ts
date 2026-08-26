// `meta verify` — the requirement AUTHORING lint.
//
// Every fixture here is declared the way an adopter declares one and LOADED, never
// parsed. That is the point twice over: the lint reads the effective model, so an
// attr arriving through `extends` or an overlay is linted on what the node
// effectively carries — and each "the loader lets this through" claim below is
// proven by the fixture loading, not asserted in a comment.

import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMemory } from "@metaobjectsdev/sdk";
import {
  lintRequirements,
  WARN_REQUIREMENT_NAME_NOT_ADDRESSABLE,
  WARN_REQUIREMENT_NAME_READS_AS_PROSE,
  WARN_REQUIREMENT_NAME_RESTATES_STATEMENT,
  WARN_REQUIREMENT_PROSE_DUPLICATED,
  WARN_REQUIREMENT_PROSE_EMPTY,
  WARN_REQUIREMENT_INERT_DOC_SLOT,
  WARN_REQUIREMENT_TITLE_IS_AN_ID,
} from "../../src/lib/requirement-lint.js";
import { collectAddressedRequirements, type Diagnostic } from "../../src/lib/requirement-check.js";
import { walkRequirements, requirementRows } from "@metaobjectsdev/codegen-ts";

const MODEL = `
metadata:
  package: acme::shop
  children:
    - object.entity:
        name: Order
        children:
          - source.rdb: { table: orders }
          - field.uuid: { name: id }
          - identity.primary: { name: pk, fields: [id] }
`;

interface Run { diags: Diagnostic[]; loadError?: string }

async function lint(capsYaml?: string): Promise<Run> {
  const dir = mkdtempSync(join(tmpdir(), "req-lint-"));
  try {
    mkdirSync(join(dir, "metaobjects"));
    writeFileSync(join(dir, "metaobjects/meta.shop.yaml"), MODEL);
    if (capsYaml !== undefined) writeFileSync(join(dir, "metaobjects/meta.caps.yaml"), capsYaml);
    let root;
    try {
      root = await loadMemory(dir, { strict: true });
    } catch (err) {
      return { diags: [], loadError: (err as Error).message };
    }
    return { diags: lintRequirements(root) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const STATEMENT = '"Every placed order is recorded before payment is taken"';
const COUNTEREXAMPLE = '"A payment against an order that was never stored"';
const CLAIMS_ORDER = '["acme::shop::Order"]';

/** One `requirement.functional:` list item under `children:`. */
function reqBlock(slots: Record<string, string>): string {
  const body = Object.entries(slots).map(([k, v]) => `        ${k}: ${v}`).join("\n");
  return `    - requirement.functional:\n${body}`;
}

/** A caps document wrapping the given root-level requirement blocks. */
function doc(...blocks: string[]): string {
  return `\nmetadata:\n  package: acme::caps\n  children:\n${blocks.join("\n")}\n`;
}

/** One L4 requirement with every slot spelled correctly, plus whatever `extra`
 *  overrides. The baseline is clean, so any finding a test sees came from its own
 *  edit rather than from the scaffold. */
function one(extra: Record<string, string> = {}): string {
  return doc(reqBlock({
    name: "OrderRecording",
    level: "4",
    status: "live",
    statement: STATEMENT,
    counterexample: COUNTEREXAMPLE,
    implementedBy: CLAIMS_ORDER,
    ...extra,
  }));
}

/** An ABSTRACT requirement carrying `abstractSlots`, plus the concrete children that
 *  extend it — the shared-shape idiom, which is where own-vs-resolving reads diverge.
 *  Each test overrides only the slot it is about, so the difference is the only thing
 *  visible at the call site. */
function shared(
  abstractSlots: Record<string, string> = {},
  children: Record<string, string>[] = [{ name: "ChildA" }, { name: "ChildB" }],
): string {
  return doc(
    reqBlock({
      name: "SharedShape",
      abstract: "true",
      level: "4",
      status: "live",
      statement: STATEMENT,
      counterexample: COUNTEREXAMPLE,
      ...abstractSlots,
    }),
    ...children.map((c) => reqBlock({ extends: "SharedShape", implementedBy: CLAIMS_ORDER, ...c })),
  );
}

const codes = (d: Diagnostic[]): string[] => d.map((x) => x.code);

describe("the baseline is clean", () => {
  test("a correctly authored requirement produces no findings", async () => {
    const { diags, loadError } = await lint(one());
    expect(loadError).toBeUndefined();
    expect(diags).toEqual([]);
  });

  test("a model declaring no requirements is not linted at all", async () => {
    const { diags, loadError } = await lint();
    expect(loadError).toBeUndefined();
    expect(diags).toEqual([]);
  });

  test("every finding is a warning — the lint never fails a build", async () => {
    const { diags } = await lint(one({
      name: '"Users can log in with their email address."',
      summary: '"Orders get recorded."',
      description: '"Every placed order is recorded before payment is taken"',
    }));
    expect(diags.length).toBeGreaterThan(0);
    // The invariant, not a constant: there is no severity knob to flip, because
    // `verify` prints this section with log.warn unconditionally and takes its exit
    // code from the gate alone. A check that must fail a build belongs in the gate.
    expect(diags.every((d) => d.severity === "warn")).toBe(true);
  });
});

describe("the name is an address, not prose", () => {
  test("a '.' in the name loads, and is reported because it collides with nesting", async () => {
    // The proof this matters: the single node below and a node `Orders` containing a
    // node `Recorded` produce the IDENTICAL dotted path, so the address stops
    // identifying one node — and both derive the same generated stub filename.
    const { diags, loadError } = await lint(one({ name: '"Orders.Recorded"' }));
    expect(loadError).toBeUndefined();
    expect(codes(diags)).toContain(WARN_REQUIREMENT_NAME_NOT_ADDRESSABLE);
    const d = diags.find((x) => x.code === WARN_REQUIREMENT_NAME_NOT_ADDRESSABLE);
    expect(d?.message).toContain("dotted-path separator");
  });

  test("a nested requirement with a dotted name reports the path, so the collision is visible", async () => {
    const { diags } = await lint(`
metadata:
  package: acme::caps
  children:
    - requirement.functional:
        name: Orders
        level: 3
        status: live
        statement: "Orders are handled end to end"
        counterexample: "An order that stalls with no owner"
        children:
          - requirement.functional:
              name: "Placed.Recorded"
              level: 4
              status: live
              statement: "Every placed order is recorded before payment is taken"
              counterexample: "A payment against an order that was never stored"
              implementedBy: ["acme::shop::Order"]
`);
    const d = diags.find((x) => x.code === WARN_REQUIREMENT_NAME_NOT_ADDRESSABLE);
    expect(d?.path).toBe("Orders.Placed.Recorded");
  });

  test("path separators in the name are reported — the stub would be written outside its directory", async () => {
    const { diags, loadError } = await lint(one({ name: '"../../escaped"' }));
    expect(loadError).toBeUndefined();
    expect(codes(diags)).toContain(WARN_REQUIREMENT_NAME_NOT_ADDRESSABLE);
  });

  test("characters illegal in a filename are reported", async () => {
    const { diags, loadError } = await lint(one({ name: '"Can a user log in? yes: always"' }));
    expect(loadError).toBeUndefined();
    const d = diags.find((x) => x.code === WARN_REQUIREMENT_NAME_NOT_ADDRESSABLE);
    expect(d?.message).toContain("'?'");
    expect(d?.message).toContain("':'");
  });

  test("leading or trailing whitespace is reported — it is silently part of the path", async () => {
    const { diags } = await lint(one({ name: '"  OrderRecording  "' }));
    expect(codes(diags)).toContain(WARN_REQUIREMENT_NAME_NOT_ADDRESSABLE);
  });

  test("a name with SEVERAL problems is ONE finding naming all of them", async () => {
    // These were separate if/else branches, so a padded AND dotted name reported
    // only the dot — the author fixed it, re-ran, and learned about the padding on
    // a second pass. One name is one edit, so it is one finding.
    const { diags } = await lint(one({ name: '" Orders.Recorded "' }));
    const found = diags.filter((d) => d.code === WARN_REQUIREMENT_NAME_NOT_ADDRESSABLE);
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toContain("'.' (the dotted-path separator)");
    expect(found[0]?.message).toContain("leading or trailing whitespace");
  });

  test("a sentence-shaped name is reported as prose", async () => {
    const { diags } = await lint(one({ name: '"Users can log in with their email"' }));
    expect(codes(diags)).toContain(WARN_REQUIREMENT_NAME_READS_AS_PROSE);
  });

  test("a short multi-word label is NOT reported — the threshold under-fires on purpose", async () => {
    // Renaming a requirement changes its address AND its emitted stub filename, so a
    // false positive here asks for a migration that buys nothing.
    for (const name of ['"Order Recording"', '"Tenant scoping"', '"Order recording for placed orders"']) {
      const { diags } = await lint(one({ name }));
      expect(codes(diags)).not.toContain(WARN_REQUIREMENT_NAME_READS_AS_PROSE);
      expect(codes(diags)).not.toContain(WARN_REQUIREMENT_NAME_NOT_ADDRESSABLE);
    }
  });

  test("a name that restates the statement is reported as duplication, not as prose", async () => {
    // Exclusive on purpose: "rename it" is the wrong instruction when the name IS the
    // claim. The instruction is that the claim already has a slot which is read.
    const { diags } = await lint(one({
      name: '"Every placed order is recorded before payment is taken."',
    }));
    expect(codes(diags)).toContain(WARN_REQUIREMENT_NAME_RESTATES_STATEMENT);
    expect(codes(diags)).not.toContain(WARN_REQUIREMENT_NAME_READS_AS_PROSE);
  });

  test("a camelCase name condensed from the statement is reported too", async () => {
    const { diags } = await lint(one({
      name: "OrderRecording",
      statement: '"Order recording"',
    }));
    expect(codes(diags)).toContain(WARN_REQUIREMENT_NAME_RESTATES_STATEMENT);
  });
});

describe("required prose that is present but says nothing", () => {
  test("an empty @statement loads — the loader requires presence, not content", async () => {
    const { diags, loadError } = await lint(one({ statement: '""' }));
    expect(loadError).toBeUndefined();
    expect(codes(diags)).toContain(WARN_REQUIREMENT_PROSE_EMPTY);
    expect(diags.find((d) => d.code === WARN_REQUIREMENT_PROSE_EMPTY)?.message).toContain("@statement");
  });

  test("an empty @counterexample is reported", async () => {
    const { diags } = await lint(one({ counterexample: '"   "' }));
    const found = diags.filter((d) => d.code === WARN_REQUIREMENT_PROSE_EMPTY);
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toContain("@counterexample");
  });

  test("an empty statement does not also trip the duplication checks", async () => {
    // Two blank slots are not "the same sentence twice" — reporting them as
    // duplication would bury the finding that actually says what to fix.
    const { diags } = await lint(one({ statement: '""', counterexample: '""' }));
    expect(codes(diags)).not.toContain(WARN_REQUIREMENT_PROSE_DUPLICATED);
    expect(codes(diags)).not.toContain(WARN_REQUIREMENT_NAME_RESTATES_STATEMENT);
  });
});

describe("two slots holding one sentence", () => {
  test("a description repeating the statement verbatim is reported", async () => {
    const { diags } = await lint(one({
      description: '"Every placed order is recorded, before payment is taken!"',
    }));
    expect(codes(diags)).toContain(WARN_REQUIREMENT_PROSE_DUPLICATED);
  });

  test("a description that OPENS with the statement and then continues is reported", async () => {
    const { diags } = await lint(one({
      description:
        '"Every placed order is recorded before payment is taken. Refunds are out of scope — ' +
        'OrderRefund owns those."',
    }));
    const d = diags.find((x) => x.code === WARN_REQUIREMENT_PROSE_DUPLICATED);
    expect(d?.message).toContain("Drop the first sentence");
  });

  test("a repeated opening sentence is found even when the description WRAPS", async () => {
    // Authored as a YAML literal block, which is how a multi-sentence description is
    // actually written — so the repeated sentence wraps. `.` in a JS regex does not
    // cross a newline, which made this arm miss exactly that style. Built inline
    // rather than through `one()` because the wrap has to be a REAL newline in the
    // loaded value, not an escape the test template swallows.
    const { diags, loadError } = await lint(`
metadata:
  package: acme::caps
  children:
    - requirement.functional:
        name: OrderRecording
        level: 4
        status: live
        statement: "Every placed order is recorded before payment is taken"
        counterexample: "A payment against an order that was never stored"
        description: |
          Every placed order is recorded
          before payment is taken. Refunds are out of scope.
        implementedBy: ["acme::shop::Order"]
`);
    expect(loadError).toBeUndefined();
    const d = diags.find((x) => x.code === WARN_REQUIREMENT_PROSE_DUPLICATED);
    expect(d?.message).toContain("Drop the first sentence");
  });

  test("a description that states genuine scope is left alone", async () => {
    const { diags } = await lint(one({
      description:
        '"Covers orders placed through the storefront. Orders raised by support staff are out of ' +
        'scope and belong to the back-office entry."',
    }));
    expect(codes(diags)).not.toContain(WARN_REQUIREMENT_PROSE_DUPLICATED);
  });

  test("a counterexample repeating the statement is reported — it makes the claim uncheckable", async () => {
    const { diags } = await lint(one({
      counterexample: '"Every placed order is recorded before payment is taken"',
    }));
    const d = diags.find((x) => x.code === WARN_REQUIREMENT_PROSE_DUPLICATED);
    expect(d?.message).toContain("@counterexample");
  });

  test("paraphrase is NOT reported — only exact repeats, so no finding is arguable", async () => {
    const { diags } = await lint(one({
      description: '"Orders get written down before we charge anyone"',
    }));
    expect(codes(diags)).not.toContain(WARN_REQUIREMENT_PROSE_DUPLICATED);
  });
});

describe("content written where nothing reads it", () => {
  test("a well-formed title is NOT reported — it is chartered as the entry's label", async () => {
    // An earlier version of this lint flagged every `title`. Measured against three real
    // ledgers that would have told two adopters to delete 355 authored labels, 123 of
    // which carry words the name does not — and `spec/capability-ledger.md`'s requirement
    // attribute table charters the slot on a requirement by name.
    const { diags, loadError } = await lint(one({ title: '"Order recording"' }));
    expect(loadError).toBeUndefined();
    expect(diags).toEqual([]);
  });

  test("a title that OPENS with a catalogue id is reported, and told to SPLIT", async () => {
    const { diags } = await lint(one({ title: '"FR-467 — Order recording"' }));
    const d = diags.find((x) => x.code === WARN_REQUIREMENT_TITLE_IS_AN_ID);
    expect(d?.message).toContain("FR-467");
    expect(d?.message).toContain("trackedBy");
    // SPLIT, not move: the real values carry an id AND a noun phrase, so relocating the
    // whole string to @trackedBy throws the label away.
    expect(d?.message).toContain("SPLIT");
    // It is not ALSO reported as inert — the slot is fine, its contents are overloaded.
    expect(codes(diags)).not.toContain(WARN_REQUIREMENT_INERT_DOC_SLOT);
  });

  test("an id-shaped title is recognised in the shapes real ledgers use", async () => {
    for (const t of ['"FR-448 — prompt construction"', '"PLAT-77 money declares currency"', '"ABC123 thing"']) {
      expect(codes((await lint(one({ title: t }))).diags)).toContain(WARN_REQUIREMENT_TITLE_IS_AN_ID);
    }
    // A phrase that merely CONTAINS digits or capitals is not an id.
    for (const t of ['"Money is exact minor units"', '"L4 object grain"', '"Double-entry money movement"']) {
      expect(codes((await lint(one({ title: t }))).diags)).not.toContain(WARN_REQUIREMENT_TITLE_IS_AN_ID);
    }
  });

  test("a summary IS reported — @statement is required, so a summary can only repeat it", async () => {
    const { diags } = await lint(one({ summary: '"Orders get recorded."' }));
    const found = diags.filter((d) => d.code === WARN_REQUIREMENT_INERT_DOC_SLOT);
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toContain("@summary");
  });

  test("notes is NEVER reported — being unrendered is what notes is FOR", async () => {
    const { diags } = await lint(one({
      notes: '"Proven by the ERR_REQUIREMENT_DANGLING_REF fixture; the 0.24.0 cut removed the retired statuses."',
    }));
    expect(codes(diags)).not.toContain(WARN_REQUIREMENT_INERT_DOC_SLOT);
    expect(diags).toEqual([]);
  });
});

describe("a declaration is reported once, at the node that declares it", () => {
  test("an inert slot on an abstract is reported ONCE, not once per inheriting child", async () => {
    // A resolving read reported it three times, two of them addressed at nodes where
    // the author finds no `summary` to delete. On a ledger using the shared-abstract
    // idiom one mistake could fill the whole 20-line lint cap with unactionable lines.
    const { diags, loadError } = await lint(shared({ summary: '"Orders get recorded."' }));
    expect(loadError).toBeUndefined();
    const found = diags.filter((d) => d.code === WARN_REQUIREMENT_INERT_DOC_SLOT);
    expect(found).toHaveLength(1);
    expect(found[0]?.path).toBe("SharedShape");
  });

  test("an empty statement on an abstract is reported ONCE, at the abstract", async () => {
    const { diags } = await lint(shared({ statement: '""' }));
    const found = diags.filter((d) => d.code === WARN_REQUIREMENT_PROSE_EMPTY);
    expect(found).toHaveLength(1);
    expect(found[0]?.path).toBe("SharedShape");
  });

  test("a child that declares its OWN inert slot is still reported at the child", async () => {
    const { diags } = await lint(
      shared({}, [{ name: "ChildA", summary: '"Orders get recorded."' }]),
    );
    const found = diags.filter((d) => d.code === WARN_REQUIREMENT_INERT_DOC_SLOT);
    expect(found).toHaveLength(1);
    expect(found[0]?.path).toBe("ChildA");
  });
});

describe("the address the lint reports is the one the stub is named for", () => {
  test("the shared collection's paths equal walkRequirements()'s, node for node", async () => {
    // The lint's messages tell an author their name is "the filename of its generated
    // test stub". That stub name comes from `walkRequirements()` in codegen-ts, which
    // is a DIFFERENT traversal — it descends only through requirement nodes, while the
    // gate's collection descends through everything so a requirement somewhere
    // unexpected is still gated. The two agree for every model the loader accepts, and
    // this asserts it rather than leaving the claim to inspection.
    const dir = mkdtempSync(join(tmpdir(), "req-paths-"));
    try {
      mkdirSync(join(dir, "metaobjects"));
      writeFileSync(join(dir, "metaobjects/meta.shop.yaml"), MODEL);
      writeFileSync(join(dir, "metaobjects/meta.caps.yaml"), `
metadata:
  package: acme::caps
  children:
    - requirement.functional:
        name: Solution
        level: 1
        status: live
        statement: "The commerce solution"
        counterexample: "Nothing can be sold"
        children:
          - requirement.functional:
              name: Ordering
              level: 3
              status: live
              statement: "Orders are handled end to end"
              counterexample: "An order that stalls with no owner"
              children:
                - requirement.functional:
                    name: OrderRecording
                    level: 4
                    status: live
                    statement: "Every placed order is recorded before payment is taken"
                    counterexample: "A payment against an order that was never stored"
                    implementedBy: ["acme::shop::Order"]
    - requirement.architectural:
        name: UuidPrimaryKeys
        status: live
        statement: "Every entity is keyed by a uuid"
        counterexample: "An entity with a composite string key"
        implementedBy: ["acme::shop::Order"]
`);
      const root = await loadMemory(dir, { strict: true });
      const gatePaths = collectAddressedRequirements(root).map((r) => r.path);
      const stubPaths = walkRequirements(root).map((w) => w.view.path);
      expect(gatePaths.length).toBeGreaterThan(0);
      expect([...gatePaths].sort()).toEqual([...stubPaths].sort());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the inert-slot claim is checked, not assumed", () => {
  test("the doc surface projects neither summary nor notes — and title is a KNOWN gap", async () => {
    // WARN_REQUIREMENT_INERT_DOC_SLOT tells an author their `summary` is invisible; this
    // pins that claim against the projection every requirement doc surface renders from.
    //
    // `title` is asserted absent too, but as a KNOWN GAP rather than a guarantee: the
    // requirement attribute table in spec/capability-ledger.md charters it, and the
    // renderer does not honour it yet. When that is fixed this assertion is the one that
    // should fail and be deleted — which is the point of writing it down here.
    const dir = mkdtempSync(join(tmpdir(), "req-rows-"));
    try {
      mkdirSync(join(dir, "metaobjects"));
      writeFileSync(join(dir, "metaobjects/meta.shop.yaml"), MODEL);
      writeFileSync(join(dir, "metaobjects/meta.caps.yaml"), one({
        title: '"FR-467 — Order recording"',
        summary: '"Orders get recorded."',
        notes: '"Proven by the ERR_REQUIREMENT_DANGLING_REF fixture."',
      }));
      const rows = requirementRows(await loadMemory(dir, { strict: true }));
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        const keys = Object.keys(row);
        expect(keys).not.toContain("summary");
        // KNOWN GAP, not a guarantee — see above.
        expect(keys).not.toContain("title");
        // `notes` is on the same list for the OPPOSITE reason — chartered
        // internal-only, so its absence here is the documentation provider working.
        expect(keys).not.toContain("notes");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the lint reads the effective model", () => {
  test("prose inherited through extends is linted on the child that effectively carries it", async () => {
    // ADR-0039: `attr()` RESOLVES. Reading own-only here would silently pass a child
    // whose inherited description repeats its inherited statement.
    const { diags, loadError } = await lint(
      shared({ description: STATEMENT }, [{ name: "OrderRecording" }]),
    );
    expect(loadError).toBeUndefined();
    const onChild = diags.filter((d) => d.path === "OrderRecording");
    expect(codes(onChild)).toContain(WARN_REQUIREMENT_PROSE_DUPLICATED);
  });
});

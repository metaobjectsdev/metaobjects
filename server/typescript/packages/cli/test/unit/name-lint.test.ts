// `meta verify` — the node-name AUTHORING lint.
//
// The loader accepts any string as a node `name`, and whitespace in one loads clean
// on every port: an adopter's metadata carried a field named `"defaultCurrencyId "`
// (trailing space, copied from legacy XML) and nothing said a word. Refusing it at
// load would break metadata that works today (`meta migrate` quotes the column and
// the ObjectManager round-trips the key), so this is an ADVISORY finding, never a
// build failure — the requirement lint's discipline, applied to every named node.
//
// Every fixture is LOADED, never parsed, so "the loader lets this through" is proven
// by the fixture loading rather than asserted in a comment.

import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMemory } from "@metaobjectsdev/sdk";
import {
  lintNodeNames,
  WARN_NAME_SURROUNDING_WHITESPACE,
  WARN_NAME_INTERNAL_WHITESPACE,
} from "../../src/lib/name-lint.js";
import {
  lintRequirements,
  WARN_REQUIREMENT_NAME_NOT_ADDRESSABLE,
  WARN_REQUIREMENT_NAME_READS_AS_PROSE,
} from "../../src/lib/requirement-lint.js";
import type { Diagnostic } from "../../src/lib/requirement-check.js";

interface Run { names: Diagnostic[]; requirements: Diagnostic[] }

/** Load one JSON metadata document (strict) and run both name-bearing lints. */
async function lint(children: unknown[]): Promise<Run> {
  const dir = mkdtempSync(join(tmpdir(), "name-lint-"));
  try {
    mkdirSync(join(dir, "metaobjects"));
    writeFileSync(
      join(dir, "metaobjects/meta.app.json"),
      JSON.stringify({ "metadata.root": { package: "acme::app", children } }),
    );
    const root = await loadMemory(dir, { strict: true });
    return { names: lintNodeNames(root), requirements: lintRequirements(root) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** An entity with an id + pk and whatever extra fields the test adds. */
function entity(name: string, ...extra: unknown[]): unknown {
  return {
    "object.entity": {
      name,
      children: [
        { "source.rdb": { "@table": "accounts" } },
        { "field.long": { name: "id" } },
        ...extra,
        { "identity.primary": { name: "pk", "@fields": ["id"] } },
      ],
    },
  };
}

const codes = (ds: Diagnostic[]): string[] => ds.map((d) => d.code);

describe("node-name lint — whitespace in a name", () => {
  test("a clean model produces nothing", async () => {
    const { names } = await lint([entity("Account", { "field.long": { name: "defaultCurrencyId" } })]);
    expect(names).toEqual([]);
  });

  test("a field with a TRAILING space gets the strong finding, naming the fix", async () => {
    const { names } = await lint([entity("Account", { "field.long": { name: "defaultCurrencyId " } })]);
    expect(names).toHaveLength(1);
    const d = names[0]!;
    expect(d.severity).toBe("warn");
    expect(d.code).toBe(WARN_NAME_SURROUNDING_WHITESPACE);
    expect(d.path).toBe('acme::app::Account."defaultCurrencyId "');
    expect(d.message).toContain('field.long name "defaultCurrencyId "');
    expect(d.message).toContain("almost certainly unintended — rename it");
    expect(d.message).toContain('"defaultCurrencyId"');
    expect(d.message).toContain("pin @column if the physical column must keep its name");
  });

  test("an object with a LEADING space gets the strong finding", async () => {
    const { names } = await lint([entity(" Account")]);
    expect(codes(names)).toEqual([WARN_NAME_SURROUNDING_WHITESPACE]);
    expect(names[0]!.message).toContain('object.entity name " Account"');
    expect(names[0]!.message).toContain("almost certainly unintended — rename it");
    // @column is a FIELD attr; telling an object author to pin it would be wrong.
    expect(names[0]!.message).not.toContain("@column");
  });

  test("an INTERNAL space on a field is a plain advisory", async () => {
    const { names } = await lint([entity("Account", { "field.string": { name: "unit label" } })]);
    expect(codes(names)).toEqual([WARN_NAME_INTERNAL_WHITESPACE]);
    expect(names[0]!.message).toContain('field.string name "unit label" contains whitespace');
    expect(names[0]!.message).not.toContain("almost certainly unintended");
  });

  test("an identity carried over from legacy XML is reported too — every named node, not only fields", async () => {
    const { names } = await lint([entity("Account",
      { "field.long": { name: "currencyId" } },
      { "identity.reference": { name: "account_currencyId _fk", "@fields": ["currencyId"], "@references": "Account" } },
    )]);
    expect(codes(names)).toEqual([WARN_NAME_INTERNAL_WHITESPACE]);
    expect(names[0]!.message).toContain('identity.reference name "account_currencyId _fk"');
  });

  test("a name both padded AND split is ONE finding — one name is one edit", async () => {
    const { names } = await lint([entity("Account", { "field.string": { name: " unit label " } })]);
    expect(codes(names)).toEqual([WARN_NAME_SURROUNDING_WHITESPACE]);
    expect(names[0]!.message).toContain("also contains whitespace inside it");
  });

  test("non-ASCII whitespace (a no-break space from pasted text) counts", async () => {
    const { names } = await lint([entity("Account", { "field.long": { name: "currencyId " } })]);
    expect(codes(names)).toEqual([WARN_NAME_SURROUNDING_WHITESPACE]);
  });

  test("an inherited field is reported ONCE, at its declaration — not on every subtype", async () => {
    const { names } = await lint([
      { "object.entity": { name: "Base", abstract: true, children: [{ "field.long": { name: "tenantId " } }] } },
      { "object.entity": { name: "A", extends: "Base", children: [
        { "source.rdb": { "@table": "a" } }, { "field.long": { name: "id" } },
        { "identity.primary": { name: "pk", "@fields": ["id"] } }] } },
      { "object.entity": { name: "B", extends: "Base", children: [
        { "source.rdb": { "@table": "b" } }, { "field.long": { name: "id" } },
        { "identity.primary": { name: "pk", "@fields": ["id"] } }] } },
    ]);
    expect(names).toHaveLength(1);
    expect(names[0]!.path).toBe('acme::app::Base."tenantId "');
  });
});

describe("node-name lint — requirements keep their own lint", () => {
  const req = (name: string): unknown => ({
    "requirement.functional": {
      name,
      "@level": 4,
      "@status": "live",
      "@statement": "Every placed order is recorded before payment is taken",
      "@counterexample": "A payment against an order that was never stored",
      "@implementedBy": ["acme::app::Account"],
    },
  });

  test("a multi-word requirement label stays unreported by BOTH lints", async () => {
    const { names, requirements } = await lint([entity("Account"), req("Order Recording")]);
    expect(names).toEqual([]);
    expect(codes(requirements)).not.toContain(WARN_REQUIREMENT_NAME_NOT_ADDRESSABLE);
    expect(codes(requirements)).not.toContain(WARN_REQUIREMENT_NAME_READS_AS_PROSE);
  });

  test("a padded requirement name is reported — once, by the requirement lint that owns its address", async () => {
    const { names, requirements } = await lint([entity("Account"), req("OrderRecording ")]);
    expect(names).toEqual([]);
    expect(codes(requirements)).toContain(WARN_REQUIREMENT_NAME_NOT_ADDRESSABLE);
  });
});

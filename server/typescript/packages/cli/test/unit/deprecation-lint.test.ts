// `meta verify` — the deprecated-REFERENCE authoring lint (#305).
//
// `deprecated`/`replacedBy` are registered documentation common-attrs in every
// port and nothing read them before this: no validation pass, no `verify` check,
// no codegen behavior. This lint warns when a node DEPENDS on a `deprecated` node
// through a reference the metamodel already resolves: `extends`, `@objectRef`,
// `@references`, or an origin's `@from`/`@of`/`@via`. Advisory only — see
// deprecation-lint.ts's header for the full rationale and what is deliberately
// out of scope (a deprecation date, per-finding suppressions).
//
// Every fixture is LOADED (never hand-built MetaData), so "the loader accepts
// this shape" is proven by the fixture loading rather than asserted in a comment.

import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMemory } from "@metaobjectsdev/sdk";
import { lintDeprecatedReferences, WARN_DEPRECATED_REFERENCE } from "../../src/lib/deprecation-lint.js";
import type { Diagnostic } from "../../src/lib/requirement-check.js";

/** Load one JSON metadata document (strict) and run the lint. */
async function lint(children: unknown[]): Promise<Diagnostic[]> {
  const dir = mkdtempSync(join(tmpdir(), "deprecation-lint-"));
  try {
    mkdirSync(join(dir, "metaobjects"));
    writeFileSync(
      join(dir, "metaobjects/meta.app.json"),
      JSON.stringify({ "metadata.root": { package: "acme", children } }),
    );
    const root = await loadMemory(dir, { strict: true });
    return lintDeprecatedReferences(root);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const codes = (ds: Diagnostic[]): string[] => ds.map((d) => d.code);

describe("deprecated-reference lint — no deprecated attrs anywhere", () => {
  test("a clean model (extends, @objectRef, @references, all pointing at non-deprecated nodes) produces nothing", async () => {
    const findings = await lint([
      { "object.entity": { name: "Base", abstract: true, children: [{ "field.long": { name: "id" } }] } },
      {
        "object.entity": {
          name: "Team",
          children: [
            { "source.rdb": { "@table": "teams" } },
            { "field.long": { name: "id" } },
            { "identity.primary": { name: "pk", "@fields": ["id"] } },
          ],
        },
      },
      {
        "object.entity": {
          name: "Match",
          extends: "Base",
          children: [
            { "source.rdb": { "@table": "matches" } },
            { "field.long": { name: "homeTeamId" } },
            { "relationship.association": { name: "homeTeam", "@objectRef": "Team", "@cardinality": "one" } },
            {
              "identity.reference": {
                name: "homeTeamRef",
                "@fields": ["homeTeamId"],
                "@references": "Team",
              },
            },
            { "identity.primary": { name: "pk", "@fields": ["id"] } },
          ],
        },
      },
    ]);
    expect(findings).toEqual([]);
  });
});

describe("deprecated-reference lint — extends", () => {
  test("a concrete object extending a deprecated abstract base warns, naming the base and the reason", async () => {
    const findings = await lint([
      {
        "object.entity": {
          name: "Base",
          abstract: true,
          "@deprecated": "no longer maintained",
          children: [{ "field.long": { name: "id" } }],
        },
      },
      {
        "object.entity": {
          name: "Concrete",
          extends: "Base",
          children: [
            { "source.rdb": { "@table": "concretes" } },
            { "identity.primary": { name: "pk", "@fields": ["id"] } },
          ],
        },
      },
    ]);
    expect(codes(findings)).toEqual([WARN_DEPRECATED_REFERENCE]);
    const d = findings[0]!;
    expect(d.path).toBe("acme::Concrete");
    expect(d.message).toContain("extends deprecated object.entity acme::Base");
    expect(d.message).toContain("no longer maintained");
    expect(d.message).not.toContain("Replaced by");
  });

  test("replacedBy present names the replacement", async () => {
    const findings = await lint([
      {
        "object.entity": {
          name: "Base",
          abstract: true,
          "@deprecated": "no longer maintained",
          "@replacedBy": "acme::NewBase",
          children: [{ "field.long": { name: "id" } }],
        },
      },
      {
        "object.entity": {
          name: "Concrete",
          extends: "Base",
          children: [
            { "source.rdb": { "@table": "concretes" } },
            { "identity.primary": { name: "pk", "@fields": ["id"] } },
          ],
        },
      },
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toContain("Replaced by acme::NewBase.");
  });
});

describe("deprecated-reference lint — @objectRef", () => {
  test("a relationship targeting a deprecated entity warns", async () => {
    const findings = await lint([
      {
        "object.entity": {
          name: "Team",
          "@deprecated": "teams feature removed",
          children: [
            { "source.rdb": { "@table": "teams" } },
            { "field.long": { name: "id" } },
            { "identity.primary": { name: "pk", "@fields": ["id"] } },
          ],
        },
      },
      {
        "object.entity": {
          name: "Match",
          children: [
            { "source.rdb": { "@table": "matches" } },
            { "field.long": { name: "id" } },
            { "field.long": { name: "homeTeamId" } },
            { "relationship.association": { name: "homeTeam", "@objectRef": "Team", "@cardinality": "one" } },
            {
              "identity.reference": {
                name: "homeTeamRef",
                "@fields": ["homeTeamId"],
                "@references": "Team",
              },
            },
            { "identity.primary": { name: "pk", "@fields": ["id"] } },
          ],
        },
      },
    ]);
    const relFinding = findings.find((d) => d.message.includes("@objectRef"));
    expect(relFinding).toBeDefined();
    expect(relFinding!.path).toBe("acme::Match.homeTeam");
    expect(relFinding!.message).toContain("references (@objectRef) deprecated object.entity acme::Team");
    expect(relFinding!.message).toContain("teams feature removed");
  });
});

describe("deprecated-reference lint — @references", () => {
  test("an identity.reference targeting a deprecated entity warns", async () => {
    const findings = await lint([
      {
        "object.entity": {
          name: "Team",
          "@deprecated": "teams feature removed",
          children: [
            { "source.rdb": { "@table": "teams" } },
            { "field.long": { name: "id" } },
            { "identity.primary": { name: "pk", "@fields": ["id"] } },
          ],
        },
      },
      {
        "object.entity": {
          name: "Match",
          children: [
            { "source.rdb": { "@table": "matches" } },
            { "field.long": { name: "id" } },
            { "field.long": { name: "homeTeamId" } },
            {
              "identity.reference": {
                name: "homeTeamRef",
                "@fields": ["homeTeamId"],
                "@references": "Team",
              },
            },
            { "identity.primary": { name: "pk", "@fields": ["id"] } },
          ],
        },
      },
    ]);
    const refFinding = findings.find((d) => d.message.includes("@references"));
    expect(refFinding).toBeDefined();
    expect(refFinding!.path).toBe("acme::Match.homeTeamRef");
    expect(refFinding!.message).toContain("references (@references) deprecated object.entity acme::Team");
  });

  // #305 review: the dotted explicit-field form of `@references` ("Entity.field",
  // same shape fixtures/conformance/relationship-one-two-refs-dotted-references/
  // gates) was resolved down to its entity HEAD only, so a deprecated TARGET
  // FIELD named by the dotted form was invisible to this lint.
  test("an identity.reference with a DOTTED @references targeting a deprecated FIELD warns, naming the field (entity is fine)", async () => {
    const findings = await lint([
      {
        "object.entity": {
          name: "Team",
          children: [
            { "source.rdb": { "@table": "teams" } },
            { "field.long": { name: "id" } },
            { "field.string": { name: "code", "@deprecated": "codes are being retired" } },
            { "identity.primary": { name: "pk", "@fields": ["id"] } },
            { "identity.secondary": { name: "codeIdx", "@fields": ["code"] } },
          ],
        },
      },
      {
        "object.entity": {
          name: "Match",
          children: [
            { "source.rdb": { "@table": "matches" } },
            { "field.long": { name: "id" } },
            { "field.string": { name: "homeTeamCode" } },
            {
              "identity.reference": {
                name: "homeTeamRef",
                "@fields": ["homeTeamCode"],
                "@references": "Team.code",
              },
            },
            { "identity.primary": { name: "pk", "@fields": ["id"] } },
          ],
        },
      },
    ]);
    const refFinding = findings.find((d) => d.message.includes("@references"));
    expect(refFinding).toBeDefined();
    expect(refFinding!.path).toBe("acme::Match.homeTeamRef");
    expect(refFinding!.message).toContain("references (@references) deprecated field.string acme::Team.code");
    expect(refFinding!.message).toContain("codes are being retired");
    // The entity itself is fine — only the field-level finding fires.
    expect(findings.filter((d) => d.message.includes("@references"))).toHaveLength(1);
  });
});

describe("deprecated-reference lint — origin @from (passthrough)", () => {
  function countryAndCustomer(countryDeprecated: string | undefined, nameDeprecated: string | undefined): unknown[] {
    return [
      {
        "object.entity": {
          name: "Country",
          ...(countryDeprecated !== undefined ? { "@deprecated": countryDeprecated } : {}),
          children: [
            { "source.rdb": { "@table": "countries" } },
            { "field.long": { name: "id" } },
            {
              "field.string": {
                name: "name",
                ...(nameDeprecated !== undefined ? { "@deprecated": nameDeprecated } : {}),
              },
            },
            { "identity.primary": { name: "pk", "@fields": ["id"] } },
          ],
        },
      },
      {
        "object.entity": {
          name: "Customer",
          children: [
            { "source.rdb": { "@table": "customers" } },
            { "source.rdb": { "@kind": "view", "@view": "v_customer", "@role": "replica" } },
            { "field.long": { name: "id" } },
            {
              "field.string": {
                name: "countryName",
                children: [{ "origin.passthrough": { "@from": "acme::Country.name" } }],
              },
            },
            { "field.long": { name: "countryId" } },
            { "relationship.association": { name: "country", "@objectRef": "Country", "@cardinality": "one" } },
            {
              "identity.reference": {
                name: "countryRef",
                "@fields": ["countryId"],
                "@references": "Country",
              },
            },
            { "identity.primary": { name: "pk", "@fields": ["id"] } },
          ],
        },
      },
    ];
  }

  test("@from referencing a deprecated FIELD warns, naming the field", async () => {
    // Country (the entity) is NOT deprecated here, so the sibling @objectRef/
    // @references onto it stay silent — only the origin @from, which names the
    // specific deprecated FIELD, fires.
    const findings = await lint(countryAndCustomer(undefined, "renamed to label"));
    expect(codes(findings)).toEqual([WARN_DEPRECATED_REFERENCE]);
    expect(findings[0]!.path).toBe("acme::Customer.countryName");
    expect(findings[0]!.message).toContain("origin.passthrough @from references deprecated field.string acme::Country.name");
    expect(findings[0]!.message).toContain("renamed to label");
  });

  test("@from referencing a field on a deprecated ENTITY warns, naming the entity (field itself is fine)", async () => {
    // Country itself is deprecated, so the relationship's @objectRef and the
    // identity.reference's @references onto it ALSO fire (both real, independent
    // findings) — this test asserts the origin.passthrough one specifically.
    const findings = await lint(countryAndCustomer("country support removed", undefined));
    const originFinding = findings.find((d) => d.message.includes("origin.passthrough"));
    expect(originFinding).toBeDefined();
    expect(originFinding!.path).toBe("acme::Customer.countryName");
    expect(originFinding!.message).toContain("origin.passthrough @from references deprecated object.entity acme::Country");
    expect(originFinding!.message).toContain("country support removed");
    expect(findings.every((d) => d.code === WARN_DEPRECATED_REFERENCE)).toBe(true);
  });
});

describe("deprecated-reference lint — origin @of / @via (aggregate)", () => {
  test("@of referencing a deprecated field warns", async () => {
    const findings = await lint([
      {
        "object.entity": {
          name: "Week",
          children: [
            { "source.rdb": { "@table": "weeks" } },
            { "field.long": { name: "id" } },
            { "field.long": { name: "programId" } },
            { "field.int": { name: "minutes", "@deprecated": "use durationMinutes" } },
            {
              "identity.reference": {
                name: "programRef",
                "@fields": ["programId"],
                "@references": "Program",
              },
            },
            { "identity.primary": { name: "pk", "@fields": ["id"] } },
          ],
        },
      },
      {
        "object.entity": {
          name: "Program",
          children: [
            { "source.rdb": { "@table": "programs" } },
            { "source.rdb": { "@kind": "view", "@view": "v_program", "@role": "replica" } },
            { "field.long": { name: "id" } },
            {
              "field.int": {
                name: "totalMinutes",
                children: [
                  {
                    "origin.aggregate": {
                      "@agg": "sum",
                      "@of": "acme::Week.minutes",
                      "@via": "acme::Program.weeks",
                    },
                  },
                ],
              },
            },
            { "relationship.composition": { name: "weeks", "@objectRef": "Week", "@cardinality": "many" } },
            { "identity.primary": { name: "pk", "@fields": ["id"] } },
          ],
        },
      },
    ]);
    const ofFinding = findings.find((d) => d.message.includes("@of"));
    expect(ofFinding).toBeDefined();
    expect(ofFinding!.path).toBe("acme::Program.totalMinutes");
    expect(ofFinding!.message).toContain("origin.aggregate @of references deprecated field.int acme::Week.minutes");
    expect(ofFinding!.message).toContain("use durationMinutes");
  });

  test("@via referencing a deprecated RELATIONSHIP hop warns (target entity is fine)", async () => {
    const findings = await lint([
      {
        "object.entity": {
          name: "Week",
          children: [
            { "source.rdb": { "@table": "weeks" } },
            { "field.long": { name: "id" } },
            { "field.long": { name: "programId" } },
            { "field.int": { name: "minutes" } },
            {
              "identity.reference": {
                name: "programRef",
                "@fields": ["programId"],
                "@references": "Program",
              },
            },
            { "identity.primary": { name: "pk", "@fields": ["id"] } },
          ],
        },
      },
      {
        "object.entity": {
          name: "Program",
          children: [
            { "source.rdb": { "@table": "programs" } },
            { "source.rdb": { "@kind": "view", "@view": "v_program", "@role": "replica" } },
            { "field.long": { name: "id" } },
            {
              "field.int": {
                name: "totalMinutes",
                children: [
                  {
                    "origin.aggregate": {
                      "@agg": "sum",
                      "@of": "acme::Week.minutes",
                      "@via": "acme::Program.weeks",
                    },
                  },
                ],
              },
            },
            {
              "relationship.composition": {
                name: "weeks",
                "@objectRef": "Week",
                "@cardinality": "many",
                "@deprecated": "replaced by the weeklySchedule relationship",
              },
            },
            { "identity.primary": { name: "pk", "@fields": ["id"] } },
          ],
        },
      },
    ]);
    const viaFinding = findings.find((d) => d.message.includes("@via") && d.message.includes("relationship.composition"));
    expect(viaFinding).toBeDefined();
    expect(viaFinding!.path).toBe("acme::Program.totalMinutes");
    expect(viaFinding!.message).toContain("origin.aggregate @via references deprecated relationship.composition acme::Program.weeks");
    expect(viaFinding!.message).toContain("replaced by the weeklySchedule relationship");
  });
});

describe("deprecated-reference lint — inherited deprecated counts (ADR-0039 resolving)", () => {
  test("a target that INHERITS @deprecated from its own abstract base still warns, naming the concrete target", async () => {
    const findings = await lint([
      {
        "object.entity": {
          name: "RetiredBase",
          abstract: true,
          "@deprecated": "the whole family is retired",
          children: [{ "field.long": { name: "id" } }],
        },
      },
      {
        "object.entity": {
          name: "LegacyWidget",
          extends: "RetiredBase",
          children: [
            { "source.rdb": { "@table": "legacy_widgets" } },
            { "identity.primary": { name: "pk", "@fields": ["id"] } },
          ],
        },
      },
      {
        "object.entity": {
          name: "Order",
          children: [
            { "source.rdb": { "@table": "orders" } },
            { "field.long": { name: "id" } },
            { "field.long": { name: "widgetId" } },
            {
              "identity.reference": {
                name: "widgetRef",
                "@fields": ["widgetId"],
                "@references": "LegacyWidget",
              },
            },
            { "identity.primary": { name: "pk", "@fields": ["id"] } },
          ],
        },
      },
    ]);
    // Two findings: LegacyWidget itself extends a deprecated base, AND Order
    // references the (inherited-deprecated) LegacyWidget. Both are real.
    expect(findings.length).toBeGreaterThanOrEqual(2);
    const orderFinding = findings.find((d) => d.path === "acme::Order.widgetRef");
    expect(orderFinding).toBeDefined();
    expect(orderFinding!.message).toContain("deprecated object.entity acme::LegacyWidget");
    expect(orderFinding!.message).toContain("the whole family is retired");
  });
});

describe("deprecated-reference lint — self-reference is not a finding", () => {
  test("a recursive FK on a deprecated entity does not warn about itself", async () => {
    const findings = await lint([
      {
        "object.entity": {
          name: "Category",
          "@deprecated": "flattening the category tree",
          children: [
            { "source.rdb": { "@table": "categories" } },
            { "field.long": { name: "id" } },
            { "field.long": { name: "parentId" } },
            {
              "identity.reference": {
                name: "parentRef",
                "@fields": ["parentId"],
                "@references": "Category",
              },
            },
            { "identity.primary": { name: "pk", "@fields": ["id"] } },
          ],
        },
      },
    ]);
    expect(findings).toEqual([]);
  });

  // #305 review: self-reference is the LITERAL case (same node, or one of the
  // node's own ancestors) — NOT "shares an entity with". A passthrough field
  // reading a DIFFERENT, deprecated SIBLING field on its own entity is a real
  // cross-node dependency and must still warn.
  test("a passthrough field reading a DIFFERENT deprecated sibling field on its OWN entity still warns", async () => {
    const findings = await lint([
      {
        "object.entity": {
          name: "Widget",
          children: [
            { "source.rdb": { "@table": "widgets" } },
            { "source.rdb": { "@kind": "view", "@view": "v_widget", "@role": "replica" } },
            { "field.long": { name: "id" } },
            { "field.string": { name: "legacyName", "@deprecated": "renamed to displayName" } },
            {
              "field.string": {
                name: "displayName",
                children: [{ "origin.passthrough": { "@from": "acme::Widget.legacyName" } }],
              },
            },
            { "identity.primary": { name: "pk", "@fields": ["id"] } },
          ],
        },
      },
    ]);
    expect(codes(findings)).toEqual([WARN_DEPRECATED_REFERENCE]);
    expect(findings[0]!.path).toBe("acme::Widget.displayName");
    expect(findings[0]!.message).toContain("origin.passthrough @from references deprecated field.string acme::Widget.legacyName");
    expect(findings[0]!.message).toContain("renamed to displayName");
  });
});

describe("deprecated-reference lint — presence of @deprecated, not truthiness", () => {
  // #305 review: the registry contract is "Presence ⇒ deprecated" (and
  // codegen-ts's jsdoc.ts reads it via `!== undefined`, not truthiness) — an
  // empty-string reason must still count, just without a reason clause.
  test("an empty-string @deprecated still warns, with no dangling reason clause", async () => {
    const findings = await lint([
      {
        "object.entity": {
          name: "Base",
          abstract: true,
          "@deprecated": "",
          children: [{ "field.long": { name: "id" } }],
        },
      },
      {
        "object.entity": {
          name: "Concrete",
          extends: "Base",
          children: [
            { "source.rdb": { "@table": "concretes" } },
            { "identity.primary": { name: "pk", "@fields": ["id"] } },
          ],
        },
      },
    ]);
    expect(codes(findings)).toEqual([WARN_DEPRECATED_REFERENCE]);
    const d = findings[0]!;
    expect(d.message).toBe("extends deprecated object.entity acme::Base");
    expect(d.message).not.toContain(": "); // no dangling "<address>: " reason-clause separator
    expect(d.message).not.toContain("undefined");
  });
});

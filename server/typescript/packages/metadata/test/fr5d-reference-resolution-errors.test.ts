// FR5d — reference-resolution errors emit format=resolved with referrer + target.
//
// Covers the five reference sites listed in
//   docs/superpowers/specs/2026-05-25-fr5d-reference-resolution-errors.md:
//   1. extends:                  ERR_UNRESOLVED_SUPER
//   2. @payloadRef on template.* ERR_INVALID_TEMPLATE
//   3. @requiredSlots field-on-payload ref  (template.*)
//   4. @via path on origin       ERR_INVALID_ORIGIN
//   5. @of / @from path on origin ERR_INVALID_ORIGIN
//
// Per the FR5d cross-port-safety stance (option b in the prompt), TS emits the
// new format=resolved envelope but the cross-port fixtures stay on the FR5a
// format=json envelope until all four ports ship FR5d. These unit tests assert
// the in-process TS shape directly.

import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource, ParseError } from "../src/index.js";
import type { ErrorCode } from "../src/errors.js";

function expectResolved(
  err: unknown,
  expected: { code: ErrorCode; referrer: string; target: string; files?: string[] },
): void {
  expect(err).toBeInstanceOf(ParseError);
  const pe = err as ParseError;
  expect(pe.code).toBe(expected.code);
  expect(pe.source.format).toBe("resolved");
  if (pe.source.format === "resolved") {
    expect(pe.source.referrer).toBe(expected.referrer);
    expect(pe.source.target).toBe(expected.target);
    if (expected.files !== undefined) {
      expect(pe.source.files).toEqual(expected.files);
    } else {
      // files[] always present on a resolved envelope; the referrer's
      // parse-time source supplies it.
      expect(Array.isArray(pe.source.files)).toBe(true);
    }
  }
}

describe("FR5d — extends: emits format=resolved", () => {
  test("deferred extends resolution (cross-file load): referrer = entity FQN, target = missing super", async () => {
    const res = await new MetaDataLoader().load([
      new InMemoryStringSource(
        JSON.stringify({
          "metadata.root": {
            package: "acme",
            children: [
              {
                "object.entity": {
                  name: "Premium",
                  extends: "DoesNotExist",
                  children: [
                    { "field.long": { name: "id" } },
                    { "identity.primary": { "name": "id", "@fields": "id" } },
                  ],
                },
              },
            ],
          },
        }),
        { id: "meta.bad.json", format: "json" },
      ),
    ]);
    expect(res.errors.length).toBe(1);
    expectResolved(res.errors[0], {
      code: "ERR_UNRESOLVED_SUPER",
      // TS today: objects at the root do not inherit the root's package
      // (only field-in-non-object and qualified-validators inherit), so
      // `obj.fqn()` returns the bare name. Cross-port divergence noted in the
      // FR5d cross-port notes — Java/C# may emit the package-qualified form.
      referrer: "Premium",
      target: "DoesNotExist",
      files: ["meta.bad.json"],
    });
  });
});

describe("FR5d — @payloadRef emits format=resolved", () => {
  test("template @payloadRef unresolved: referrer = template FQN, target = bad payloadRef", async () => {
    const res = await new MetaDataLoader().load([
      new InMemoryStringSource(
        JSON.stringify({
          "metadata.root": {
            package: "acme::ai",
            children: [
              {
                "object.entity": {
                  name: "Npc",
                  children: [
                    { "field.string": { name: "name" } },
                    { "identity.primary": { "name": "id", "@fields": "name" } },
                  ],
                },
              },
              {
                "template.prompt": {
                  name: "npcTurn",
                  "@payloadRef": "NpcPromptPayload",
                  "@textRef": "npc/turn",
                  "@format": "xml",
                },
              },
            ],
          },
        }),
        { id: "meta.ai.json", format: "json" },
      ),
    ]);
    const unresolved = res.errors.find(
      (e): e is ParseError => e instanceof ParseError && e.code === "ERR_INVALID_TEMPLATE",
    );
    expect(unresolved).toBeDefined();
    expectResolved(unresolved, {
      code: "ERR_INVALID_TEMPLATE",
      referrer: "npcTurn",
      target: "NpcPromptPayload",
      files: ["meta.ai.json"],
    });
  });

  test("template @requiredSlots missing field on payload: target = `payloadRef.slot`", async () => {
    const res = await new MetaDataLoader().load([
      new InMemoryStringSource(
        JSON.stringify({
          "metadata.root": {
            package: "acme::ai",
            children: [
              {
                "object.value": {
                  name: "PromptPayload",
                  children: [{ "field.string": { name: "name" } }],
                },
              },
              {
                "template.prompt": {
                  name: "tmpl",
                  "@payloadRef": "PromptPayload",
                  "@textRef": "tmpl/x",
                  "@format": "xml",
                  "@requiredSlots": ["name", "doesNotExist"],
                },
              },
            ],
          },
        }),
        { id: "meta.ai.json", format: "json" },
      ),
    ]);
    const slotErr = res.errors.find(
      (e): e is ParseError =>
        e instanceof ParseError &&
        e.code === "ERR_INVALID_TEMPLATE" &&
        e.message.includes("doesNotExist"),
    );
    expect(slotErr).toBeDefined();
    expectResolved(slotErr, {
      code: "ERR_INVALID_TEMPLATE",
      referrer: "tmpl",
      target: "PromptPayload.doesNotExist",
      files: ["meta.ai.json"],
    });
  });
});

describe("FR5d — @via emits format=resolved", () => {
  test("@via to non-existent relationship: target = full ref, message names deepest-valid-prefix", async () => {
    const res = await new MetaDataLoader().load([
      new InMemoryStringSource(
        JSON.stringify({
          "metadata.root": {
            package: "acme::commerce",
            children: [
              {
                "object.entity": {
                  name: "Program",
                  children: [
                    { "field.long": { name: "id" } },
                    { "field.string": { name: "title" } },
                    { "identity.primary": { "name": "id", "@fields": "id" } },
                  ],
                },
              },
              {
                "object.entity": {
                  name: "ProgramSummary",
                  extends: "Program",
                  children: [
                    { "source.rdb": { "@kind": "view", "@table": "v_program_summary" } },
                    {
                      "field.int": {
                        name: "weekCount",
                        children: [
                          {
                            "origin.aggregate": {
                              "@agg": "count",
                              "@of": "Program.id",
                              "@via": "Program.notARealRelationship",
                            },
                          },
                        ],
                      },
                    },
                    { "identity.primary": { "name": "id", "@fields": "id" } },
                  ],
                },
              },
            ],
          },
        }),
        { id: "meta.commerce.json", format: "json" },
      ),
    ]);
    const viaErr = res.errors.find(
      (e): e is ParseError =>
        e instanceof ParseError &&
        e.code === "ERR_INVALID_ORIGIN" &&
        e.message.includes("notARealRelationship"),
    );
    expect(viaErr).toBeDefined();
    expectResolved(viaErr, {
      code: "ERR_INVALID_ORIGIN",
      referrer: "ProgramSummary::weekCount",
      target: "Program.notARealRelationship",
      files: ["meta.commerce.json"],
    });
    // Deepest-valid-prefix is "Program" (the entity resolved before the relationship hop failed).
    expect((viaErr as ParseError).message).toContain('Deepest valid prefix was "Program"');
  });

  test("multi-hop @via: deepest-valid-prefix names the hop that did resolve", async () => {
    const res = await new MetaDataLoader().load([
      new InMemoryStringSource(
        JSON.stringify({
          "metadata.root": {
            package: "acme::commerce",
            children: [
              {
                "object.entity": {
                  name: "Week",
                  children: [
                    { "field.long": { name: "id" } },
                    { "identity.primary": { "name": "id", "@fields": "id" } },
                  ],
                },
              },
              {
                "object.entity": {
                  name: "Program",
                  children: [
                    { "field.long": { name: "id" } },
                    {
                      "relationship.association": {
                        name: "weeks",
                        "@objectRef": "Week",
                      },
                    },
                    { "identity.primary": { "name": "id", "@fields": "id" } },
                  ],
                },
              },
              {
                "object.entity": {
                  name: "ProgramSummary",
                  extends: "Program",
                  children: [
                    { "source.rdb": { "@kind": "view", "@table": "v" } },
                    {
                      "field.int": {
                        name: "deepCount",
                        children: [
                          {
                            "origin.aggregate": {
                              "@agg": "count",
                              "@of": "Week.id",
                              "@via": "Program.weeks.notReal",
                            },
                          },
                        ],
                      },
                    },
                    { "identity.primary": { "name": "id", "@fields": "id" } },
                  ],
                },
              },
            ],
          },
        }),
        { id: "meta.json", format: "json" },
      ),
    ]);
    const viaErr = res.errors.find(
      (e): e is ParseError =>
        e instanceof ParseError &&
        e.code === "ERR_INVALID_ORIGIN" &&
        e.message.includes("notReal"),
    );
    expect(viaErr).toBeDefined();
    expectResolved(viaErr, {
      code: "ERR_INVALID_ORIGIN",
      referrer: "ProgramSummary::deepCount",
      target: "Program.weeks.notReal",
    });
    // The walk got past Program.weeks (resolved to Week) and failed on `.notReal`.
    expect((viaErr as ParseError).message).toContain('Deepest valid prefix was "Program.weeks"');
  });
});

describe("FR5d — @of / @from emits format=resolved", () => {
  test("aggregate @of to non-existent entity: referrer = projection-FQN::field, target = full ref", async () => {
    const res = await new MetaDataLoader().load([
      new InMemoryStringSource(
        JSON.stringify({
          "metadata.root": {
            package: "acme::commerce",
            children: [
              {
                "object.entity": {
                  name: "Program",
                  children: [
                    { "field.long": { name: "id" } },
                    {
                      "relationship.association": {
                        name: "weeks",
                        "@objectRef": "Week",
                      },
                    },
                    { "identity.primary": { "name": "id", "@fields": "id" } },
                  ],
                },
              },
              {
                "object.entity": {
                  name: "Week",
                  children: [
                    { "field.long": { name: "id" } },
                    { "identity.primary": { "name": "id", "@fields": "id" } },
                  ],
                },
              },
              {
                "object.entity": {
                  name: "ProgramSummary",
                  extends: "Program",
                  children: [
                    { "source.rdb": { "@kind": "view", "@table": "v" } },
                    {
                      "field.int": {
                        name: "weekCount",
                        children: [
                          {
                            "origin.aggregate": {
                              "@agg": "count",
                              "@of": "GhostEntity.id",
                              "@via": "Program.weeks",
                            },
                          },
                        ],
                      },
                    },
                    { "identity.primary": { "name": "id", "@fields": "id" } },
                  ],
                },
              },
            ],
          },
        }),
        { id: "meta.json", format: "json" },
      ),
    ]);
    const ofErr = res.errors.find(
      (e): e is ParseError =>
        e instanceof ParseError &&
        e.code === "ERR_INVALID_ORIGIN" &&
        e.message.includes("GhostEntity"),
    );
    expect(ofErr).toBeDefined();
    expectResolved(ofErr, {
      code: "ERR_INVALID_ORIGIN",
      referrer: "ProgramSummary::weekCount",
      target: "GhostEntity.id",
    });
  });

  test("aggregate @of to existing entity but missing field: target = full ref", async () => {
    const res = await new MetaDataLoader().load([
      new InMemoryStringSource(
        JSON.stringify({
          "metadata.root": {
            package: "acme::commerce",
            children: [
              {
                "object.entity": {
                  name: "Program",
                  children: [
                    { "field.long": { name: "id" } },
                    {
                      "relationship.association": {
                        name: "weeks",
                        "@objectRef": "Week",
                      },
                    },
                    { "identity.primary": { "name": "id", "@fields": "id" } },
                  ],
                },
              },
              {
                "object.entity": {
                  name: "Week",
                  children: [
                    { "field.long": { name: "id" } },
                    { "identity.primary": { "name": "id", "@fields": "id" } },
                  ],
                },
              },
              {
                "object.entity": {
                  name: "ProgramSummary",
                  extends: "Program",
                  children: [
                    { "source.rdb": { "@kind": "view", "@table": "v" } },
                    {
                      "field.int": {
                        name: "weekCount",
                        children: [
                          {
                            "origin.aggregate": {
                              "@agg": "count",
                              "@of": "Week.ghostField",
                              "@via": "Program.weeks",
                            },
                          },
                        ],
                      },
                    },
                    { "identity.primary": { "name": "id", "@fields": "id" } },
                  ],
                },
              },
            ],
          },
        }),
        { id: "meta.json", format: "json" },
      ),
    ]);
    const fieldErr = res.errors.find(
      (e): e is ParseError =>
        e instanceof ParseError &&
        e.code === "ERR_INVALID_ORIGIN" &&
        e.message.includes("ghostField"),
    );
    expect(fieldErr).toBeDefined();
    expectResolved(fieldErr, {
      code: "ERR_INVALID_ORIGIN",
      referrer: "ProgramSummary::weekCount",
      target: "Week.ghostField",
    });
  });
});

describe("FR5d — resolved envelope shape contracts", () => {
  test("resolved source carries the referrer's files (so editors can jump to the broken declaration)", async () => {
    const res = await new MetaDataLoader().load([
      new InMemoryStringSource(
        JSON.stringify({
          "metadata.root": {
            package: "p",
            children: [
              {
                "object.entity": {
                  name: "A",
                  extends: "Ghost",
                  children: [
                    { "field.long": { name: "id" } },
                    { "identity.primary": { "name": "id", "@fields": "id" } },
                  ],
                },
              },
            ],
          },
        }),
        { id: "input/A.json", format: "json" },
      ),
    ]);
    const err = res.errors[0] as ParseError;
    expect(err.source.format).toBe("resolved");
    if (err.source.format === "resolved") {
      expect(err.source.files).toEqual(["input/A.json"]);
      // jsonPath is populated by the parser so the IDE/editor can pinpoint
      // the `extends:` declaration on disk.
      expect(typeof err.source.jsonPath).toBe("string");
      expect(err.source.jsonPath).toContain("$");
    }
  });
});

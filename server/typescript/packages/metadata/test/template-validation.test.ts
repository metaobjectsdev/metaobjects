import { describe, test, expect } from "bun:test";
import { MetaDataLoader } from "../src/loader/meta-data-loader.js";
import { InMemoryStringSource } from "../src/loader/meta-data-source.js";
import { ParseError } from "../src/errors.js";

async function load(children: unknown[]) {
  const loader = new MetaDataLoader();
  const json = JSON.stringify({ "metadata.root": { package: "test", children } });
  const result = await loader.load([new InMemoryStringSource(json)]);
  return result.errors.map((e) => ({
    code: e instanceof ParseError ? e.code : undefined,
    message: e.message,
  }));
}

const authorBrief = {
  "object.value": { name: "AuthorBrief", children: [{ "field.string": { name: "displayName" } }] },
};

describe("template load-time validation", () => {
  test("@payloadRef resolving to a real object.value + @requiredSlots that are fields → no errors", async () => {
    const errs = await load([
      authorBrief,
      {
        "template.prompt": {
          name: "strategy",
          "@payloadRef": "AuthorBrief",
          "@textRef": "prompt/strategy",
          "@format": "xml",
          "@requiredSlots": ["displayName"],
        },
      },
    ]);
    expect(errs).toEqual([]);
  });

  test("@payloadRef that doesn't resolve → ERR_INVALID_TEMPLATE", async () => {
    const errs = await load([
      authorBrief,
      { "template.prompt": { name: "bad", "@payloadRef": "NoSuchPayload", "@textRef": "p/x" } },
    ]);
    expect(errs.map((e) => e.code)).toContain("ERR_INVALID_TEMPLATE");
  });

  test("@requiredSlots referencing a non-field on the payload → ERR_INVALID_TEMPLATE", async () => {
    const errs = await load([
      authorBrief,
      {
        "template.prompt": {
          name: "bad",
          "@payloadRef": "AuthorBrief",
          "@textRef": "p/x",
          "@requiredSlots": ["displayName", "notAField"],
        },
      },
    ]);
    expect(errs.map((e) => e.code)).toContain("ERR_INVALID_TEMPLATE");
  });

  // --- @kind (document|email) + email part-refs (Task 1) ---

  test("@kind=email with @subjectRef + @htmlBodyRef → no errors", async () => {
    const errs = await load([
      authorBrief,
      {
        "template.output": {
          name: "welcome",
          "@payloadRef": "AuthorBrief",
          "@kind": "email",
          "@format": "html",
          "@subjectRef": "email/welcome-subject",
          "@htmlBodyRef": "email/welcome-html",
        },
      },
    ]);
    expect(errs).toEqual([]);
  });

  test("@kind=email missing @subjectRef → ERR_INVALID_TEMPLATE", async () => {
    const errs = await load([
      authorBrief,
      {
        "template.output": {
          name: "welcome",
          "@payloadRef": "AuthorBrief",
          "@kind": "email",
          "@htmlBodyRef": "email/welcome-html",
        },
      },
    ]);
    expect(errs.map((e) => e.code)).toContain("ERR_INVALID_TEMPLATE");
  });

  test("@kind=document (absent) missing @textRef → ERR_INVALID_TEMPLATE", async () => {
    const errs = await load([
      authorBrief,
      {
        "template.output": {
          name: "report",
          "@payloadRef": "AuthorBrief",
          "@format": "html",
        },
      },
    ]);
    expect(errs.map((e) => e.code)).toContain("ERR_INVALID_TEMPLATE");
  });

  test("@kind not in the closed enum → closed-enum error", async () => {
    const errs = await load([
      authorBrief,
      {
        "template.output": {
          name: "bogus",
          "@payloadRef": "AuthorBrief",
          "@textRef": "out/x",
          "@kind": "carrier-pigeon",
        },
      },
    ]);
    expect(errs.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// #236 — an ABSTRACT template.prompt may omit the required @payloadRef (concrete
// subtypes / extends supply it). The required-attr check reads the RESOLVING set
// (a concrete inheriting via extends is satisfied) and EXEMPTS abstract nodes (a
// template is not instantiated; its incompleteness is fine). Consistent with ADR-0039.
// ---------------------------------------------------------------------------
describe("#236 abstract template.prompt may omit required @payloadRef", () => {
  test("abstract WITHOUT @payloadRef + concrete extends supplying it → loads", async () => {
    const errs = await load([
      authorBrief,
      { "template.prompt": { name: "BasePrompt", abstract: true, "@textRef": "p/base" } },
      { "template.prompt": { name: "Concrete", extends: "test::BasePrompt", "@payloadRef": "AuthorBrief", "@textRef": "p/c" } },
    ]);
    expect(errs).toEqual([]);
  });

  test("concrete INHERITS @payloadRef from an abstract via extends → loads (resolving)", async () => {
    const errs = await load([
      authorBrief,
      { "template.prompt": { name: "BasePrompt", abstract: true, "@payloadRef": "AuthorBrief", "@textRef": "p/base" } },
      { "template.prompt": { name: "Concrete", extends: "test::BasePrompt", "@textRef": "p/c" } },
    ]);
    expect(errs).toEqual([]);
  });

  test("CONCRETE missing @payloadRef (nowhere in its chain) → ERR_MISSING_REQUIRED_ATTR", async () => {
    const errs = await load([
      authorBrief,
      { "template.prompt": { name: "BasePrompt", abstract: true, "@textRef": "p/base" } },
      { "template.prompt": { name: "Concrete", extends: "test::BasePrompt", "@textRef": "p/c" } },
    ]);
    expect(errs.map((e) => e.code)).toContain("ERR_MISSING_REQUIRED_ATTR");
  });
});

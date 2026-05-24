import { describe, expect, it } from "bun:test";
import { readDocAttrs, renderJsDocBlock } from "../../src/templates/jsdoc.js";

describe("renderJsDocBlock", () => {
  it("returns empty string when no doc attrs present", () => {
    expect(renderJsDocBlock({})).toBe("");
  });

  it("renders single-line description as one-liner /** desc */", () => {
    expect(renderJsDocBlock({ description: "Hello." })).toBe("/** Hello. */");
  });

  it("renders multi-line description as JSDoc block", () => {
    const out = renderJsDocBlock({ description: "Line one.\nLine two." });
    expect(out).toContain("/**");
    expect(out).toContain(" * Line one.");
    expect(out).toContain(" * Line two.");
    expect(out).toContain(" */");
  });

  it("emits @deprecated with reason and appended replacedBy", () => {
    const out = renderJsDocBlock({
      description: "Old field.",
      deprecated: "Use newField.",
      replacedBy: "Foo.newField",
    });
    expect(out).toContain("@deprecated Use newField. Replaced by Foo.newField.");
  });

  it("emits @see per seeAlso URL", () => {
    const out = renderJsDocBlock({
      description: "x",
      seeAlso: ["https://a", "https://b"],
    });
    expect(out).toContain("@see https://a");
    expect(out).toContain("@see https://b");
  });

  it("emits @alias per alias", () => {
    const out = renderJsDocBlock({ description: "x", aliases: ["a", "b"] });
    expect(out).toContain("@alias a");
    expect(out).toContain("@alias b");
  });

  it("does NOT emit notes content (D5 internal-only contract)", () => {
    const out = renderJsDocBlock({
      description: "Public.",
      notes: "INTERNAL_SECRET_MARKER",
    });
    expect(out).not.toContain("INTERNAL_SECRET_MARKER");
  });
});

describe("readDocAttrs", () => {
  /** Build a fake MetaData-shaped object with the given attr map. */
  function mockNode(attrs: Record<string, unknown>) {
    return { attr: (name: string): unknown => attrs[name] };
  }

  it("populates all 6 fields when all doc attrs present with correct types", () => {
    const got = readDocAttrs(
      mockNode({
        description: "A description.",
        title: "Title",
        deprecated: "Don't use.",
        replacedBy: "Foo.bar",
        seeAlso: ["https://a", "https://b"],
        aliases: ["x", "y"],
        // notes is present in the source node — must NOT appear in the result.
        notes: "INTERNAL",
      }),
    );
    expect(got).toEqual({
      description: "A description.",
      title: "Title",
      deprecated: "Don't use.",
      replacedBy: "Foo.bar",
      seeAlso: ["https://a", "https://b"],
      aliases: ["x", "y"],
    });
    // Belt-and-braces: notes is never read, so it must be absent on the result.
    expect("notes" in got).toBe(false);
  });

  it("returns undefined for wrong-type values (defensive type guards)", () => {
    const got = readDocAttrs(
      mockNode({
        description: 42,                // wrong: number, not string
        title: { not: "a string" },     // wrong: object
        seeAlso: "not-an-array",        // wrong: string, not string[]
        aliases: [1, 2, 3],             // wrong: number[], not string[]
      }),
    );
    expect(got.description).toBeUndefined();
    expect(got.title).toBeUndefined();
    expect(got.seeAlso).toBeUndefined();
    expect(got.aliases).toBeUndefined();
  });

  it("returns undefined for absent attrs", () => {
    const got = readDocAttrs(mockNode({}));
    expect(got.description).toBeUndefined();
    expect(got.title).toBeUndefined();
    expect(got.deprecated).toBeUndefined();
    expect(got.replacedBy).toBeUndefined();
    expect(got.seeAlso).toBeUndefined();
    expect(got.aliases).toBeUndefined();
  });
});

import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource, ParseError } from "../src/index.js";

describe("FR5a — ParseError carries an ErrorSource envelope", () => {
  test("malformed JSON: error.source has format='json', files, jsonPath", async () => {
    const res = await new MetaDataLoader().load([
      new InMemoryStringSource(
        JSON.stringify({
          "metadata.root": {
            children: [
              { "object.entity": { name: "User", children: [{ "field.unknownXyz": { name: "x" } }, { "identity.primary": { "@fields": "x" } }] } },
            ],
          },
        }),
        { id: "meta.json", format: "json" },
      ),
    ]);
    expect(res.errors.length).toBeGreaterThan(0);
    const err = res.errors[0]!;
    expect(err).toBeInstanceOf(ParseError);
    const pe = err as ParseError;
    expect(pe.code).toBeDefined();
    expect(pe.source).toBeDefined();
    expect(pe.source.format).toBe("json");
    if (pe.source.format === "json") {
      expect(pe.source.files).toEqual(["meta.json"]);
      expect(pe.source.jsonPath).toContain("$");
    }
  });

  test("programmatic ParseError construction accepts ErrorSource", () => {
    const e = new ParseError("test", {
      code: "ERR_BAD_ATTR_VALUE",
      source: { format: "code", caller: "unit-test" },
    });
    expect(e.source.format).toBe("code");
    if (e.source.format === "code") {
      expect(e.source.caller).toBe("unit-test");
    }
  });
});

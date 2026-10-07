import { describe, test, expect } from "bun:test";
import { parseExportArgs } from "../../src/lib/args.js";

describe("parseExportArgs", () => {
  test("default flags — out is undefined", () => {
    expect(parseExportArgs([])).toEqual({ out: undefined });
  });

  test("--out sets the output path", () => {
    expect(parseExportArgs(["--out", "dist/metadata.json"])).toEqual({
      out: "dist/metadata.json",
    });
  });

  test("--out with absolute path", () => {
    expect(parseExportArgs(["--out", "/tmp/metadata.json"])).toEqual({
      out: "/tmp/metadata.json",
    });
  });

  test("unknown flag throws", () => {
    expect(() => parseExportArgs(["--foo"])).toThrow(/unknown flag --foo for `meta export`\. Valid flags: .*--out/);
  });

  test("positionals are rejected", () => {
    expect(() => parseExportArgs(["some-positional"])).toThrow(/Unexpected argument 'some-positional'/);
  });
});

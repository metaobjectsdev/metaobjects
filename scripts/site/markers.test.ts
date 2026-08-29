import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { extractMarkedRegion } from "./markers.js";

const SRC = [
  "metadata:",
  "  children:",
  "    # >>> snippet: alpha",
  "    - object.entity:",
  "        name: Subscriber",
  "    # <<<",
  "    - object.value:",
].join("\n");

describe("extractMarkedRegion", () => {
  test("returns the region between the markers, markers removed", () => {
    expect(extractMarkedRegion(SRC, "alpha")).toBe(
      "- object.entity:\n    name: Subscriber");
  });

  test("dedents by the common leading indent, preserving relative structure", () => {
    const out = extractMarkedRegion(SRC, "alpha").split("\n");
    expect(out[0]).toBe("- object.entity:");
    expect(out[1]).toBe("    name: Subscriber");
  });

  test("ignores blank lines when computing the common indent", () => {
    const src = "  # >>> snippet: b\n  a: 1\n\n  c: 2\n  # <<<";
    expect(extractMarkedRegion(src, "b")).toBe("a: 1\n\nc: 2");
  });

  // The dedent's promise is "relative structure preserved". A trailing .trim()
  // would break it whenever the FIRST line is not the least-indented one.
  test("does not strip the first line's indent when it is not the shallowest", () => {
    const src = "# >>> snippet: c\n    - a:\n  b:\n# <<<";
    expect(extractMarkedRegion(src, "c")).toBe("  - a:\nb:");
  });

  test("drops leading and trailing blank lines", () => {
    const src = "# >>> snippet: d\n\n  a: 1\n\n# <<<";
    expect(extractMarkedRegion(src, "d")).toBe("a: 1");
  });

  test("throws on a missing marker", () => {
    expect(() => extractMarkedRegion(SRC, "nope")).toThrow(/no marker.*nope/i);
  });

  test("throws on an unterminated marker", () => {
    expect(() => extractMarkedRegion("# >>> snippet: x\na: 1", "x"))
      .toThrow(/unterminated/i);
  });

  test("extracts all three regions from the real showcase model", () => {
    const yaml = readFileSync(resolve(import.meta.dirname,
      "../../examples/showcase/metaobjects/meta.subscriber.yaml"), "utf8");
    expect(extractMarkedRegion(yaml, "showcase-model")).toStartWith("- object.entity:");
    expect(extractMarkedRegion(yaml, "showcase-requirement"))
      .toContain("subscriberCanBePausedWithoutErasingHistory");
    expect(extractMarkedRegion(yaml, "showcase-prompt")).toContain("template.prompt:");
  });
});

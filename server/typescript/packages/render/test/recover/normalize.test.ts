import { describe, expect, test } from "bun:test";
import { normalizeEnum } from "../../src/recover/normalize.js";

describe("normalizeEnum", () => {
  test("none = identity", () => expect(normalizeEnum("In Progress", "none")).toBe("In Progress"));
  test("collapse: case-fold + trim + [\\s_-]+ -> _", () => {
    expect(normalizeEnum("  In-Progress ", "collapse")).toBe("IN_PROGRESS");
    expect(normalizeEnum("in progress", "collapse")).toBe("IN_PROGRESS");
    expect(normalizeEnum("inprogress", "collapse")).toBe("INPROGRESS"); // stays distinct
  });
  test("strip: case-fold + keep [A-Z0-9] only", () => {
    expect(normalizeEnum("in progress!", "strip")).toBe("INPROGRESS");
    expect(normalizeEnum("IN_PROGRESS", "strip")).toBe("INPROGRESS");
  });
  test("ASCII-only case fold (no locale)", () => expect(normalizeEnum("café", "strip")).toBe("CAF")); // é dropped
});

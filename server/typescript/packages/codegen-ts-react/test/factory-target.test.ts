import { describe, it, expect } from "bun:test";
import { formFile } from "../src/form-file.js";

describe("formFile factory — target", () => {
  it("accepts target opt", () => {
    expect(formFile({ target: "web" }).target).toBe("web");
  });
  it("target undefined when unset", () => {
    expect(formFile().target).toBeUndefined();
  });
});

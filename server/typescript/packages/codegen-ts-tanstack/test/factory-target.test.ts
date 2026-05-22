import { describe, it, expect } from "bun:test";
import { tanstackQuery } from "../src/tanstack-query.js";
import { tanstackGrid } from "../src/tanstack-grid.js";
import { tanstackGridHook } from "../src/tanstack-grid-hook.js";

describe("tanstack factories — target", () => {
  it("accept target opt", () => {
    expect(tanstackQuery({ target: "web" }).target).toBe("web");
    expect(tanstackGrid({ target: "web" }).target).toBe("web");
    expect(tanstackGridHook({ target: "web" }).target).toBe("web");
  });
  it("target undefined when unset", () => {
    expect(tanstackQuery().target).toBeUndefined();
  });
});

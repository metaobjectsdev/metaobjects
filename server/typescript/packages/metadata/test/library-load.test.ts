import { describe, test, expect } from "bun:test";
import { librarySources } from "../src/library/library-sources.ts";

describe("librarySources", () => {
  test("returns a source for the ai package whose content mentions LlmCallBase", async () => {
    const sources = librarySources(["ai"]);
    expect(sources.length).toBe(1);
    // read() returns Promise<string> per the MetaDataSource contract.
    const text = await sources[0]!.read();
    expect(text).toContain("LlmCallBase");
  });

  test("unknown package yields no sources", () => {
    expect(librarySources(["does-not-exist"]).length).toBe(0);
  });
});

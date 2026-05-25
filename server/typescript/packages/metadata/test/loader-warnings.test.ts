// FR5a Phase 5 — LoadResult.warnings channel.
//
// Verifies the warnings channel exists on every LoadResult per ADR-0009.
// FR5a does NOT populate the channel with envelope-shaped LoaderWarnings —
// the channel exists; FR5c fills it (overlay-merge duplicate detection).

import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "../src/index.js";

describe("FR5a — LoadResult.warnings", () => {
  test("clean load returns warnings as an empty array", async () => {
    const res = await new MetaDataLoader().load([
      new InMemoryStringSource(
        JSON.stringify({
          "metadata.root": {
            package: "acme",
            children: [
              {
                "object.entity": {
                  name: "User",
                  children: [
                    { "field.string": { name: "id" } },
                    { "identity.primary": { "@fields": "id" } },
                  ],
                },
              },
            ],
          },
        }),
        { id: "meta.json", format: "json" },
      ),
    ]);
    expect(res.errors).toEqual([]);
    expect(res.warnings).toEqual([]);
    expect(Array.isArray(res.warnings)).toBe(true);
  });
});

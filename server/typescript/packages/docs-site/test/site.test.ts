import { expect, test } from "bun:test";
import { existsSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSite } from "../src/site";

test("generates all pages for the fixture", async () => {
  const out = mkdtempSync(join(tmpdir(), "site-"));
  const r = await generateSite({ sourceDirs: [join(import.meta.dir, "fixture/input/acme")], outDir: out, title: "Fixture", stamp: "2026-01-01", commit: "abc1234" });
  for (const p of ["index.html", "coverage.html", "enums.html", "acme/shop/index.html", "acme/shop/Order.html", "acme/ai/npcReview.html", "acme/ai/npcReviewOutput.html", "assets/site.css", "assets/site.js", "assets/search-index.json"])
    expect(existsSync(join(out, p))).toBe(true);
  expect(readFileSync(join(out, "acme/ai/npcReview.html"), "utf8")).toContain("mu-sec");
  expect(r.pages.length).toBeGreaterThan(10);
  expect(r.dangling).toEqual([]);
});

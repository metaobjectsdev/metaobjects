import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSite } from "../src/site";
import { loadModel } from "../src/load";

// A base object in a TOP-LEVEL file + an `overlay: true` extension in a SUBDIR
// whose basename ("aaa-overlay.yaml") sorts BEFORE the base ("base.yaml"). Under
// fromDirectory's flat basename sort the overlay loads first → ERR_OVERLAY_NO_TARGET;
// the files-before-subdirs order loads the base first so the overlay merges.
function overlayFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "docs-overlay-"));
  const src = join(root, "acme");
  mkdirSync(join(src, "z-sub"), { recursive: true });
  writeFileSync(
    join(src, "base.yaml"),
    [
      "metadata:",
      "  package: acme",
      "  children:",
      "    - object.value:",
      "        name: Widget",
      "        children:",
      "          - field.string: { name: id }",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(src, "z-sub", "aaa-overlay.yaml"),
    [
      "metadata:",
      "  package: acme",
      "  children:",
      "    - object.value:",
      "        name: Widget",
      "        overlay: true",
      "        children:",
      "          - field.string: { name: extra }",
      "",
    ].join("\n"),
  );
  return src;
}

test("cross-file overlay: base (top-level) loads before an overlay nested in a subdir", async () => {
  const dir = overlayFixture();
  const model = await loadModel([dir]);
  const widget = model.root.objects().find((o) => o.name === "Widget");
  expect(widget).toBeDefined();
  const fieldNames = widget!.childrenOfType("field").map((f) => f.name);
  // base field preserved AND the subdir overlay merged its field in
  expect(fieldNames).toContain("id");
  expect(fieldNames).toContain("extra");
});

test("generateSite succeeds on a model with a subdir overlay", async () => {
  const dir = overlayFixture();
  const out = mkdtempSync(join(tmpdir(), "docs-overlay-out-"));
  const r = await generateSite({
    sourceDirs: [dir],
    outDir: out,
    title: "Fixture",
    stamp: "2026-01-01",
    commit: "abc1234",
  });
  expect(existsSync(join(out, "index.html"))).toBe(true);
  expect(r.dangling).toEqual([]);
});

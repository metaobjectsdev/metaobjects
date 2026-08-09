/**
 * #287 — the browser packages must actually bundle for a browser.
 *
 * `@metaobjectsdev/metadata`'s package root exports `MetaDataLoader`, which imports
 * `library/library-sources.ts`, which does `import { fileURLToPath } from "node:url"`.
 * So a single VALUE import from that root — `runtime-web` imported six `LAYOUT_*`
 * constants for `buildGrid` — dragged the Node-only loader into every browser bundle:
 *
 *     error: Browser polyfill for module "node:url" doesn't have a matching export
 *            named "fileURLToPath"
 *            … metadata/dist/library/library-sources.js
 *
 * Because every generated `<Entity>.hooks.ts` imports `buildFilterQs` from
 * `runtime-web`, **no client consuming the generated hooks could build at all** —
 * unconditionally, on 0.21.3. Reported by an adopting project.
 *
 * Why nothing caught it: this package's tests run under Bun's *test* runner, which
 * resolves the `"bun"` export condition to TypeScript SOURCE and never bundles. The
 * failure only exists on the `dist` path a published consumer resolves, under a
 * browser-targeted bundler. Unit tests here can pass forever while the package is
 * unbuildable for its only audience. So this test does the one thing that reproduces it:
 * runs a real browser-target bundle over the BUILT output.
 *
 * The root barrel already keeps one Node-only module out deliberately
 * (`registry-coverage.ts`, with a comment saying why); `library-sources` reaches it via
 * the loader instead. The fix is `@metaobjectsdev/metadata/constants` — a barrel of pure
 * constant modules with no `node:*` anywhere in its graph — which browser packages import
 * VALUES from. Types may still come from the root: `import type` is erased at build time.
 */

import { describe, test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

const PKG_ROOT = join(import.meta.dir, "..");
const DIST_ENTRY = join(PKG_ROOT, "dist", "index.js");
const METADATA_CONSTANTS = join(
  PKG_ROOT, "..", "..", "..", "..", "server", "typescript", "packages", "metadata", "dist", "constants.js",
);

/** Bundle `entry` for the browser via Bun's bundler; resolve the failure text, if any. */
async function browserBundle(entry: string): Promise<{ ok: boolean; message: string }> {
  const built = await Bun.build({ entrypoints: [entry], target: "browser", throw: false });
  return {
    ok: built.success,
    message: built.logs.map((l) => String(l)).join("\n"),
  };
}

describe("#287 — browser bundleability", () => {
  test("the BUILT runtime-web entry bundles for a browser target", async () => {
    // dist/ is what a published consumer resolves. If it is missing the gate is
    // meaningless, so say so rather than skipping quietly.
    expect(
      existsSync(DIST_ENTRY),
      "dist/index.js is missing — run `bun run build` before this gate; " +
        "testing src/ would not reproduce #287 (Bun's test runner resolves the `bun` " +
        "export condition to TypeScript source and never bundles).",
    ).toBe(true);

    const { ok, message } = await browserBundle(DIST_ENTRY);
    // Name the original symptom so a future failure is self-diagnosing.
    expect(message).not.toMatch(/node:url|fileURLToPath/);
    expect(message).not.toMatch(/node:fs|node:path/);
    expect(ok).toBe(true);
  });

  test("the metadata constants subpath is free of node:* in its whole graph", async () => {
    // The fix depends entirely on this barrel staying pure. One transitive node:*
    // import added here silently re-breaks every browser build downstream.
    expect(existsSync(METADATA_CONSTANTS)).toBe(true);
    const { ok, message } = await browserBundle(METADATA_CONSTANTS);
    expect(message).not.toMatch(/node:/);
    expect(ok).toBe(true);
  });

  test("importing metamodel VALUES from the metadata ROOT is what breaks — a live demo", async () => {
    // Pins the causal claim rather than asserting it in a comment: bundling the root
    // barrel for a browser must still fail. If this ever starts passing, the root became
    // browser-safe and the constants subpath is no longer load-bearing — worth knowing
    // deliberately rather than discovering when someone "simplifies" the import back.
    const root = join(
      PKG_ROOT, "..", "..", "..", "..", "server", "typescript", "packages", "metadata", "dist", "index.js",
    );
    if (!existsSync(root)) return; // metadata not built in this run — nothing to assert
    const { ok } = await browserBundle(root);
    expect(ok).toBe(false);
  });
});

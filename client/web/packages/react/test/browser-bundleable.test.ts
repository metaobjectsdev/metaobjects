/**
 * #287 — this package must actually bundle for a browser.
 *
 * A single VALUE import from `@metaobjectsdev/metadata`'s root barrel drags
 * `MetaDataLoader` → `library/library-sources.ts` → `node:url` into the graph, and on
 * 0.21.3 `runtime-web` had one, so **no client consuming the generated hooks could
 * build at all**. `@metaobjectsdev/react` sits directly downstream of `runtime-web` and
 * is what a generated `<Entity>.form.tsx` imports — it inherited the break and was
 * ungated. This is that gate. The full post-mortem lives in
 * `runtime-web/test/browser-bundleable.test.ts`; the short version:
 *
 * Bun's TEST runner resolves the `"bun"` export condition to TypeScript SOURCE and never
 * bundles, so every other test here can pass forever while the published package is
 * unbuildable for its only audience. The one thing that reproduces it is a real
 * browser-target bundle over the BUILT output — hence `dist/`, deliberately, not `src/`.
 *
 * Verified by re-introducing the regression (a root-barrel value re-export in
 * runtime-web's dist): this test fails with the original message verbatim.
 */

import { describe, test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

const DIST_ENTRY = join(import.meta.dir, "..", "dist", "index.js");

/** Bundle `entry` for the browser via Bun's bundler; resolve the failure text, if any. */
async function browserBundle(entry: string): Promise<{ ok: boolean; message: string }> {
  const built = await Bun.build({ entrypoints: [entry], target: "browser", throw: false });
  return { ok: built.success, message: built.logs.map((l) => String(l)).join("\n") };
}

describe("#287 — browser bundleability", () => {
  test("the BUILT react entry bundles for a browser target", async () => {
    // dist/ is what a published consumer resolves. If it is missing the gate is
    // meaningless, so say so rather than skipping quietly — a gate that silently
    // no-ops when unbuilt is the exact failure mode #287 was.
    expect(
      existsSync(DIST_ENTRY),
      "dist/index.js is missing — run `bun run build` before this gate; " +
        "testing src/ would not reproduce #287 (Bun's test runner resolves the `bun` " +
        "export condition to TypeScript source and never bundles).",
    ).toBe(true);

    const { ok, message } = await browserBundle(DIST_ENTRY);
    // Name the original symptoms so a future failure is self-diagnosing.
    expect(message).not.toMatch(/node:url|fileURLToPath/);
    expect(message).not.toMatch(/node:fs|node:path/);
    expect(ok).toBe(true);
  });
});

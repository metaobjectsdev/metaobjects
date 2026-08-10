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

  // An OPTIONAL peer must be genuinely optional: absent from the consumer's install,
  // the package root must still bundle. `react-easy-crop` was declared optional
  // through 0.21.4 and was not — `ImageUpload` is exported from the root, so
  // `image-upload.js` is in every consumer's graph, and bundlers resolve the whole
  // graph before tree-shaking. A dynamic import() of a missing package is FATAL to
  // webpack, Next.js (Turbopack and webpack), esbuild and Bun; only Vite
  // special-cases it. So every consumer of the generated forms failed to build,
  // whether or not they authored an image field. It is a real dependency now.
  //
  // This gate could not be written as "uninstall the package": the workspace needs
  // react-easy-crop as a dependency for the unit tests, and that installed copy is
  // exactly what made the old gate green while adopters were broken. Instead the
  // resolver is made to behave the way a consumer install does — which is also why
  // this is written against EVERY declared-optional peer rather than one hardcoded
  // name: the next optional peer someone adds is covered on arrival.
  test("every peer declared OPTIONAL is unreachable from the package root", async () => {
    const pkg = JSON.parse(
      await Bun.file(join(import.meta.dir, "..", "package.json")).text(),
    ) as { peerDependenciesMeta?: Record<string, { optional?: boolean }> };
    const optional = Object.entries(pkg.peerDependenciesMeta ?? {})
      .filter(([, v]) => v.optional === true)
      .map(([name]) => name);

    for (const peer of optional) {
      const built = await Bun.build({
        entrypoints: [DIST_ENTRY],
        target: "browser",
        throw: false,
        plugins: [{
          name: "forbid-optional-peer",
          setup(build) {
            build.onResolve({ filter: new RegExp(`^${peer.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(/|$)`) }, (args) => {
              throw new Error(
                `optional peer "${peer}" is reachable from the package ROOT ` +
                `(imported by ${args.importer}) — a consumer who does not install it ` +
                `cannot bundle on webpack/Next/esbuild/Bun. Either make it a real ` +
                `dependency, or move whatever imports it behind its own subpath export.`,
              );
            });
          },
        }],
      });
      // Assert on the SPECIFIC signal, not on an empty log: when this file runs
      // alongside the jsdom-based tests in this package, jsdom's filesystem patching
      // makes Bun's bundler emit incidental "Unexpected reading file" messages about
      // react/qs. Those say nothing about peer reachability, and demanding a silent
      // log would make this gate fail for a reason it does not test.
      const log = built.logs.map((l) => String(l)).join("\n");
      expect(log).not.toMatch(/is reachable from the package ROOT/);
      expect(log).not.toMatch(new RegExp(`Could not resolve.*${peer.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    }
  });
});

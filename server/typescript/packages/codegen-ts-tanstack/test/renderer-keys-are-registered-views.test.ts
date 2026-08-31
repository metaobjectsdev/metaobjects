// #355 — the cell-renderer registry is keyed by a column's `meta.view`, and this package
// is what puts a value there: fieldViewKind() returns `view?.subType ?? "text"`, so the
// key set it can emit is exactly the REGISTERED view subtypes. Nothing ever compared the
// two, and they had drifted in both directions at once:
//
//   * `datetime` and `boolean` were renderer keys with no registered subtype — dead code
//     reachable only by hand-setting meta.view outside the generated pipeline.
//   * `view.checkbox` IS registered and had NO renderer, so a checkbox column fell through
//     `if (!renderer) return col;` and rendered a raw `true`/`false` — while the "Yes"/"No"
//     renderer plainly written for it sat under the unreachable `boolean` key.
//
// This gate is owned HERE rather than in the browser package on purpose: @metaobjectsdev/
// tanstack deliberately carries no @metaobjectsdev/metadata dependency (browser bundle,
// #287), and this is the package that decides what `meta.view` can say.
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { VIEW_SUBTYPES } from "@metaobjectsdev/metadata/constants";

// test/ -> codegen-ts-tanstack -> packages -> typescript -> server -> repo root
const RENDERERS = resolve(
  import.meta.dirname,
  "../../../../../client/web/packages/tanstack/src/cell-renderers.tsx",
);

/** Top-level keys of the `defaultCellRenderers` object literal. */
function rendererKeys(): string[] {
  // readFileSync throws if the hop count above is wrong — this gate must never
  // degrade to "found nothing, passed".
  const src = readFileSync(RENDERERS, "utf8");
  const start = src.indexOf("defaultCellRenderers");
  expect(start).toBeGreaterThan(-1);
  const body = src.slice(start);
  const keys = [...body.matchAll(/^ {2}(\w+):/gm)]
    .map((m) => m[1])
    .filter((k): k is string => k !== undefined);
  expect(keys.length).toBeGreaterThan(3);   // the parse itself must not silently yield []
  return keys;
}

describe("#355 — renderer keys and registered view subtypes agree", () => {
  test("every renderer key is a registered view subtype", () => {
    const unreachable = rendererKeys().filter((k) => !VIEW_SUBTYPES.includes(k as never));
    // A key no view subtype can produce is unreachable through codegen: fieldViewKind()
    // can only ever emit a registered subType (or the "text" fallback).
    expect(unreachable).toEqual([]);
  });

  test("the renderer for a boolean-valued view is reachable under its registered name", () => {
    // The concrete regression: `boolean` was the key, `checkbox` is the subtype.
    expect(VIEW_SUBTYPES).toContain("checkbox");
    expect(rendererKeys()).toContain("checkbox");
    expect(rendererKeys()).not.toContain("boolean");
  });
});

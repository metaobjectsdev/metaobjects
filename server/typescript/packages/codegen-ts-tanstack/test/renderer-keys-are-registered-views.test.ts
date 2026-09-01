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

  /**
   * The CONVERSE direction, which the gate above cannot see.
   *
   * "Every renderer key is a registered subtype" only catches dead keys. It says nothing
   * about a registered subtype with NO key — and that is the half that produced the
   * original `checkbox` bug: `EntityGrid` does `if (!renderer) return col`, so an unkeyed
   * subtype silently falls through to TanStack's default cell and prints the raw value,
   * whatever the subtype's registered description promises. `hotlink` ("Renders the value
   * as a clickable link") and `month` were rendering raw strings for exactly that reason.
   *
   * Every concrete subtype must therefore have a renderer OR a written exemption. An
   * exemption is a decision on the record; a missing key is an accident.
   */
  const NO_RENDERER_BY_DESIGN: Readonly<Record<string, string>> = {
    base: "the type's shared root, not a control — nothing emits `meta.view: \"base\"`.",
    web: "an abstract base for web-rendered views, same as `base`.",
    hidden:
      "excluded from the column set by codegen (columns-file.ts), because \"not rendered\" " +
      "means no column rather than a blank cell that still holds a header and a sort target. " +
      "It therefore never reaches a cell, so a renderer would be unreachable. That claim " +
      "about codegen is itself gated, in hidden-view-column.test.ts.",
    image:
      "the field stores an opaque storage key, so an <img> needs ImageUploadAdapter.imageUrl(). " +
      "That adapter is exposed through a React context in @metaobjectsdev/react, which this " +
      "browser package does not depend on. The DURABLE reason is the install graph, not the " +
      "bundle: @metaobjectsdev/react declares react-hook-form and @hookform/resolvers as " +
      "REQUIRED peers (only zod is marked optional), so a dependency edge would make every " +
      "grid-only consumer responsible for a form stack it never uses — and peerDependencies " +
      "are declared per PACKAGE, so no export-map or subpath change reaches that. The bundle " +
      "cost (dragging the image-upload/crop graph in, the #287 / react-easy-crop class) is " +
      "real but secondary, and is the half a subpath WOULD fix — recording only that reason " +
      "would let a future reader retire this exemption on the strength of a change that does " +
      "not address it. Apps render it today by overriding the `image` key on " +
      "<CellRendererProvider>.",
  };

  test("every concrete view subtype has a renderer, or a written exemption", () => {
    const keys = rendererKeys();
    const unexplained = [...VIEW_SUBTYPES].filter(
      (s) => !keys.includes(s) && NO_RENDERER_BY_DESIGN[s] === undefined,
    );
    expect(unexplained).toEqual([]);
  });

  test("no exemption outlives the gap it explains", () => {
    // An exemption for a subtype that HAS a renderer is stale prose asserting a gap that
    // closed — the same silent-rot the exclusion classifier in registry-manifest-exclusions
    // guards with its liveness tripwire.
    const keys = rendererKeys();
    const stale = Object.keys(NO_RENDERER_BY_DESIGN).filter((s) => keys.includes(s));
    expect(stale).toEqual([]);
    // And an exemption must name a real subtype, not a typo.
    const unknown = Object.keys(NO_RENDERER_BY_DESIGN).filter(
      (s) => !VIEW_SUBTYPES.includes(s as never),
    );
    expect(unknown).toEqual([]);
  });
});

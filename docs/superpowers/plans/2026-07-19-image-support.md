# Image support — Implementation Plan

> **SUPERSEDED on one point (react-easy-crop).** This document was written when
> `react-easy-crop` was an *optional peer* of `@metaobjectsdev/react`. It is now a
> **regular runtime dependency** (still lazy-loaded) — the optional-peer form failed
> to bundle on webpack/Next.js/esbuild/Bun. Current truth: `docs/features/image-upload.md`.
> The historical body below is otherwise unchanged.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a metadata-driven `view.image` form control (upload/crop `<ImageUpload>` widget) to the shared library, backed by a TypeScript-applied `metaobjects-ui-web` concern provider that gives presentation-only view attributes a durable cross-port home — which also un-defers `@rows`.

**Architecture:** Four units. Unit A is the metamodel foundation: a bare `view.image` subtype in core `view.json` + a new `metaobjects-ui-web` provider (`spec/metamodel/ui-web.json`, TS-applied) carrying `@rows` (on `view.textarea`) and `view.image`'s five attrs, mirrored inert to the non-TS ports. Unit B adds runtime image utilities + the adapter contract to `runtime-web`. Unit C adds `<ImageUpload>` + the adapter context provider + `form.css` to `react`. Unit D wires the `formFile` codegen image branch + un-defers `@rows`. Storage stays `field.string` (opaque key) — no cross-language logic.

**Tech Stack:** TypeScript (Bun test runner, ts-poet templates), the `@metaobjectsdev/metadata` provider/registry system, `runtime-web`/`react` client packages, react-easy-crop (optional peer). Design spec: `docs/superpowers/specs/2026-07-19-image-support-design.md`.

## Global Constraints

- **ESM only. No `any`** — use `unknown`/narrow.
- **Named constants for all metamodel strings** — `VIEW_SUBTYPE_IMAGE`, `VIEW_TEXTAREA_ATTR_ROWS`, `VIEW_IMAGE_ATTR_*`, etc. No inline `"image"`/`"rows"`/`"aspectRatio"`.
- **Public repository** — no consumer/other-project names, no home paths, in any committed file/fixture/test/doc/commit message. The reference implementation is "a downstream consumer"; import paths are package names, never `../shared/...`.
- **`@store`, not `@bucket`** — the storage-namespace hint attr is `@store` everywhere (attr name, `ImageMeta.store`, adapter `{ store }`, generated meta).
- **TDD** — failing test first, watch it fail, minimal green.
- **`own*()` accessors forbidden** except a codegen emitting a subclass's own members (ADR-0039). Use `field.views()`, `view.attr(...)`.
- **Storage contract unchanged** — the image field is `field.string`; only the opaque key is stored/wired. No cross-language storage/runtime code.
- **Cross-port atomicity (Unit A)** — the `ui-web.json` + `view.json` edits, the 3 spec-file-list edits, the 2 committed copies, and the regenerated embed/fixtures must land in one commit or `main` goes red.
- **react-easy-crop is an optional peer**, lazy-loaded — non-image consumers pay nothing.

## File Structure

**Unit A — metamodel foundation:**
- Modify: `scripts/generate-embedded-metamodel.ts` — sanitize const name (`-`→`_`) + add `ui-web` concept dir.
- Create: `server/typescript/packages/metadata/src/presentation/ui-web/` (dir must pre-exist for regen).
- Modify: `spec/metamodel/view.json` — add bare `view.image`.
- Create: `spec/metamodel/ui-web.json` — `metaobjects-ui-web` provider (`@rows` + image attrs).
- Modify (copies): `server/csharp/MetaObjects/SpecMetamodel/{view.json,ui-web.json}`, `server/python/src/metaobjects/spec_metamodel/{view.json,ui-web.json}`.
- Modify (spec-file lists): `server/python/src/metaobjects/spec_metamodel/__init__.py`, `server/csharp/MetaObjects/Registry/Spec/SpecMetamodelReader.cs`, `server/java/metadata/src/main/java/com/metaobjects/registry/spec/SpecMetamodelReader.java`.
- Create: `server/typescript/packages/metadata/src/presentation/ui-web/ui-web-provider.ts`; regen `ui-web-definition.embedded.ts`.
- Modify: `server/typescript/packages/metadata/src/core-types.ts` (add `uiWebProvider` to `coreProviders`), `.../presentation/view/view-constants.ts` (constants), `.../test/view-definition-completeness.test.ts` (EXPECTED).
- Create: `server/typescript/packages/metadata/test/ui-web-definition-embed.test.ts` (drift gate).

**Unit B — runtime-web:**
- Create: `client/web/packages/runtime-web/src/{canvas-to-jpeg-blob.ts,reencode-jpeg.ts,image-adapter.ts}`.
- Modify: `client/web/packages/runtime-web/src/index.ts`.
- Test: `client/web/packages/runtime-web/test/reencode-jpeg.test.ts`.

**Unit C — react:**
- Create: `client/web/packages/react/src/{image-upload.tsx,image-adapter-provider.tsx,crop-to-blob.ts}`, `client/web/packages/react/form.css`.
- Modify: `client/web/packages/react/src/index.ts`, `client/web/packages/react/package.json` (exports `./form.css`, `react-easy-crop` optional peer).
- Test: `client/web/packages/react/test/image-upload.test.tsx`.

**Unit D — codegen:**
- Modify: `server/typescript/packages/codegen-ts-react/src/templates/form-file.ts` (image branch + `@rows` un-defer + conditional imports).
- Test: `server/typescript/packages/codegen-ts-react/test/form-image.test.ts`.

---

## Task 1: Metamodel foundation — `view.image` + `metaobjects-ui-web` + `@rows`

**Files:** as under "Unit A" above.

**Interfaces:**
- Produces: `view.image` subtype; the attrs `@rows` (int, `view.textarea`) + `@aspectRatio`(double)/`@maxEdge`(int)/`@store`(string)/`@accept`(string[])/`@maxBytes`(int) (`view.image`); constants `VIEW_SUBTYPE_IMAGE="image"`, `VIEW_TEXTAREA_ATTR_ROWS="rows"`, `VIEW_IMAGE_ATTR_ASPECT_RATIO="aspectRatio"`, `VIEW_IMAGE_ATTR_MAX_EDGE="maxEdge"`, `VIEW_IMAGE_ATTR_STORE="store"`, `VIEW_IMAGE_ATTR_ACCEPT="accept"`, `VIEW_IMAGE_ATTR_MAX_BYTES="maxBytes"` — all consumed by Unit D.

- [ ] **Step 1: Patch the embedded-regen script for a hyphenated concept**

In `scripts/generate-embedded-metamodel.ts`: (a) in `CONCEPT_DIRS` add `"ui-web": "presentation/ui-web",`; (b) fix the const-name derivation (line ~107) to sanitize non-identifier chars:

```ts
const constName = `${name.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}_DEFINITION`;
```

(so `ui-web` → `UI_WEB_DEFINITION`). Create the target dir so the regen doesn't error on a missing directory:

```bash
mkdir -p server/typescript/packages/metadata/src/presentation/ui-web
```

- [ ] **Step 2: Add the bare `view.image` subtype to `spec/metamodel/view.json`**

Append to the `types` array (after the `currency` entry):

```jsonc
    { "type": "view", "subType": "image", "description": "Image upload/display control; the field stores an opaque storage key (field.string)." }
```

- [ ] **Step 3: Create `spec/metamodel/ui-web.json`**

```json
{
  "provider": "metaobjects-ui-web",
  "extends": [
    {
      "type": "view", "subType": "textarea",
      "children": [
        { "type": "attr", "subType": "int", "name": "rows", "min": 0, "max": 1, "description": "Visible row count for the generated <textarea>; the form generator defaults to 4 when absent." }
      ]
    },
    {
      "type": "view", "subType": "image",
      "children": [
        { "type": "attr", "subType": "double", "name": "aspectRatio", "min": 0, "max": 1, "description": "Crop aspect ratio (width / height). Omit for freeform." },
        { "type": "attr", "subType": "int", "name": "maxEdge", "min": 0, "max": 1, "description": "Longest-edge bound in px for the re-encoded output." },
        { "type": "attr", "subType": "string", "name": "store", "min": 0, "max": 1, "description": "Opaque storage-namespace hint passed to the upload adapter (not infrastructure)." },
        { "type": "attr", "subType": "string", "name": "accept", "isArray": true, "min": 0, "max": 1, "description": "Accepted MIME types (client guard; the server re-enforces)." },
        { "type": "attr", "subType": "int", "name": "maxBytes", "min": 0, "max": 1, "description": "Client-side size ceiling in bytes." }
      ]
    }
  ]
}
```

- [ ] **Step 4: Sync the committed C#/Python copies + spec-file lists**

```bash
cp spec/metamodel/view.json spec/metamodel/ui-web.json server/csharp/MetaObjects/SpecMetamodel/
cp spec/metamodel/view.json spec/metamodel/ui-web.json server/python/src/metaobjects/spec_metamodel/
```

Add `"ui-web.json"` to each spec-file list (alphabetical, after `"ui.json"`):
- `server/python/src/metaobjects/spec_metamodel/__init__.py` — the `SPEC_FILES` tuple.
- `server/csharp/MetaObjects/Registry/Spec/SpecMetamodelReader.cs` — the `SpecFiles` array.
- `server/java/metadata/src/main/java/com/metaobjects/registry/spec/SpecMetamodelReader.java` — the `SPEC_FILES` list.

(The C# `.csproj` globs `SpecMetamodel/*.json` — no csproj edit. Java auto-copies from `spec/` — no committed copy. No non-TS provider *applies* `metaobjects-ui-web`.)

- [ ] **Step 5: Add the constants**

In `server/typescript/packages/metadata/src/presentation/view/view-constants.ts`: add `VIEW_SUBTYPE_IMAGE = "image"` to the subtype block, add `image` (as `VIEW_SUBTYPE_IMAGE`) to the `VIEW_SUBTYPES` array, and add the attr constants next to `VIEW_CURRENCY_ATTR_LOCALE`:

```ts
export const VIEW_SUBTYPE_IMAGE = "image";
// ... add VIEW_SUBTYPE_IMAGE into the VIEW_SUBTYPES array ...

/** Visible row count on a view[textarea]. Defaults to 4 when omitted. */
export const VIEW_TEXTAREA_ATTR_ROWS = "rows";
/** view[image] attrs (registered by metaobjects-ui-web). */
export const VIEW_IMAGE_ATTR_ASPECT_RATIO = "aspectRatio";
export const VIEW_IMAGE_ATTR_MAX_EDGE = "maxEdge";
export const VIEW_IMAGE_ATTR_STORE = "store";
export const VIEW_IMAGE_ATTR_ACCEPT = "accept";
export const VIEW_IMAGE_ATTR_MAX_BYTES = "maxBytes";
```

- [ ] **Step 6: Create the `uiWebProvider` and wire it into `coreProviders`**

Create `server/typescript/packages/metadata/src/presentation/ui-web/ui-web-provider.ts` (clone of `ui-provider.ts`):

```ts
import type { MetaDataTypeProvider } from "../../provider.js";
import type { TypeRegistry } from "../../registry.js";
import { applyProviderDefinition } from "../../provider-data.js";
import { UI_WEB_DEFINITION } from "./ui-web-definition.embedded.js";

export const uiWebProvider: MetaDataTypeProvider = {
  id: "metaobjects-ui-web",
  dependencies: ["metaobjects-core-types"],
  description:
    "TS-web presentation view attrs — @rows (view.textarea) and the view.image control attrs. Applied only in TypeScript; the non-TS ports mirror the spec file but never apply this provider (the view subtypes are TS-web presentation-only).",
  registerTypes(registry: TypeRegistry): void {
    applyProviderDefinition(registry, UI_WEB_DEFINITION, {});
  },
};
```

In `server/typescript/packages/metadata/src/core-types.ts`: `import { uiWebProvider } from "./presentation/ui-web/ui-web-provider.js";` and add `uiWebProvider` to the `coreProviders` array (after `uiProvider`).

- [ ] **Step 7: Regenerate the embedded metamodel**

Run (repo root): `bun run scripts/generate-embedded-metamodel.ts`
This writes `server/typescript/packages/metadata/src/presentation/ui-web/ui-web-definition.embedded.ts` (`export const UI_WEB_DEFINITION`) and updates the `view-definition.embedded.ts` (new `image` subtype). Do not hand-edit the embedded files.

- [ ] **Step 8: Write the failing loader test**

Create `server/typescript/packages/metadata/test/view-image-vocab.test.ts`:

```ts
import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "../src/index.js";

async function load(json: unknown) {
  const loader = new MetaDataLoader();
  return loader.load([new InMemoryStringSource(JSON.stringify(json), { id: "t.json" })]);
}

describe("view.image + @rows vocabulary", () => {
  test("a view.image field with all five attrs and a view.textarea @rows load under strict provenance", async () => {
    const { errors } = await load({
      "metadata.root": {
        package: "demo",
        children: [
          { "object.entity": { name: "Doc", children: [
            { "source.rdb": { "@table": "docs" } },
            { "field.long": { name: "id" } },
            { "identity.primary": { name: "id", "@fields": "id", "@generation": "increment" } },
            { "field.string": { name: "notes", children: [{ "view.textarea": { "@rows": 8 } }] } },
            { "field.string": { name: "coverKey", "@maxLength": 80, children: [
              { "view.image": { "@aspectRatio": 1.777, "@maxEdge": 2000, "@store": "photos",
                "@accept": ["image/jpeg", "image/png"], "@maxBytes": 10485760 } }
            ]}},
          ]}},
        ],
      },
    });
    expect(errors).toEqual([]);
  });
});
```

- [ ] **Step 9: Run it to verify it PASSES** (registration already done in Steps 2-7)

Run: `cd server/typescript/packages/metadata && bun test test/view-image-vocab.test.ts`
Expected: PASS (no `ERR_UNKNOWN_ATTR`/`ERR_UNKNOWN_SUBTYPE`). If it FAILS, the provider/subtype wiring is wrong — fix before proceeding.

- [ ] **Step 10: Update the completeness test + add the embed drift gate**

In `server/typescript/packages/metadata/test/view-definition-completeness.test.ts`: change the `EXPECTED` entries and the subtype count:

```ts
  textarea: { rows: { valueType: "int", required: false } },
  // ...
  image: {
    aspectRatio: { valueType: "double", required: false },
    maxEdge: { valueType: "int", required: false },
    store: { valueType: "string", required: false },
    accept: { valueType: "string", required: false },   // string[] — the test compares the element valueType; match the existing convention for array attrs
    maxBytes: { valueType: "int", required: false },
  },
```

(Confirm the array-attr `valueType` convention by how an existing `isArray` attr like `layout.dataGrid.columns` is asserted elsewhere; match it.) Update the "registers all 13 view subtypes" test title/count to 14. The "core registers NO own attrs" assertion is **unchanged** — it composes `coreOnlyRegistry = composeRegistry([coreTypesProvider])`, which excludes `uiWebProvider`, so it stays green (that is the proof the FR-033 invariant holds).

Create `server/typescript/packages/metadata/test/ui-web-definition-embed.test.ts` mirroring `ui-definition-embed.test.ts` (deep-equal `UI_WEB_DEFINITION` to the canonical `spec/metamodel/ui-web.json`).

- [ ] **Step 11: Run the metadata gates**

Run: `cd server/typescript/packages/metadata && bun test test/view-image-vocab.test.ts test/view-definition-completeness.test.ts test/view-definition-embed.test.ts test/ui-web-definition-embed.test.ts`
Expected: PASS.

- [ ] **Step 12: Manifest tripwire — regen expected-registry, assert NO diff**

Run (repo root): `bun run scripts/regen-expected-registry.ts`
Then: `git status --short fixtures/registry-conformance/`
Expected: **no change** to `expected-registry.json` (`view.image` is `PresentationOnly`-excluded; its attrs are on an excluded row). If a diff appears, STOP — `view.image` is leaking into the cross-port manifest and would force 5-port registration; escalate (the design assumed exclusion).

- [ ] **Step 13: Cross-port conformance (mirror is inert)**

Run each (skip a locally-unavailable toolchain; local-ci gates it on push):

```bash
cd server/typescript/packages/metadata && bun test test/registry-conformance.test.ts test/registry-coverage.test.ts
cd server/python && uv run pytest tests/conformance/test_registry_conformance.py tests/conformance/test_spec_metamodel_embed.py -q
cd server/csharp && dotnet test MetaObjects.Conformance.Tests/MetaObjects.Conformance.Tests.csproj --nologo
cd server/java && mvn -pl metadata test -Dtest='RegistryManifestConformanceTest,SpecMetamodelEmbedTest' -q
cd server/java && mvn -pl codegen-kotlin test -Dtest='RegistryManifestConformanceTest' -q
```

Expected: PASS everywhere. The set-equality embed gates (Python/C#) now accept `ui-web.json` (Step 4); the manifest is unchanged (Step 12); no non-TS registry gains `view.image` (inert mirror).

- [ ] **Step 14: Un-defer `@rows` in the form template (foldable here — it's the same registration)**

In `server/typescript/packages/codegen-ts-react/src/templates/form-file.ts`, the `VIEW_SUBTYPE_TEXTAREA` branch of `fieldControlFor` (currently fixed `rows={4}`): read `@rows` off the view child, default 4, and import `VIEW_TEXTAREA_ATTR_ROWS`:

```ts
if (kind === VIEW_SUBTYPE_TEXTAREA) {
  const rows = (field.views()[0]?.attr(VIEW_TEXTAREA_ATTR_ROWS) as number | undefined) ?? 4;
  return labelAndError(
    name,
    `          <textarea aria-label={${entityName}.${name}.label} className="metaobjects-field-input" rows={${rows}} {...form.register("${name}")} />`,
  );
}
```

Update the existing `form-view-dispatch.test.ts` textarea case: a fixture field `{ "view.textarea": { "@rows": 8 } }` renders `rows={8}`; a bare `view.textarea` still renders `rows={4}`.

Run: `cd server/typescript/packages/codegen-ts-react && bun test test/form-view-dispatch.test.ts` → PASS.

- [ ] **Step 15: Commit (atomic cross-port foundation)**

```bash
git add scripts/generate-embedded-metamodel.ts spec/metamodel/view.json spec/metamodel/ui-web.json \
  server/csharp/MetaObjects/SpecMetamodel/view.json server/csharp/MetaObjects/SpecMetamodel/ui-web.json \
  server/python/src/metaobjects/spec_metamodel/view.json server/python/src/metaobjects/spec_metamodel/ui-web.json \
  server/python/src/metaobjects/spec_metamodel/__init__.py \
  server/csharp/MetaObjects/Registry/Spec/SpecMetamodelReader.cs \
  server/java/metadata/src/main/java/com/metaobjects/registry/spec/SpecMetamodelReader.java \
  server/typescript/packages/metadata/src/presentation/ui-web/ \
  server/typescript/packages/metadata/src/core-types.ts \
  server/typescript/packages/metadata/src/presentation/view/view-constants.ts \
  server/typescript/packages/metadata/src/presentation/view/view-definition.embedded.ts \
  server/typescript/packages/metadata/test/view-image-vocab.test.ts \
  server/typescript/packages/metadata/test/view-definition-completeness.test.ts \
  server/typescript/packages/metadata/test/ui-web-definition-embed.test.ts \
  server/typescript/packages/codegen-ts-react/src/templates/form-file.ts \
  server/typescript/packages/codegen-ts-react/test/form-view-dispatch.test.ts
git commit -m "feat(metadata): view.image subtype + metaobjects-ui-web provider (@rows + image attrs)"
```

---

## Task 2: `runtime-web` image utilities + adapter contract

**Files:** create `client/web/packages/runtime-web/src/{canvas-to-jpeg-blob.ts,reencode-jpeg.ts,image-adapter.ts}`; modify `src/index.ts`; test `test/reencode-jpeg.test.ts`.

**Interfaces:**
- Produces: `canvasToJpegBlob(canvas, quality?)`, `reencodeJpeg(file, maxEdge?)`, and the types `ImageUploadAdapter` + `ImageMeta` — consumed by Units C and D.

- [ ] **Step 1: Write `canvas-to-jpeg-blob.ts`** (ported verbatim — zero app coupling)

```ts
export function canvasToJpegBlob(canvas: HTMLCanvasElement, quality = 0.9): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("toBlob returned null"))),
      "image/jpeg",
      quality,
    );
  });
}
```

- [ ] **Step 2: Write `reencode-jpeg.ts`** (ported verbatim)

```ts
import { canvasToJpegBlob } from "./canvas-to-jpeg-blob.js";

/** Whole-image re-encode to JPEG (down-scaled to maxEdge, EXIF stripped via canvas). */
export async function reencodeJpeg(file: File | Blob, maxEdge = 2000): Promise<Blob> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas 2d context unavailable");
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  return canvasToJpegBlob(canvas, 0.9);
}
```

- [ ] **Step 3: Write `image-adapter.ts`** (the genericized contract — `@store`, not app endpoints)

```ts
/** The upload/serve seam a consumer implements for <ImageUpload>. The library ships
 *  no concrete adapter — the app supplies one (see docs). `store` is an opaque
 *  namespace hint from view.image's @store attr, not infrastructure. */
export interface ImageUploadAdapter {
  upload(blob: Blob, opts: { store?: string }): Promise<{ key: string }>;
  imageUrl(key: string): string;
}

/** view.image's declared attrs, resolved into props for <ImageUpload>. */
export interface ImageMeta {
  aspectRatio?: number;
  maxEdge?: number;
  store?: string;
  accept?: string[];
  maxBytes?: number;
}
```

- [ ] **Step 4: Export from `src/index.ts`**

```ts
export { canvasToJpegBlob } from "./canvas-to-jpeg-blob.js";
export { reencodeJpeg } from "./reencode-jpeg.js";
export type { ImageUploadAdapter, ImageMeta } from "./image-adapter.js";
```

- [ ] **Step 5: Write the reencode test** (mock canvas/document per the reference pattern)

Create `test/reencode-jpeg.test.ts` — mirror the reference `reencode-jpeg` test: stub `createImageBitmap` + `document.createElement` (bun: `globalThis.createImageBitmap = ...`), and assert: (a) JPEG type + quality 0.9 passed to `toBlob`, `bitmap.close()` called; (b) 4000×2000 down-scales to 2000×1000 at `maxEdge=2000`; (c) 800×600 stays 800×600 (never upscales); (d) rejects `"toBlob returned null"`; (e) throws `"canvas 2d context unavailable"` when `getContext` returns null.

- [ ] **Step 6: Run + commit**

Run: `cd client/web/packages/runtime-web && bun test test/reencode-jpeg.test.ts` → PASS. Then `bun run --filter '@metaobjectsdev/runtime-web' typecheck`.

```bash
git add client/web/packages/runtime-web/src/ client/web/packages/runtime-web/test/reencode-jpeg.test.ts
git commit -m "feat(runtime-web): image utils (canvasToJpegBlob, reencodeJpeg) + ImageUploadAdapter contract"
```

---

## Task 3: `react` — `<ImageUpload>` + adapter provider + `form.css`

**Files:** create `client/web/packages/react/src/{image-upload.tsx,image-adapter-provider.tsx,crop-to-blob.ts}`, `client/web/packages/react/form.css`; modify `src/index.ts`, `package.json`; test `test/image-upload.test.tsx`.

**Interfaces:**
- Consumes: `ImageUploadAdapter`, `ImageMeta`, `canvasToJpegBlob` (Task 2).
- Produces: `<ImageUpload>`, `<ImageUploadAdapterProvider>`, `useImageUploadAdapter()` — consumed by Unit D's generated import.

- [ ] **Step 1: Write the adapter context provider** (mirror `tanstack/src/entity-fetcher.tsx`)

`src/image-adapter-provider.tsx`:

```tsx
import { createContext, useContext, type ReactNode } from "react";
import type { ImageUploadAdapter } from "@metaobjectsdev/runtime-web";

const ImageUploadAdapterContext = createContext<ImageUploadAdapter | null>(null);

export interface ImageUploadAdapterProviderProps {
  value: ImageUploadAdapter;
  children: ReactNode;
}

export function ImageUploadAdapterProvider({ value, children }: ImageUploadAdapterProviderProps) {
  return <ImageUploadAdapterContext.Provider value={value}>{children}</ImageUploadAdapterContext.Provider>;
}

export function useImageUploadAdapter(): ImageUploadAdapter {
  const adapter = useContext(ImageUploadAdapterContext);
  if (!adapter) {
    throw new Error(
      "useImageUploadAdapter() called outside <ImageUploadAdapterProvider>. " +
        "Wrap your app (or the relevant subtree) with ImageUploadAdapterProvider value={...}.",
    );
  }
  return adapter;
}
```

- [ ] **Step 2: Write `crop-to-blob.ts`** (ported; uses react-easy-crop's `Area` type only, type-only import)

```ts
import type { Area } from "react-easy-crop";
import { canvasToJpegBlob } from "@metaobjectsdev/runtime-web";

export async function cropToBlob(src: string, area: Area, maxEdge: number): Promise<Blob> {
  const img = await new Promise<HTMLImageElement>((res, rej) => {
    const el = new Image();
    el.onload = () => res(el);
    el.onerror = rej;
    el.src = src;
  });
  const scale = Math.min(1, maxEdge / Math.max(area.width, area.height));
  const w = Math.round(area.width * scale);
  const h = Math.round(area.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas 2d context unavailable");
  ctx.drawImage(img, area.x, area.y, area.width, area.height, 0, 0, w, h);
  return canvasToJpegBlob(canvas, 0.9);
}
```

- [ ] **Step 3: Write `<ImageUpload>`** (genericized from the reference — adapter from context, not hard-import; `@store`)

Port the reference `ImageUpload.tsx` (recon §1) with these changes: (a) get the adapter from `useImageUploadAdapter()` instead of `import { uploadImage, imageUrl } from "./imageAdapter"` — call `adapter.upload(blob, { store: meta.store })` and `adapter.imageUrl(value)`; (b) `ImageMeta` is imported from `@metaobjectsdev/runtime-web` (not redefined) and uses `store` (not `bucket`); (c) `react-easy-crop` stays lazy (`const Cropper = lazy(() => import("react-easy-crop"))` + `Suspense`), `Area` type-only import; (d) keep the exact CSS class names (`metaobjects-image-upload`, `metaobjects-image-preview`, `metaobjects-image-actions`, `metaobjects-image-cropper`, `metaobjects-form-submit`, `metaobjects-field-error`); (e) controlled props `{ value?: string | null; onChange: (key: string | null) => void; meta: ImageMeta }`. Keep the Save-error retains-editing behavior and the `maxBytes` client guard.

- [ ] **Step 4: Write `form.css`** (genericized var names — keep the `var(--x, #fallback)` pattern, generic token names)

Port the reference `form.css` (recon §4) with **library-generic** custom-property names — replace the app's branded tokens (`--color-champagne`, `--color-linen`, `--color-lagoon-deep`, `--color-ink`, `--color-champagne-soft`) with neutral names (e.g. `--mo-accent`, `--mo-fg`, `--mo-field-bg`, `--mo-accent-fg`, `--mo-accent-soft`) — each keeping a sensible hex fallback so the file works with zero theme config. Include all the classes: `-form`, `-field`, `-field-label`, `-field-input`, `-field-checkbox`, `-field-radios`, `-field-radio`, `-field-error`, `-image-upload`, `-image-preview`, `-image-actions`, `-form-actions`, `-form-submit`. Place at `client/web/packages/react/form.css` (package root, so the `./form.css` export resolves without a build step).

- [ ] **Step 5: Wire exports + package.json**

`src/index.ts` — add:

```ts
export { ImageUpload, type ImageUploadProps } from "./image-upload.js";
export { ImageUploadAdapterProvider, useImageUploadAdapter, type ImageUploadAdapterProviderProps } from "./image-adapter-provider.js";
export { cropToBlob } from "./crop-to-blob.js";
```

`package.json` — add the CSS subpath export and `react-easy-crop` as an optional peer:

```jsonc
"exports": {
  ".": { "bun": "./src/index.ts", "types": "./dist/index.d.ts", "default": "./dist/index.js" },
  "./form.css": "./form.css"
},
"peerDependencies": { /* ...existing... */, "react-easy-crop": ">=5.0.0" },
"peerDependenciesMeta": { /* ...existing... */, "react-easy-crop": { "optional": true } },
"devDependencies": { /* ...add for tests... */ "react-easy-crop": "^5.0.0" }
```

- [ ] **Step 6: Write the `<ImageUpload>` test**

Create `test/image-upload.test.tsx` (jsdom, `@testing-library/react`): render `<ImageUploadAdapterProvider value={mockAdapter}><ImageUpload value="k1" onChange={onChange} meta={{ store: "photos" }} /></ImageUploadAdapterProvider>` — assert it shows `<img src={mockAdapter.imageUrl("k1")}>`; clicking Remove calls `onChange(null)`; rendering `<ImageUpload>` **without** the provider throws the clear error (assert via a render-error boundary or `expect(() => render(...)).toThrow`). Mock the crop path (`react-easy-crop` is lazy; a full crop→upload flow is covered by the reference's e2e — assert the adapter wiring + controlled behavior here, and note the e2e boundary).

- [ ] **Step 7: Run + typecheck + commit**

Run: `cd client/web/packages/react && bun test test/image-upload.test.tsx` → PASS. Then `bun run --filter '@metaobjectsdev/react' typecheck` (+ install `react-easy-crop` dev dep first if the typecheck needs the type: `bun add -D react-easy-crop --cwd client/web/packages/react`).

```bash
git add client/web/packages/react/src/ client/web/packages/react/form.css client/web/packages/react/package.json client/web/packages/react/test/image-upload.test.tsx
git commit -m "feat(react): <ImageUpload> + adapter context provider + optional form.css export"
```

---

## Task 4: Codegen — `formFile` `view.image` branch

**Files:** modify `server/typescript/packages/codegen-ts-react/src/templates/form-file.ts`; test `test/form-image.test.ts`.

**Interfaces:**
- Consumes: `VIEW_SUBTYPE_IMAGE`, `VIEW_IMAGE_ATTR_*` (Task 1); emits an import of `ImageUpload` from `@metaobjectsdev/react` + `Controller` from `react-hook-form` (Task 3 provides the component).

- [ ] **Step 1: Write the failing render test**

Create `test/form-image.test.ts` — mirror `form-view-dispatch.test.ts`'s harness; fixture entity with a `field.string` carrying a `view.image` child (all 5 attrs, `@store`). Assert `renderFormFile` output: `toContain("<ImageUpload")`, `toContain("Controller")`, `toContain('import { Controller } from "react-hook-form"')`, `toContain('from "@metaobjectsdev/react"')` (the `ImageUpload` import), the meta object carries `aspectRatio`/`maxEdge`/`store`/`accept`/`maxBytes`, and `not.toMatch(/form\.input\.coverKey/)`. Also assert a **non-image** entity emits neither the `ImageUpload` import nor `Controller`-for-image (gated). Run → FAIL.

- [ ] **Step 2: Add the image branch + gated imports**

In `fieldControlFor`, before the final `return scalarBlock(name)`, add (genericized from recon §5 — `@store`, package import):

```ts
if (kind === VIEW_SUBTYPE_IMAGE) {
  const view = field.views()[0];
  const num = (a: string) => { const v = view?.attr(a); return typeof v === "number" ? String(v) : "undefined"; };
  const accept = view?.attr(VIEW_IMAGE_ATTR_ACCEPT) as string[] | undefined;
  const acceptLit = accept ? JSON.stringify(accept) : "undefined";
  const store = view?.attr(VIEW_IMAGE_ATTR_STORE);
  const storeLit = typeof store === "string" ? JSON.stringify(store) : "undefined";
  const meta = `{ aspectRatio: ${num(VIEW_IMAGE_ATTR_ASPECT_RATIO)}, maxEdge: ${num(VIEW_IMAGE_ATTR_MAX_EDGE)}, store: ${storeLit}, accept: ${acceptLit}, maxBytes: ${num(VIEW_IMAGE_ATTR_MAX_BYTES)} }`;
  const control = `          <Controller name=${JSON.stringify(name)} control={form.control} render={({ field: f }) => (
            <ImageUpload value={f.value as string | null} onChange={f.onChange} meta={${meta}} />
          )} />`;
  return labelAndError(name, control);
}
```

Add the gated imports alongside the existing `useFieldArrayImport` idiom:

```ts
const hasImage = fields.some((f) => f.views()[0]?.subType === VIEW_SUBTYPE_IMAGE);
const imageImports = hasImage
  ? `import { Controller } from "react-hook-form";\nimport { ImageUpload } from "@metaobjectsdev/react";\n`
  : "";
```

Thread `imageImports` into `literalImports` next to `useFieldArrayImport`. Import `VIEW_SUBTYPE_IMAGE` + the `VIEW_IMAGE_ATTR_*` constants from `@metaobjectsdev/metadata`.

- [ ] **Step 3: Run to PASS + full suite + typecheck**

Run: `cd server/typescript/packages/codegen-ts-react && bun test` (the new `form-image` test + no regression in `form-view-dispatch`/`nested-value-object-form`/`tph-form`). Then `bun run --filter '*' build && bun run --filter '*' typecheck`.

- [ ] **Step 4: Golden snapshots — regenerate + verify**

The `codegen-ts` golden gate (`packages/codegen-ts/test/golden/`) regenerates from a fixture; if the fixture has no image field the goldens are unaffected, but re-run to be safe:

Run: `cd server/typescript/packages/codegen-ts && bun test test/golden/` — if it fails, regenerate (`UPDATE_GOLDEN=1 bun test test/golden/`) and **inspect the diff** to confirm it's only the intended change (per the golden-gate memory).

- [ ] **Step 5: Commit**

```bash
git add server/typescript/packages/codegen-ts-react/src/templates/form-file.ts \
  server/typescript/packages/codegen-ts-react/test/form-image.test.ts
git commit -m "feat(codegen-ts-react): view.image -> <ImageUpload> via Controller"
```

---

## Task 5: Docs — adapter contract + adopter requirements

**Files:** create `docs/features/image-upload.md`; note in the port docs if needed.

- [ ] **Step 1: Write `docs/features/image-upload.md`**

Document: (a) authoring — `field.string` + `view.image` with the 5 attrs (`@store` explained as an opaque namespace hint); (b) the runtime — wrap the app in `<ImageUploadAdapterProvider value={adapter}>`, implement the `ImageUploadAdapter` contract (`upload(blob, { store }): Promise<{ key }>`, `imageUrl(key): string`); (c) the **expected backend contract** the adapter targets — `POST` multipart → `{ key }`, `GET key → bytes` with an immutable cache, and a **server-side EXIF re-check** (the client canvas re-encode strips EXIF but the server must re-enforce); (d) the CSP requirement — a consumer's `img-src` must include `blob:` (react-easy-crop / `<ImageUpload>` render `blob:` object URLs); (e) `import "@metaobjectsdev/react/form.css"` for default styling; (f) that storage is an opaque key in a `field.string` — no bytes on the wire. Genericize — no consumer/app names, no home paths.

- [ ] **Step 2: Commit**

```bash
git add docs/features/image-upload.md
git commit -m "docs(features): image-upload adapter contract + adopter requirements"
```

---

## Self-Review

**1. Spec coverage:**
- Unit A (view.image + metaobjics-ui-web + @rows + cross-port mirror + tripwire) → Task 1. ✓
- Unit B (runtime-web utils + adapter contract) → Task 2. ✓
- Unit C (ImageUpload + adapter provider + form.css) → Task 3. ✓
- Unit D (codegen image branch) → Task 4. ✓
- Storage contract (field.string, opaque key), adapter backend contract, CSP, form.css opt-in → Task 5. ✓
- `@store` not `@bucket` → Tasks 1/3/4. ✓
- @rows un-defer → Task 1 Step 14. ✓
- Deferred (app server, photo screens, @formExclude route-tier) → correctly absent; documented in the spec. ✓

**2. Placeholder scan:** No "TBD"/"handle edge cases"/"similar to". Code steps show code; run steps show command + expected result. The `<ImageUpload>` and `form.css` ports reference the recon-quoted reference source + the named genericizations (adapter-from-context, generic var names, `@store`) — a faithful port, not a placeholder.

**3. Type consistency:** `ImageUploadAdapter.upload(blob, { store? })` / `imageUrl(key)`; `ImageMeta { aspectRatio?, maxEdge?, store?, accept?, maxBytes? }` (Task 2) — consumed unchanged by `<ImageUpload>` (Task 3) and mirrored in the generated `meta={...}` (Task 4). Constant names (`VIEW_SUBTYPE_IMAGE`, `VIEW_IMAGE_ATTR_*`) defined in Task 1, used in Task 4.

**Dependency note:** Task 4's render test loads a `view.image` fixture — needs Task 1's registration first. Task 4's emitted import references Task 3's `ImageUpload` (string only; doesn't need Task 3 built to render/test). Task 3 consumes Task 2's types. Order: 1 → 2 → 3 → 4 → 5.

**Contingency (Task 1 Step 12):** if `view.image` unexpectedly enters `expected-registry.json`, the `PresentationOnly` exclusion isn't covering it — that would force 5-port registration (a materially larger change); STOP and escalate rather than blessing a cross-port manifest change.

# Image support: `view.image` + `<ImageUpload>` + the `metaobjects-ui-web` provider

> **SUPERSEDED on one point (react-easy-crop).** This document was written when
> `react-easy-crop` was an *optional peer* of `@metaobjectsdev/react`. It is now a
> **regular runtime dependency** (still lazy-loaded) — the optional-peer form failed
> to bundle on webpack/Next.js/esbuild/Bun. Current truth: `docs/features/image-upload.md`.
> The historical body below is otherwise unchanged.

_Design — 2026-07-19_

## Summary

The second of two cycles promoting a proven, test-gated "metadata-driven forms + images"
implementation from a downstream consumer into the shared library. Cycle 1 shipped form-control
view-dispatch + `@formExclude` (`0.18.0`). This cycle adds **image support**: a `view.image` form
control that renders a metadata-driven upload/crop widget, backed by a new **TypeScript-applied
concern provider (`metaobjects-ui-web`)** that gives presentation-only view attributes a durable
cross-port home — which also **un-defers `@rows`** from Cycle 1.

The field itself stays `field.string` (only an opaque storage key is stored and wired), so there
is **no cross-language storage or runtime logic** — image handling is entirely a TypeScript-web
presentation concern.

## Motivation

- Cycle 1 deferred `@rows` because presentation attributes on TS-only view subtypes had no clean
  cross-port home (`ui.json`'s `extends` throws where `view.textarea` is deregistered in the non-TS
  ports; core `view.json` breaks the FR-033 "core owns zero view attrs" invariant). `view.image`
  needs **five** such attributes, so it hits the same wall — harder. This cycle resolves the
  general problem, then builds image support on top.
- The upload/crop UX (`<ImageUpload>`) is proven in a downstream consumer but hard-imports a
  concrete upload adapter, so it must be made adapter-agnostic to be library-safe.

## Decisions already settled

| Decision | Choice | Rationale |
| --- | --- | --- |
| Cross-port home for view attrs | **`metaobjects-ui-web` — a TS-applied concern provider** backed by a new `spec/metamodel/ui-web.json` | Extends the *existing* subtype-level asymmetry (TS registers generic views, non-TS ports don't, manifest excludes them as `PresentationOnly`) to the attr level. FR-033's invariant stays literally green — the attrs live in a concern provider, never core. Adopted after a Fable architecture review of options A–D (re-register cross-port / relax FR-033 / bring-your-own-recipe all rejected). |
| `view.image` subtype | **Bare in core `view.json`** (zero attrs) | Same shape as the other 13 view subtypes; the attrs live in `ui-web.json`. |
| Image-attr naming | **`@store`** (not `@bucket`) | `@bucket` is S3-flavored; `@store` is vendor-neutral for the storage-namespace hint. |
| Adapter injection | **Context provider** (`<ImageUploadAdapterProvider>` + `useImageUploadAdapter()`) | The generated form emits `<ImageUpload>` with no adapter prop, so it must come from context — matching the existing `EntityFetcherProvider` / `CellRendererProvider` pattern in the client packages. |
| Default styling (`form.css`) | **Optional CSS subpath export** `@metaobjectsdev/react/form.css` | Ship the semantic classes with theme-portable `var(--color-*)` fallbacks; adopters opt in with an import. A new packaging pattern, but standard for component libraries. |
| react-easy-crop | **Optional peer dep, lazy-loaded** | Matches the RHF/zod optional-peer idiom; non-image consumers pay nothing. |

## Design

### Unit A — Metamodel foundation (`metaobjects-ui-web`)

The mechanism generalizes the proven per-port *application* asymmetry: the truth (subtypes + attrs)
lives in the shared spec tree; what varies per port is *which provider a port applies*.

- **`spec/metamodel/view.json`** — add a bare `view.image` entry:
  `{ "type": "view", "subType": "image", "description": "Image upload/display control; the field stores an opaque storage key (field.string)." }`.
  Zero attrs. Sync the committed C#/Python `view.json` copies (byte-identity gates; inert there —
  `view.image` is unregistered in those ports, so it is carried but never processed).
- **New `spec/metamodel/ui-web.json`** (provider `metaobjects-ui-web`) — an `extends[]` carrying:
  - `view.textarea` → `@rows` (int).
  - `view.image` → `@aspectRatio` (double), `@maxEdge` (int), `@store` (string), `@accept`
    (string[]), `@maxBytes` (int).
- **TypeScript applies it, nobody else.** Regenerate the embedded metamodel (produces
  `ui-web-definition.embedded.ts`); add a `uiWebProvider` (id `metaobjects-ui-web`, deps
  `["metaobjects-core-types"]`, `applyProviderDefinition(registry, UI_WEB_DEFINITION, {})` — a
  clone of the existing `ui-provider.ts`) and register it in `coreProviders`. Add constants
  (`VIEW_SUBTYPE_IMAGE`, `VIEW_TEXTAREA_ATTR_ROWS`, `VIEW_IMAGE_ATTR_*`) and `image` into
  `VIEW_SUBTYPES`. Add a `ui-web-definition-embed.test.ts` drift gate.
- **Cross-port ports mirror the file but never apply it.** The C#/Python/Java spec loaders enforce
  a set-equality gate over `spec/metamodel/`, so `ui-web.json` must be added to each port's spec
  file list (Python `SPEC_FILES`, C# `SpecFiles` + the csproj embedded-resource list, Java
  `SPEC_FILES`) and `cp`'d to the C#/Python committed copies. **No non-TS provider applies
  `metaobjects-ui-web`** — the directives are parsed but never applied (the registered-target
  throw stays the tripwire if a port ever wires it wrongly).
- **FR-033 invariant stays green.** `view-definition-completeness.test.ts`'s "core registers NO own
  attrs" assertion composes a **core-only** registry (which excludes `ui-web`), so it is unchanged
  and passing. Its per-subtype EXPECTED table gains `textarea: { rows }` and `image: { …5 }`
  (these assert the *effective* registry). Regenerate the `metamodel-docs*` goldens (the new attrs
  become documented — desirable).
- **Conformance manifest unchanged.** `view.textarea`/`view.image` are `PresentationOnly`-excluded,
  so `expected-registry.json` gains nothing. Regen and assert **no diff** (the tripwire).
- **Un-defer `@rows`:** the `codegen-ts-react` `formFile` textarea branch moves from fixed
  `rows={4}` to reading `@rows` off the view child (default 4).

### Unit B — Runtime primitives

- **`@metaobjectsdev/runtime-web`** (zero-React core):
  - `canvasToJpegBlob(canvas, quality = 0.9): Promise<Blob>` — the shared `canvas.toBlob` promise wrapper.
  - `reencodeJpeg(file, maxEdge = 2000): Promise<Blob>` — whole-image re-encode + EXIF-strip.
  - `ImageUploadAdapter` **type** — `{ upload(blob: Blob, opts: { store?: string }): Promise<{ key: string }>; imageUrl(key: string): string }`. (Contract only, no concrete impl — matching how `EntityFetcher` is a contract here.)
  - `ImageMeta` type — `{ aspectRatio?: number; maxEdge?: number; store?: string; accept?: string[]; maxBytes?: number }`.
- **`@metaobjectsdev/react`** (React bindings):
  - `<ImageUpload value onChange meta className? >` — controlled (`value: string | null` storage
    key; `onChange: (key: string | null) => void`), matching the `<CurrencyInput>` idiom: pick →
    react-easy-crop modal (aspect from `meta.aspectRatio`) → canvas re-encode bounded by
    `meta.maxEdge` (strips EXIF) → adapter `upload` → `onChange(key)`; shows the current image via
    `adapter.imageUrl(value)` with Replace/Remove.
  - `<ImageUploadAdapterProvider value={adapter}>` + `useImageUploadAdapter()` — the context seam;
    `<ImageUpload>` reads its adapter from context (throws a clear error if used outside a provider).
  - `cropToBlob(src, area, maxEdge): Promise<Blob>` — the crop-region re-encode helper.
  - **react-easy-crop** is an optional peer dep, lazy-loaded inside the crop modal so non-image
    consumers never load it.
  - **`@metaobjectsdev/react/form.css`** — an optional stylesheet subpath export: the semantic
    classes (`metaobjects-field*`, `metaobjects-form-*`, `metaobjects-image-*`) with theme-portable
    `var(--color-*)` fallbacks. Adopters opt in with `import "@metaobjectsdev/react/form.css"`.

### Unit C — Codegen

- **`codegen-ts-react` `formFile`** — add a `view.image` branch to `fieldControlFor`:
  `<Controller name="<field>" control={form.control} render={({ field }) => <ImageUpload value={field.value ?? null} onChange={field.onChange} meta={{ /* the 5 attrs */ }} />} />`
  (RHF `Controller` for the controlled widget, like the value-object path already uses
  `form.control`). The `<ImageUpload>` + `Controller` imports are emitted **only when the entity
  has an image field** (gated, like the array-of-VO `useFieldArray` import).

## Storage contract (unchanged, cross-language-safe)

The field storing an image is `field.string` (e.g. `@maxLength 80`). Only the opaque object key is
stored in the column and travels on the wire. Bytes are uploaded through a separate multipart
endpoint (the adapter's `upload`); retrieval is a plain `<img src={imageUrl(key)}>`. Replace = a new
key. No other port needs image logic; the metamodel entry buys cross-port codegen no non-TS port
emits, which is exactly why `view.image` + its attrs are TS-applied only.

## Testing (TDD)

- **Unit A** — a strict-mode load of `view.image` with the five attrs and `view.textarea @rows`
  succeeds (no `ERR_UNKNOWN_ATTR`); the `ui-web-definition-embed` drift gate; `expected-registry.json`
  unchanged after regen; `view-definition-completeness` green.
- **Unit B** — `<ImageUpload>` tests: renders the current image from `imageUrl(value)`; pick →
  (mocked crop) → adapter `upload` called with the re-encoded blob → `onChange(key)`; Remove →
  `onChange(null)`; throws outside a provider. `canvasToJpegBlob`/`reencodeJpeg` util tests.
- **Unit C** — a `renderFormFile` fixture with a `view.image` field emits `<ImageUpload>` via
  `Controller` and the gated imports; a non-image entity emits neither; `@rows` now renders
  `rows={<n>}` from the view child.

## Deferred / out of scope

- **App-specific server** — the upload/serve routes (Cloudflare Worker / R2 / EXIF re-check) and
  the bespoke photo-gallery screens stay in the consumer. The upload/serve *contract* (`POST →
  { key }`, `GET key → bytes`, immutable cache, server-side EXIF re-check) is **documented** as the
  adapter's expected backend so adopters can implement it in any stack.
- **`@formExclude` at the route/schema tier** — `@formExclude` is form-only today; hardening the
  generated `UpdateSchema`/routes to honor it is a separate security conversation, not this cycle.
- **The consumer's local `view.image`/`@rows` provider** must be removed when this ships (TS
  `extend` raises `ERR_PROVIDER_ATTR_CONFLICT` on double registration) — a consumer-side
  coordination note, not library work.

## Release framing

Coordinated by mechanism, npm by value: the `ui-web.json` mirror files + spec-file-list entries
must land in all ports atomically (the set-equality gates), but **no non-TS behavior changes** (the
provider is TS-applied; the attrs are inert + manifest-excluded elsewhere). So the substantive value
(image codegen + runtime component + `@rows`) is npm-only, while the metamodel foundation is a
mechanical cross-port mirror. Whether to cut all registries or let the inert mirror ride the next
coordinated bump is a release-timing call made when the work is done. Additive minor everywhere.

## Open questions

None — the cross-port home, `view.image` shape, `@store` naming, adapter seam, `form.css` packaging,
and react-easy-crop handling are all settled above.

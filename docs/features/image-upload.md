# Image upload

`view.image` is a presentation control for a `field.string` that stores an
**opaque storage key**, not image bytes. The generated form renders a
metadata-driven upload + crop control (`<ImageUpload>`) that hands the picked
image to a consumer-supplied adapter and stores only the key the adapter
returns. No image bytes ever cross the MetaObjects wire — the field, the
generated Zod schema, and the REST payload all carry a plain string.

This is a **TS-web-only** feature. The metamodel vocabulary (`view.image` and
its five attrs) is registered by the `metaobjects-ui-web` provider and applied
only in TypeScript; the non-TS ports carry a byte-identical mirror of the spec
file for drift parity but never apply the provider, and none of them ship an
upload widget. A `field.string` authored with a `view.image` child is, to a
Java/Kotlin/C#/Python port, just a plain string field.

## Authoring: `field.string` + `view.image`

Attach a `view.image` child to a `field.string` field. All five attrs are
optional.

```jsonc
{ "field.string": {
    "name": "coverKey",
    "@maxLength": 80,
    "children": [
      { "view.image": {
          "@aspectRatio": 1.777,
          "@maxEdge": 2000,
          "@store": "photos",
          "@accept": ["image/jpeg", "image/png"],
          "@maxBytes": 10485760
      }}
    ]
}}
```

Sigil-free YAML (see [yaml-authoring.md](yaml-authoring.md)):

```yaml
field.string: coverKey
maxLength: 80
children:
  - view.image:
      aspectRatio: 1.777
      maxEdge: 2000
      store: photos
      accept: [image/jpeg, image/png]
      maxBytes: 10485760
```

| Attr | Type | Purpose |
|---|---|---|
| `@aspectRatio` | double | Crop aspect ratio (width / height). Omit for a freeform crop. |
| `@maxEdge` | int | Longest-edge bound in px for the re-encoded output. |
| `@store` | string | Opaque storage-namespace hint passed to the upload adapter. This is a hint the adapter interprets — it is **not** infrastructure configuration, and MetaObjects never talks to a storage backend directly. |
| `@accept` | string[] | Accepted MIME types. This is a client-side guard only — the server must re-enforce it. |
| `@maxBytes` | int | Client-side size ceiling in bytes. Also a guard only — the server must re-enforce it. |

## What the generated form renders

The generated `<Entity>Form` dispatches a `view.image` field to `<ImageUpload>`
wrapped in react-hook-form's `<Controller>` (a bound native `<input>` can't
drive a file-upload control's value/onChange contract). The `Controller` and
`ImageUpload` imports are emitted only when the entity has an image field.

```tsx
<Controller
  name="coverKey"
  control={form.control}
  render={({ field }) => (
    <ImageUpload
      value={field.value as string | null}
      onChange={field.onChange}
      meta={{
        aspectRatio: 1.777,
        maxEdge: 2000,
        store: "photos",
        accept: ["image/jpeg", "image/png"],
        maxBytes: 10485760,
      }}
    />
  )}
/>
```

`<ImageUpload>` renders the current image (via the adapter's `imageUrl`) plus
Upload/Replace/Remove actions. Picking a file opens a lazy-loaded crop UI
(`react-easy-crop`); saving the crop re-encodes the selection to a bounded
JPEG on a `<canvas>` (which strips EXIF as a side effect — see
[Expected backend contract](#expected-backend-contract)) and hands the blob to
the adapter. Only the resulting key is written back through `onChange`.
`<ImageUpload>` is also usable standalone, outside a generated form.

## Runtime wiring: the `ImageUploadAdapter` contract

`<ImageUpload>` has no knowledge of the storage backend, upload endpoint, or
auth — it reads an adapter from React context. Wrap your app (or the relevant
subtree) in `<ImageUploadAdapterProvider>`:

```tsx
import { ImageUploadAdapterProvider } from "@metaobjectsdev/react";
import type { ImageUploadAdapter } from "@metaobjectsdev/runtime-web";

const imageAdapter: ImageUploadAdapter = {
  async upload(blob, { store }) {
    const body = new FormData();
    body.set("file", blob, "image.jpg");
    if (store) body.set("store", store);
    const res = await fetch("/api/images", { method: "POST", body });
    if (!res.ok) throw new Error(`upload failed: ${res.status}`);
    return (await res.json()) as { key: string };
  },
  imageUrl(key) {
    return `/api/images/${key}`;
  },
};

export function App() {
  return (
    <ImageUploadAdapterProvider value={imageAdapter}>
      {/* ... your routes / generated forms ... */}
    </ImageUploadAdapterProvider>
  );
}
```

The contract, exported as a type from `@metaobjectsdev/runtime-web`:

```ts
interface ImageUploadAdapter {
  upload(blob: Blob, opts: { store?: string }): Promise<{ key: string }>;
  imageUrl(key: string): string;
}
```

The library ships **no concrete adapter** — `upload`/`imageUrl` are the seam a
consumer implements against its own backend. `useImageUploadAdapter()` reads
the adapter from context and throws a descriptive error if called outside a
`<ImageUploadAdapterProvider>`.

## Expected backend contract

The adapter is a thin client for a backend you own. That backend is expected
to expose:

1. **`POST` (multipart) → `{ key }`** — accepts the uploaded blob, stores it
   under an object key (optionally namespaced by the `store` hint), and
   returns that opaque key. The generated field stores exactly this string.
2. **`GET <key>` → bytes** with an immutable cache header (e.g.
   `Cache-Control: public, max-age=31536000, immutable`) — a stored image's
   bytes never change in place; a replace produces a new key, so the old key's
   response can be cached forever.
3. **A server-side EXIF re-check.** The client-side crop/upload path
   (`cropToBlob` / `reencodeJpeg` in `@metaobjectsdev/runtime-web`) re-encodes
   the selection through a `<canvas>`, which strips EXIF (orientation, GPS,
   camera metadata) as a side effect of the redraw. That is a client
   convenience, not a security boundary — a malicious or nonstandard client
   can send anything. The backend must independently strip or re-check EXIF
   (and re-validate MIME type / size) on every upload; never trust the client
   re-encode.

MetaObjects does not generate or ship this backend — it is documented so an
adapter can be implemented against any storage/serving stack.

## CSP requirement: `img-src` must allow `blob:`

`<ImageUpload>`'s local preview and the crop UI (`react-easy-crop`) render the
picked file as a `blob:` object URL (`URL.createObjectURL`) before anything is
uploaded. If your app sets a Content-Security-Policy, its `img-src` directive
must include `blob:` or the local preview/crop will be blocked:

```
Content-Security-Policy: img-src 'self' blob: https://your-image-host;
```

## Styling: opt-in `form.css`

Default styling for the generated form controls and `<ImageUpload>` ships as
an optional CSS file:

```ts
import "@metaobjectsdev/react/form.css";
```

It targets stable class names (`metaobjects-form`, `metaobjects-field-*`,
`metaobjects-image-*`, `metaobjects-form-submit`, …) at single-class
specificity so a host app's reset styles win, and resolves colors through
`--mo-*` CSS custom properties with fallback hex values — themable with zero
configuration, override any subset.

`react-easy-crop` is an **optional, lazy-loaded peer dependency** — it's only
imported (via `React.lazy`) when `<ImageUpload>` actually renders the crop UI,
so consumers without a `view.image` field never pay for it. Install it only if
you author one.

## Storage & wire contract

- The field is a plain `field.string` (e.g. `@maxLength 80`); only the opaque
  key is stored in the column and travels on the wire — request bodies,
  response bodies, and the generated Zod schema all see a string, exactly
  like any other string field.
- Image **bytes** flow app → adapter → backend only, over the separate
  multipart/GET endpoints described above. They never pass through a
  MetaObjects-generated route, schema, or the entity's own REST payload.
- Replacing an image is a new upload producing a new key; nothing is mutated
  in place.
- Because the stored value is an ordinary string, no other port needs image
  logic to interoperate with this field — a Java/Kotlin/C#/Python service
  reading or writing the same entity just sees a string column.

## See also

- [field-types.md](field-types.md) — `field.string` and the common field
  attribute reference
- [../ports/typescript-client.md](../ports/typescript-client.md) — the
  broader React/TanStack client surface (`useEntityForm`, `<CurrencyInput>`,
  generated hooks/grids) that `<ImageUpload>` slots into
- [yaml-authoring.md](yaml-authoring.md) — sigil-free YAML authoring front-end

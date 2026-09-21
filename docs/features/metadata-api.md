# The metadata API (`GET /_meta`)

This is the other half of the cross-port contract from
[`docs/features/api-contract.md`](api-contract.md): that page defines how a
client reads and writes **rows**; this page defines how a client discovers
the **shape** of the model that produced those rows — the entities, fields,
types, validators and layouts — without generating any client code first.

Throughout, the worked example is the same `Author` entity used on the
api-contract page.

## The contract

```
GET {apiPrefix}/_meta  →  200 application/json
```

The response body is the loaded model, serialized as that port's **effective**
canonical JSON — the same serialization every port's metadata conformance
corpus already pins. There is one route, for the whole model; there is no
per-entity variant.

## Why effective, not raw

Each port ships two canonical serializations: raw (`extends` left as a
super-reference) and **effective** (the super-chain merge already
materialized). `/_meta` serves effective, and that choice is what keeps the
browser reader small:

- A raw payload would require the browser to resolve `extends` itself to
  answer an attribute read correctly. Per
  [ADR-0039](../../spec/decisions/ADR-0039-own-accessor-discipline.md), an
  own-vs-resolving mistake there is **silent** — it would drop an inherited
  `@columns` / `@pageSize` / `@sortableDefaultOrder` and read back as "unset"
  rather than raising an error, corrupting exactly the attributes a runtime
  grid reads.
- Serving effective moves that resolution to the server, where it is already
  implemented once per port and gated by the shared metadata conformance
  corpus, and turns the browser model into a lookup over an already-resolved
  document — nothing to get wrong.

**The trap:** the effective document still emits the `extends` key on a node
that declared it, even though every member that key once referenced is
already inlined elsewhere in that same node's body. A consumer must ignore
`extends` on read — following it AND reading the already-inlined members
would double-count; treating its presence as "this node has unresolved
members" would be wrong in the other direction. The browser reader
(`loadMetaModel`, below) handles this by construction: it reads only
`@`-prefixed keys as attributes and never looks at `extends` at all.

## Per-port surface

Only TypeScript has a web-bound runtime home, so only TypeScript ships an
HTTP mount. Every other port ships the same one-line serialization helper and
leaves mounting to the host — adding a web framework dependency to a runtime
package for one endpoint would push that dependency onto every consumer of
the package, including consumers with no HTTP surface at all.

| Port | Helper | Mount |
|---|---|---|
| TypeScript (`@metaobjectsdev/runtime-ts`) | `META_ROUTE_PATH`, `META_CONTENT_TYPE`, `metaJson(root)` | **Shipped** — `mountMetaRoute` (`./fastify`) and `mountMetaRouteHono` (`./hono`) |
| C# (`MetaObjects`) | `MetaObjects.MetaEndpoint.MetaRoutePath`, `MetaEndpoint.MetaJson(MetaData root)` | Host mounts — the runtime `MetaObjects` package references only `YamlDotNet` |
| Java (`metaobjects-metadata`) | `com.metaobjects.io.json.MetaEndpoint.META_ROUTE_PATH`, `MetaEndpoint.metaJson(MetaData root)` | Host mounts — `core-spring` carries `spring-context` but no `spring-web` |
| Kotlin | consumes the Java `MetaEndpoint` symbol directly via the `metadata-ktx` facade — there is no separate Kotlin implementation | Host mounts |
| Python (`metaobjects`) | `META_ROUTE_PATH`, `meta_json(root)` (both exported from the package root) | Host mounts — neither `metaobjects.runtime` nor `metaobjects.codegen.runtime` imports a web framework |

The response body is not a new thing to gate: each helper is a thin wrapper
over that port's already-conformance-gated effective serializer
(`canonicalSerializeEffective` / `SerializerJson.CanonicalSerializeEffective`
/ `CanonicalJsonSerializer.canonicalSerializeEffective` /
`canonical_serialize_effective`), so `/_meta`'s bytes ride on the existing
metadata conformance corpus rather than a new one built for this endpoint.
The exact `content-type` header value is a per-port detail, not a pinned
cross-port byte — TypeScript's mounts emit
`application/json; charset=utf-8`; a hand-mounted route in another port is
free to emit `application/json`.

### TypeScript — Fastify

```ts
import { mountMetaRoute } from "@metaobjectsdev/runtime-ts/fastify";

app.register(async (s) => {
  s.addHook("preHandler", requireAuth);
  mountMetaRoute({ fastify: s, root, prefix: "/api" });
});
```

### TypeScript — Hono

```ts
import { META_ROUTE_PATH } from "@metaobjectsdev/runtime-ts";
import { mountMetaRouteHono } from "@metaobjectsdev/runtime-ts/hono";

app.use(`/api${META_ROUTE_PATH}`, requireAuth);
mountMetaRouteHono({ app, root, prefix: "/api" });
```

### C#

```csharp
using MetaObjects;

app.MapGet($"/api{MetaEndpoint.MetaRoutePath}",
           () => Results.Text(MetaEndpoint.MetaJson(root), "application/json"))
   .RequireAuthorization();
```

### Java — Spring

```java
// MetaController.java
import com.metaobjects.io.json.MetaEndpoint;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class MetaController {
  // root: MetaData, wired however this app already provides it elsewhere.
  @GetMapping(value = "/api" + MetaEndpoint.META_ROUTE_PATH,
              produces = MediaType.APPLICATION_JSON_VALUE)
  public String meta() { return MetaEndpoint.metaJson(root); }
}
```

### Kotlin — Spring

```kotlin
// MetaController.kt
import com.metaobjects.io.json.MetaEndpoint
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController

@RestController
@RequestMapping("/api")
class MetaController {
  // Literal path here must match MetaEndpoint.META_ROUTE_PATH ("/_meta").
  @GetMapping("/_meta")
  fun meta(): String = MetaEndpoint.metaJson(root)
}
```

### Python — FastAPI

```python
from fastapi import FastAPI, Response
from metaobjects import META_ROUTE_PATH, meta_json

@app.get(f"/api{META_ROUTE_PATH}")
def meta() -> Response:
    return Response(meta_json(root), media_type="application/json")
```

## Exposure

Mounting `/_meta` is **opt-in** in every port — nothing registers it
implicitly, and a host that wants it guards the route with its own
middleware, the same answer [#367] gives for generated routes (see
[`docs/features/own-your-codegen.md`](own-your-codegen.md)). `/_meta`
publishes the **shape** of the model —
entity names, field names, types, validators, layouts — never row data, but
it is still a disclosure surface and should sit behind whatever
authentication or authorization the rest of the API uses.

## Browser consumption

`@metaobjectsdev/runtime-web` turns a fetched `/_meta` document into the same
read-model `buildGrid()` already consumes:

```ts
import { loadMetaModel, buildGrid } from "@metaobjectsdev/runtime-web";

const model = loadMetaModel(await fetch("/api/_meta").then((r) => r.text()));
const grid = buildGrid(model.object("Author")!);
```

**`object(name)` matches on the short name only.** If the model contains two
same-named objects in different packages, `object()` and `objects()` cannot
tell them apart by name alone — a caller that might see a cross-package
collision should call `objects()` and disambiguate on each result's
`package` field instead.

`loadMetaModel` is a plain structural reader, not a second loader: no
registry, no validation, no `extends` resolution — the server already
validated the model and served it effective, so an attribute read is a map
lookup. It satisfies the same narrow `MetaRead` surface a real `MetaObject`
does, which is what lets `buildGrid()` run unmodified over either one.

This is also why `runtime-web`'s own source imports metadata **values**
only from `@metaobjectsdev/metadata/constants`, never from the metadata
package root: the root barrel exports `MetaDataLoader`, which transitively
imports `node:url` and cannot be bundled for a browser (#287). Type-only
imports (`import type`) from the root are fine — they are erased at build
time — but a single value import from the root reintroduces #287 and is
what `browser-bundleable.test.ts` exists to catch. This constraint governs
code contributed to `runtime-web` itself; it has no bearing on how a
consumer's own application code imports things.

## What's deferred

Per-entity `/_meta` routes, and ETag / cache-control / versioning, are real
questions but are not needed to build a runtime grid and are deliberately
left open rather than answered speculatively. If a large effective payload
turns out to matter in practice, a per-entity route is the planned answer —
not a raw (non-effective) variant of this one.

[#367]: https://github.com/metaobjectsdev/metaobjects/issues/367

## See also

- [`docs/features/api-contract.md`](api-contract.md) — the row-data
  contract this page's model-shape contract complements
- [ADR-0039](../../spec/decisions/ADR-0039-own-accessor-discipline.md) —
  why `attr()`/`children()` must resolve, and why an own-only read is a bug

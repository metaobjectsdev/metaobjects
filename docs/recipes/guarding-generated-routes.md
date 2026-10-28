# Recipe: mount generated routes inside your own auth scope

Generated CRUD routes are **unauthenticated**. Nothing in the metamodel says otherwise and
nothing should: whether a caller may act is not derivable from a model, so there is no `@auth`
attribute. You guard the routes with your framework's own composition. No edit to the generated
file is needed.

This is the same recipe the generated routes file prints in its handler's JSDoc. Both
snippets below are exercised against the real mount helpers by
`server/typescript/packages/runtime-ts/test/route-auth-seam.test.ts`; the text is produced by
`authSeamJsDoc` in `server/typescript/packages/codegen-ts/src/routes-expose.ts`. If you change a recipe's shape,
change that test first.

## Fastify

Register the generated handler inside a scope that carries your hook. Fastify hooks are
encapsulated per plugin and inherited by child scopes, so the hook reaches through the generated
handler's own `register(..., { prefix })`:

```ts
import { noteRoutes } from "./generated/Note.routes.js";

app.register(async (s) => {
  s.addHook("preHandler", requireAuth);   // your hook: 401 without credentials
  await noteRoutes(s);                    // Fastify spells it `<entity>Routes`
});

app.get("/health", async () => ({ ok: true }));   // outside the scope: stays open
```

Every verb (list, get, create, update, delete) is guarded. Routes registered outside the scope
are not. Use `preHandler`, not `onRequest`, if your check needs the parsed body.

## Hono

Put middleware on the mount path **with a trailing `/*`**, before calling the generated
register function:

```ts
import { registerNoteRoutes } from "./generated/Note.routes.hono.js";

app.use(`/api${Note.$path}/*`, requireAuth);   // `${apiPrefix}${Entity.$path}/*`
registerNoteRoutes(app, { db });
```

The wildcard is load-bearing: in Hono `"/api/notes/*"` also matches the collection path
`/api/notes` itself, so one `app.use` covers list and create as well as every `/:id` route.
Without it, `GET /api/notes` and `POST /api/notes` stay open while the recipe looks right.
Order matters: `app.use` must be registered **before** the routes it should guard.

## Narrow what is mounted with `expose`

A guard answers "is this caller authenticated?". It cannot answer "may this caller see **this
row**". For an entity holding credentials, per-user rows, or anything a list endpoint would hand
to the wrong person, stock CRUD is not safe at any verb. Hand-write those verbs and narrow the
generated file to what remains:

```ts
import { routesFile, routesFileHono } from "@metaobjectsdev/codegen-ts/generators";

generators: [
  routesFile({ expose: ["list", "get"] }),        // Fastify
  routesFileHono({ expose: ["list", "get"] }),    // Hono
]
```

`expose` takes any subset of `"list" | "get" | "create" | "update" | "delete"`, or a function
`(entity) => verbs | undefined` to choose per entity (`undefined` means all five). An unlisted verb
is not mounted at all: with `expose: ["list", "get"]` a `POST /api/notes` answers 404, whatever
the caller's credentials. A discriminated-union base and a read-only projection are already
narrower than the five verbs, and `expose` can only narrow them further, never widen. `expose`
is a generator option, not metadata, because which verbs a deployment serves is a property of
the app and not of the shared model.

## What was checked

- The runtime-ts test above asserts, for both frameworks, `401` on all five verbs without the
  header, `200` with it, and that a sibling route outside the guarded scope stays open.
- A model generated with `routesFile({ expose: ["list", "get"] })` and
  `routesFileHono({ expose: ["list", "get"] })` emits `expose: ["list", "get"]` in the mount call.
  Run against in-memory SQLite behind the Hono recipe: `GET /api/notes` answered 401 without
  credentials and 200 with them, and `POST /api/notes` and `DELETE /api/notes/1` answered 404
  with them.

See also: [TypeScript port, Hono variant](../ports/typescript.md#hono-variant-workers--bun--edge),
[Cloudflare Workers](cloudflare-workers.md).

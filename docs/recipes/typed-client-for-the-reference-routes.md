# A typed fetch client for the reference routes

You run the stock `entity`, `queries` and `routes` generators, which give you a database
schema, queries and a Fastify API. Nothing types the **caller** of that API. This recipe
writes one owned generator that does: per entity, a client for exactly the routes `routes`
mounts, typed with the `X`, `XCreate`, `XPatch` and `XFilter` types the `entity` generator
already wrote. Rename a field and the client's call sites stop compiling.

Every block below was run: generate, `tsc`, a smoke call against the real Fastify routes, then a
model change that `meta verify --codegen` convicts. Output shown is output seen, on the 1.1.4
packages.

## Install

The stock generated files import `drizzle-orm`, `zod`, `fastify` and a database driver, and the
routes import `@metaobjectsdev/runtime-ts`. They are optional peers of those packages, so
`npm` does not add them for you. This pair compiles the generated TypeScript from a clean
project (SQLite shown):

```bash
npm init -y && npm pkg set type=module
npm i -D @metaobjectsdev/cli @metaobjectsdev/codegen-ts @metaobjectsdev/metadata typescript @types/better-sqlite3
npm i @metaobjectsdev/runtime-ts drizzle-orm zod fastify better-sqlite3
```

For Postgres swap the driver: `@types/pg` in the first line, `pg` in the second (and
`dialect: "postgres"`). Both were installed into an empty directory and the generated tree
compiled with `tsc` under `"module": "nodenext", "strict": true`. Dropping `fastify` or `zod`
fails with `TS2307: Cannot find module`. Run the smoke script with `npx tsx` (`npm i -D tsx`).

## The model

Two entities with a relationship. `@filterable` is what puts a field in the list route's filter
allowlist, and in the `XFilter` type:

```json
{
  "metadata.root": {
    "package": "acme::shop",
    "children": [
      { "object.entity": { "name": "Customer", "children": [
        { "source.rdb": { "@table": "customers" } },
        { "field.long":   { "name": "id" } },
        { "field.string": { "name": "name", "@required": true } },
        { "field.string": { "name": "email" } },
        { "relationship.composition": { "name": "orders", "@objectRef": "Order", "@cardinality": "many", "@onDelete": "cascade" } },
        { "identity.primary": { "@fields": "id", "@generation": "increment" } }
      ] } },
      { "object.entity": { "name": "Order", "children": [
        { "source.rdb": { "@table": "orders" } },
        { "field.long":   { "name": "id" } },
        { "field.int": { "name": "total", "@required": true, "@filterable": true } },
        { "field.boolean": { "name": "paid", "@filterable": true } },
        { "field.long": { "name": "customerId", "@required": true, "@filterable": true } },
        { "identity.primary": { "@fields": "id", "@generation": "increment" } },
        { "identity.reference": { "name": "fkCustomer", "@fields": "customerId", "@references": "Customer", "@onDelete": "cascade" } }
      ] } }
    ]
  }
}
```

## The stock generators, and what they really mount

```ts
import { defineConfig } from "@metaobjectsdev/cli";
import { entityFile, queriesFile, routesFile } from "@metaobjectsdev/codegen-ts/generators";
import { fetchClientGenerator } from "./codegen/generators/fetch-client.js";

export default defineConfig({
  outDir: "src/generated",
  dialect: "sqlite",
  apiPrefix: "/api",
  dbImport: "./db",
  generators: [entityFile(), queriesFile(), routesFile(), fetchClientGenerator()],
});
```

`routesFile()` needs `dbImport`: the module that exports `db`. `meta gen` fails and says so if
it is missing. Write `src/generated/db.ts` yourself (it is not generated; an in-memory database keeps the smoke script repeatable):

```ts
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
export const sqlite = new Database(":memory:");
export const db = drizzle(sqlite);
```

What `routesFile()` mounts for each entity with a writable source, read from the generated
`Order.routes.ts` and the runtime it calls. The smoke run below exercises list, get, create,
update and delete, plus a 404, a 409 and a 400. `apiPrefix` is the mount
prefix, and `servedPath(obj, apiPrefix)` is the helper that composes it with the object's path
(`/orders`):

| Call | Route | Success | Failure seen |
|---|---|---|---|
| list | `GET /api/orders` | `200`, a JSON array | `400 {"error":"invalid_filter_value",...}` |
| get | `GET /api/orders/:id` | `200`, the row | `404 {"error":"not_found"}`, `400 {"error":"invalid_id"}` |
| create | `POST /api/orders` | `201`, the row | `409 {"error":"constraint_violation","constraint":"foreign_key"}` |
| update | `PATCH /api/orders/:id` (`PUT` too: both are mounted) | `200`, the row | `404 not_found` |
| delete | `DELETE /api/orders/:id` | `204`, no body | `404 not_found` |

List query encoding: `filter[<field>][<op>]=<value>` (a bare `filter[total]=5` is not a filter;
the client sends `[eq]`), an `in` list comma-joined (`filter[total][in]=5,50`), `or` and `and`
as `filter[or][0][paid][eq]=true`, `sort=<field>:asc|desc`, and `limit` and `offset` as plain
integers. The operators a field takes are in the generated `<Entity>FilterAllowlist`, and the
`XFilter` type is derived from it.

## The generator

`meta generator new fetch-client` scaffolds `codegen/generators/fetch-client.ts` and wires its
import and entry into `metaobjects.config.ts`. Replace the body with this. It emits one shared
runtime file plus one `X.client.ts` per entity, next to the entity module it imports types from:

```ts
// fetch-client: a typed fetch client for exactly the routes the stock `routes` generator mounts.
import {
  entityOutputPath, isAbstract, servedPath, servesWriteApi, type EmittedFile, type Generator,
} from "@metaobjectsdev/codegen-ts";

// One shared runtime file: how a filter becomes a query string, and the error a non-2xx throws.
const RUNTIME = `// @generated by fetch-client
export class ApiError extends Error {
  constructor(readonly status: number, readonly body: unknown) { super(\`HTTP \${status}\`); }
}
export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** filter[total][gt]=5, filter[total][in]=1,2, filter[or][0][paid][eq]=true; limit/offset/sort stay top level. */
export function toQuery(f: Record<string, unknown> = {}): string {
  const out: string[] = [];
  const add = (k: string, v: unknown) => out.push(\`\${k}=\${encodeURIComponent(String(v))}\`);
  const walk = (node: Record<string, unknown>, prefix: string) => {
    for (const [k, v] of Object.entries(node)) {
      if (v === undefined) continue;
      if ((k === "or" || k === "and") && Array.isArray(v)) {
        v.forEach((sub, i) => walk(sub as Record<string, unknown>, \`\${prefix}[\${k}][\${i}]\`));
      } else if (v !== null && typeof v === "object") {
        for (const [op, x] of Object.entries(v)) if (x !== undefined) add(\`\${prefix}[\${k}][\${op}]\`, Array.isArray(x) ? x.join(",") : x);
      } else add(\`\${prefix}[\${k}][eq]\`, v);
    }
  };
  const { limit, offset, sort, ...filter } = f;
  walk(filter, "filter");
  for (const [k, v] of Object.entries({ limit, offset, sort })) if (v !== undefined) add(k, v);
  return out.length ? \`?\${out.join("&")}\` : "";
}

export async function call<T>(f: Fetch, method: string, url: string, body?: unknown): Promise<T | null> {
  const res = await f(url, { method, headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body) });
  if (res.status === 404 && method === "GET") return null;
  if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => undefined));
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}
`;

export function fetchClientGenerator(): Generator {
  return {
    name: "fetch-client",
    filter: (obj) => !isAbstract(obj) && servesWriteApi(obj), // the entities `routes` mounts all five verbs for
    generate: (ctx): EmittedFile[] => {
      const layout = ctx.config.outputLayout ?? "flat";
      const prefix = ctx.renderContext?.apiPrefix ?? "";   // the same apiPrefix routesFile mounts under
      const files: EmittedFile[] = [{ path: "fetch-client.runtime.ts", content: RUNTIME }];
      for (const obj of ctx.entities.filter(ctx.matches)) {
        const n = obj.name, path = servedPath(obj, prefix);
        // Types come from the entity module `entity` wrote next to this file (flat layout).
        files.push({
          path: entityOutputPath(layout, undefined, `${n}.client.ts`),
          content: `// @generated by fetch-client
import type { ${n}, ${n}Create, ${n}Filter, ${n}Patch } from "./${n}.js";
import { call, toQuery, type Fetch } from "./fetch-client.runtime.js";

export function ${n[0]!.toLowerCase()}${n.slice(1)}Client(baseUrl = "", f: Fetch = fetch) {
  const url = (rest = "") => \`\${baseUrl}${path}\${rest}\`;
  return {
    list: (filter?: ${n}Filter) => call<${n}[]>(f, "GET", url(toQuery(filter)))
      .then((r) => r ?? []),
    get: (id: ${n}["id"]) => call<${n}>(f, "GET", url(\`/\${id}\`)),            // null on 404
    create: (body: ${n}Create) => call<${n}>(f, "POST", url(), body),         // 201
    update: (id: ${n}["id"], body: ${n}Patch) => call<${n}>(f, "PATCH", url(\`/\${id}\`), body),
    delete: (id: ${n}["id"]) => call<void>(f, "DELETE", url(\`/\${id}\`)),     // 204
  };
}
`,
        });
      }
      return files;
    },
  };
}
```

Three choices worth knowing. It filters with `servesWriteApi`, the question the stock routes
generator asks, so the client covers exactly the entities that have all five routes. It reads
`ctx.renderContext?.apiPrefix`, the config value `routesFile()` mounts under, so the two
cannot disagree. And it writes beside `entity`'s output with `entityOutputPath`, which follows
`outputLayout`.

`get` returns `null` on a 404 and `list` returns the array; any other non-2xx throws
`ApiError` carrying the status and the parsed body. The client does not use the list route's
count flag. The generated row types are the database row types, so a `date` or `decimal` field
arrives as its JSON form, not as the Drizzle value: type those yourself if you have them.

## Prove it

```bash
npx meta gen
npx tsc -p tsconfig.json                 # exit 0: the entity, queries, routes and client all compile
npx tsc -p tsconfig.codegen.json         # exit 0: the generator itself
npx meta verify --codegen                # exit 0
```

A smoke script that starts the real routes and calls them through the client:

```ts
import Fastify from "fastify";
import { sqlite } from "./src/generated/db.js";
import { customerRoutes } from "./src/generated/Customer.routes.js";
import { orderRoutes } from "./src/generated/Order.routes.js";
import { customerClient } from "./src/generated/Customer.client.js";
import { orderClient } from "./src/generated/Order.client.js";
import { ApiError } from "./src/generated/fetch-client.runtime.js";

sqlite.exec(`create table customers (id integer primary key autoincrement, name text not null, email text);
create table orders (id integer primary key autoincrement, total integer not null, paid integer, customer_id integer not null references customers(id));`);
const app = Fastify();
await app.register(customerRoutes); await app.register(orderRoutes);
const base = await app.listen({ port: 0 });
const customers = customerClient(base), orders = orderClient(base);
const c = await customers.create({ name: "Ada" });
console.log("created", c);
for (const t of [5, 20, 50]) await orders.create({ total: t, customerId: c.id! , paid: t > 10 });
console.log("gt 10 sorted desc:", await orders.list({ total: { gt: 10 }, sort: "total:desc" }));
console.log("in [5,50] page:", await orders.list({ total: { in: [5, 50] }, limit: 1, offset: 1 }));
console.log("or:", (await orders.list({ or: [{ total: 5 }, { paid: true }] })).map((o) => o.total));
console.log("patch:", await orders.update(1, { paid: true }));
console.log("get 999:", await orders.get(999));
await orders.delete(1);
console.log("after delete:", (await orders.list()).length);
try { await orders.create({ total: 1, customerId: 999 }); } catch (e) { console.log("fk error:", e instanceof ApiError, (e as ApiError).status, JSON.stringify((e as ApiError).body)); }
try { await orders.list({ total: { gt: 1.5 } }); } catch (e) { console.log("bad filter:", (e as ApiError).status, JSON.stringify((e as ApiError).body)); }
await app.close();
```

```text
created { id: 1, name: 'Ada', email: null }
gt 10 sorted desc: [
  { id: 3, total: 50, paid: true, customerId: 1 },
  { id: 2, total: 20, paid: true, customerId: 1 }
]
in [5,50] page: [ { id: 3, total: 50, paid: true, customerId: 1 } ]
or: [ 5, 20, 50 ]
patch: { id: 1, total: 5, paid: true, customerId: 1 }
get 999: null
after delete: 2
fk error: true 409 {"error":"constraint_violation","constraint":"foreign_key"}
bad filter: 400 {"error":"invalid_filter_value","field":"total","op":"gt","expected":"integer (a whole number)"}
```

## The drift gate covers it

`verify --codegen` re-runs every generator in `generators`, yours included. Rename `total` to
`amount` in the model and do not regenerate:

```text
meta verify --codegen          exit 1
  ~ src/generated/Order.ts (committed content differs from a fresh regen)
  Run 'meta gen' to regenerate, then commit the result.
```

The type module is stale, and once regenerated `orders.list({ total: ... })` fails `tsc`. A
rename does not change the client files themselves, since they hold no field names. A change
to what they do hold does. Changing `apiPrefix` to `/v1` without regenerating:

```text
meta verify --codegen          exit 1
  ~ src/generated/Customer.client.ts (committed content differs from a fresh regen)
  ~ src/generated/Customer.routes.ts (committed content differs from a fresh regen)
  ~ src/generated/Order.client.ts (committed content differs from a fresh regen)
  ~ src/generated/Order.routes.ts (committed content differs from a fresh regen)
```

The client and the routes move together or the build fails. Commit
`.metaobjects/.gen-state/.hashes.json` so a fresh clone can tell a hand edit from stale output.

## See also

- [Write your own generator](write-your-own-generator.md), including when to set `handEdits: "overwrite"`.
- [Own your codegen](../features/own-your-codegen.md)
- [API contract](../features/api-contract.md): the routes, filters and errors every port serves.

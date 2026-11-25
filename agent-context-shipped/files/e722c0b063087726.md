---
name: metaobjects-runtime-ui
description: Use when wiring MetaObjects generated code into an app — calling or serving the generated REST API (collection URLs, filters, sort, pagination, wire format), runtime queries and CRUD, and the web client (fetcher and base URL, forms, grids).
---

# Wiring MetaObjects runtime + web client

How generated code is put to work: querying and persisting through the runtime tier, serving
the REST contract, and consuming it from the web client. The contracts here hold in every port;
the imports and types for this project's stack are in the reference files.

## Essentials

- **Read your stack's reference file before wiring anything.** This file has the contracts;
  the names you type (imports, generated symbols, generator names) are per language.
- **Generated finders and CRUD helpers take the persistence context as a parameter.** They
  never import a module-level `db`, so you own the connection and pass it in.
- **A table or column name comes from the generated names artifact, never a string literal.**
  `@column` is free-form, so a name guessed from the field is wrong silently. The artifact is
  opt-in: check it exists first.
- **A collection URL is the entity NAME `snake_case`d, then pluralized** (`PostCategory` →
  `/post_categories`), never the physical table.
- **Currency is integer minor units on the wire.** Format it in the client; never do float
  arithmetic on it.
- **The client's base URL is `baseUrl` on the fetcher provider, not the server's `apiPrefix`.**
  Omit it and every generated hook drops the prefix while compiling clean.
- **Grids are opt-in per entity** (`layout.dataGrid`). No grid files for an entity without one
  is expected, not a broken build.

## Reference files — open the ones for your stack

Only the files for the servers and clients in this project's stack are installed.

| File | Open it when |
|---|---|
| `references/typescript.md`, `references/java.md`, `references/kotlin.md`, `references/csharp.md`, `references/python.md` | the project's server language is that one: the runtime and REST specifics |
| `references/react.md` | the web client is React |
| `references/tanstack.md` | the web client uses TanStack Query or Table (grids, hooks, filters) |

## The runtime returns native types

A port's runtime returns the language's own in-process types, never wire strings:

- `field.decimal` → the exact-decimal type (`BigDecimal` / `decimal` / `Decimal`), lossless end
  to end. **TypeScript is the exception: `field.decimal` is a `string`**, because JS has no
  exact decimal.
- temporal fields → native date and instant types.
- `field.object` (jsonb) → a native map or object.

Wire encoding (integer minor units, ISO-8601 strings, canonical UUID hex) is applied only where
a row leaves over HTTP. Compute with native types in-process and let the HTTP layer encode.

## The persistence context is a parameter

```
const rows = await findPostsForAuthor(db, authorId);   // db is passed, not imported
```

That keeps generated code free of global state, testable, and able to talk to more than one
database (tenants, a read replica). Build the context in your app and thread it through every
generated call.

## Physical names come from the names artifact

The runtime tier is where you write the code codegen leaves to you (a repository, a raw query,
a migration script), and that is where a table or column name gets respelled. A physical name
is declared once, in metadata (`@table` / `@view` / `@column` / `@schema`), and every port can
emit it per object: `ProgramNames.fields.createdAt.column` on TypeScript,
`ProgramNames.CreatedAtColumn` on C#, `ProgramNames.CREATED_AT_COLUMN` on the JVM,
`PROGRAM_CREATED_AT_COLUMN` on Python. Reference that. A literal is a second spelling of a fact
the metadata owns: rename the column in metadata and the constant follows, the literal does
not, and nothing reports it. `callPurpose` may well live in `purpose_code`.

**Prefer a typed handle where one exists.** A Drizzle column object, an Exposed `Column` or an
EF Core property is checked against the schema at compile time; a string constant is not. The
constants are for the places with no handle: raw SQL, a string-keyed query builder, and a
hand-written repository on a port whose generated model has no persistence binding (Java,
Python). Your server reference names both for this stack.

**Check the artifact exists first.** No port generates it by default: every port's generator
list is the complete list, and upgrading never edits a config written earlier. Look for
`<Entity>.names.ts` / `<Entity>Names` in the generated output. If it is missing, wiring the
`names` generator is the first step (the `metaobjects-codegen` skill says how), not writing the
literal because there is no constant.

## The REST contract

Generated routes, and hand-written ones that want the same clients, speak one HTTP contract in
every port, so one web client serves any backend language.

### URLs

`apiPrefix` in the project config is where the server mounts the routes. The collection segment
is the entity name `snake_case`d and then pluralized, derived from the name and never from
`@table`:

| Name | Segment | Rule |
|---|---|---|
| `Author` | `authors` | a single regular word takes `s` |
| `PostCategory` | `post_categories` | multi-word: the capitals carry the word boundary |
| `Address` | `addresses` | ending `s`/`x`/`z`/`ch`/`sh` takes `es` |
| `Category` | `categories` | consonant + `y` becomes `ies` |
| `Day` | `days` | a vowel before the `y` does not |
| `HTTPServer` | `http_servers` | a run of capitals stays together until the last one that begins a word |

An `object.projection` and a view-backed `object.report` use the same rule (`OrderSummary` is
`/order_summaries`). A report has a list route only and, in TypeScript, a list hook named `use`
+ the plural of its name (`useMemberUtilizations`; `use<Report>List` when the plural is the
name itself); it has no grid, form or detail hook. Before 1.0 the ports spelled multi-word and
irregular names differently (`/order-summaries`, `/ordersummaries`, `/ordersummarys`); those
spellings now 404, so a client written against one has to follow.

| Verb | Path | Purpose |
|---|---|---|
| `GET` | `/<apiPrefix>/<entity>?filter[...][...]=...&sort=...&limit=N&offset=N&withCount=1` | List |
| `GET` | `/<apiPrefix>/<entity>/:id` | Get by id |
| `POST` | `/<apiPrefix>/<entity>` | Create (201) |
| `PATCH` | `/<apiPrefix>/<entity>/:id` | Partial update |
| `PUT` | `/<apiPrefix>/<entity>/:id` | The same partial update as `PATCH`, not a replace |
| `DELETE` | `/<apiPrefix>/<entity>/:id` | Delete (204) |

### Filters, by field subtype

`filter[<field>][<op>]=<value>`; a bare `filter[<field>]=<value>` means `eq`. The generated
`<Entity>FilterAllowlist` gates the operators by subtype, and an operator a field does not
support is HTTP 400.

| Operator | Strings | Numbers / Dates | Booleans |
|---|---|---|---|
| `eq`, `ne`, `isNull` | yes | yes | `eq` + `isNull` only |
| `in`, `like` | yes | `in` only | – |
| `gt`, `gte`, `lt`, `lte` | – | yes | – |

These nine are the whole set, in every port. `like` is case-sensitive SQL `LIKE`: the caller
supplies `%` and `_`.

### Sort and pagination

- `sort=<field>:asc|desc`: one sort key, which must be in `<Entity>SortAllowlist`.
- `limit=N` / `offset=N`.
- `withCount=1` changes the list body from `[<row>...]` to `{ rows: [...], total: N }` (grids
  always send it).

### Wire format

JSON bodies. A single-row response (`GET /:id`, `POST`, `PATCH`, `PUT`) has no envelope: the
body is the row.

| Field type | JSON | Notes |
|---|---|---|
| `field.string` / `field.uuid` / `field.enum` | string | UUID is canonical hex `8-4-4-4-12` |
| `field.int` / `field.long` / `field.double` | number | `long` may be a string on overflow (per port) |
| `field.boolean` | boolean | |
| `field.date` | string | ISO 8601 `YYYY-MM-DD` |
| `field.timestamp` | string | ISO 8601 with timezone |
| `field.currency` | **integer minor units** | cents, yen; the server never formats it |
| `field.object` | object | per the value object's schema |

Errors are `{ "error": "<short_code>", "message"?: "..." }`: 400 for a validation or filter
error, 404 `not_found`, 409 for a unique or foreign-key conflict. Treat a 4xx as user-facing
and a 5xx as retryable.

## The web client: one fetcher, one base URL

The client never calls `fetch` directly. Every generated hook delegates to one `EntityFetcher`
you supply at the app root:

```ts
export type EntityFetcher = <T>(path: string, init?: RequestInit) => Promise<T>;
```

```tsx
<EntityFetcherProvider fetcher={fetcher} baseUrl="/api">
```

Generated hooks pass an entity-relative path (`/customers`) and the provider prepends
`baseUrl`. The base URL is a deployment fact (a separate API host, a dev proxy, a preview
environment), which is why it is supplied at runtime and not generated from the server's
`apiPrefix`. It defaults to `""`, which is right only when the server mounts at the root.
Your fetcher attaches auth, parses the JSON, and **throws on a non-2xx response**: the hooks
rely on the throw for their error state. Grids, forms, the filter serializer and the cell
renderers all sit on this one seam.

## Grids are opt-in per entity

Read and CRUD hooks are generated for every entity. Grid artifacts are generated only for an
entity that declares a `layout.dataGrid` child, and `meta gen` says so in its warnings:

```jsonc
{ "layout.dataGrid": { "name": "default", "@columns": ["name", "email"] } }
```

A generated grid component is fully controlled: it needs row-count, sort, pagination and
filter state on top of the column definitions. Pair the columns generator with the grid-hook
generator, which emits that state plumbing. Your client's reference has the generator names
and a rendered example.

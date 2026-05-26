# RoutesGenerator — known gaps vs cross-port API contract

Tracks where `RoutesGenerator.cs` does not yet match
[`docs/features/api-contract.md`](../../../../docs/features/api-contract.md).
Update when a gap closes or a new one surfaces.

## Conformed today (Tier 1)

- `GET /api/<entity>` list, `GET /:id`, `POST`, `PATCH /:id`, `PUT /:id`, `DELETE /:id` mount under `apiPrefix` (default `/api`); entity segment is lowercased + pluralized.
- `?limit=N&offset=N` pagination — honoured on the list route.
- `?sort=<field>:asc|desc` — honoured against a per-entity static `SortAllowlist` derived from scalar fields. Unknown field returns 400 `{ "error": "validation", "message": "unknown sort field: ..." }`.
- `?withCount=1` — switches the list envelope from `[<row>...]` to `{ rows, total }`. The grid hook always sends this.
- Both `PATCH` and `PUT` map to the same update handler (TS reference exposes both verbs; C# now matches).
- 404 carries a JSON envelope: `{ "error": "not_found" }`.
- Projection (`source.dbView`) routes are read-only — only `GET` list + `GET /:id` are mounted; no `POST` / `PATCH` / `PUT` / `DELETE`.
- HTTP status codes: `200` / `201` (POST) / `204` (PATCH/PUT/DELETE) / `400` (validation) / `404` (not found).
- Sort dispatch uses `EF.Property<object>(x, "<Name>")` — no runtime reflection (AOT-safe).

## Gaps

### G1 — Filter operators (8) not yet implemented

**Contract.** The 8 filter operators (`eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`, `like`, `isNull`) gated by field subtype, encoded as `filter[<field>][<op>]=<value>`, with sugar form `filter[<field>]=<value>` for `eq`. Reference: [`api-contract.md` "Filter operators (8)"](../../../../docs/features/api-contract.md).

**Today.** Any `filter[...]` keys in the qs are **silently ignored** by the generated handler. The list route returns all matching rows for the (limit/offset/sort) page.

**Why deferred.** Conforming requires an `<Entity>FilterAllowlist` generator + a runtime parser analogous to the TS `parseFilterParams` (in `@metaobjectsdev/runtime-ts/drizzle-fastify`) that translates the bracketed qs into an `Expression<Func<TEntity, bool>>` against EF Core's `IQueryable<T>`. The runtime infrastructure (allowlist class shape, expression-tree builder, error vocabulary) is its own piece of work and belongs in a follow-up sub-project of FR-008.

**Workaround for consumers today.** Hand-write filter logic in a controller that wraps the generated route, or apply LINQ filters in a middleware before calling the generated route. Until the codegen lands, the read-side query shape is still consumer-controllable end-to-end; we just don't auto-generate it.

### G2 — `filter[or]` / `filter[and]` nested boolean grouping

**Contract.** `filter[or]=[...]` and `filter[and]=[...]` keys nest disjunctions / conjunctions. Reference: [`api-contract.md` "Filter operators (8)"](../../../../docs/features/api-contract.md).

**Today.** Out of scope until G1 lands; same workaround applies.

### G3 — Multi-field sort

**Contract.** Single sort key only in the default contract (`sort=<field>:asc|desc`). Multi-field sort is NOT in scope for the contract today.

**Today.** Conformed — single sort key is the documented surface.

### G4 — Error code vocabulary

**Contract.** The exact `error` code vocabulary is NOT a hard Tier-1 invariant; consumers should treat any 4xx as user-facing and 5xx as retryable. Reference: [`api-contract.md` "Error response"](../../../../docs/features/api-contract.md).

**Today.** We emit `{ "error": "not_found" }` for 404 and `{ "error": "validation", "message": "..." }` for the sort-validation 400. The TS reference emits `{ "error": "validation", "issues": [...] }` (Zod issue array) for body-validation 400; we currently rely on ASP.NET's default model-validation response for POST/PATCH bodies — that is per-port idiomatic (Tier 2), not a Tier-1 gap.

### G5 — CORS

**Contract.** Generated controllers should NOT enforce CORS themselves — the consumer's `Program.cs` wires `app.UseCors(...)` per their origin policy. The Angular dev-server case is documented in [`docs/recipes/csharp-angular18.md`](../../../../docs/recipes/csharp-angular18.md).

**Today.** Conformed — the generator emits no `[EnableCors]` attributes.

## How to add a new gap

1. Append a numbered `### G<N>` section above.
2. Quote the contract clause it relates to and the file it lives in.
3. State today's behaviour honestly (silently ignored / partially conforming / etc.).
4. State the workaround (if any) so consumers aren't blocked.
5. Reference the FR / sub-project where the closure work is tracked.

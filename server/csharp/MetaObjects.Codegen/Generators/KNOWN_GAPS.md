# RoutesGenerator — known gaps vs cross-port API contract

Tracks where `RoutesGenerator.cs` does not yet match
[`docs/features/api-contract.md`](../../../../docs/features/api-contract.md).
Update when a gap closes or a new one surfaces.

## Conformed today (Tier 1)

- `GET /api/<entity>` list, `GET /:id`, `POST`, `PATCH /:id`, `PUT /:id`, `DELETE /:id` mount under `apiPrefix` (default `/api`); entity segment is lowercased + pluralized.
- `?limit=N&offset=N` pagination — honoured on the list route.
- `?sort=<field>:asc|desc` — honoured against a per-entity static `SortAllowlist` derived from scalar fields. Unknown field returns 400 `{ "error": "validation", "message": "unknown sort field: ..." }`.
- `?withCount=1` — switches the list envelope from `[<row>...]` to `{ rows, total }`. The grid hook always sends this. `total` reflects the filtered count when `filter[...]` is present.
- `?filter[<field>][<op>]=<value>` (and the `filter[<field>]=<value>` sugar form for `eq`) — honoured against a per-entity `<Entity>FilterAllowlist` emitted by `FilterAllowlistGenerator`. Errors return 400 `{ "error": "invalid_filter_field" | "invalid_filter_op" | "invalid_filter_value" }`. The list handler calls `FilterParser.Parse` and dispatches via `EfCoreFilterDispatch.ApplyFilter` (both in `MetaObjects.Codegen.Runtime`). FR-009.
- Both `PATCH` and `PUT` map to the same update handler (TS reference exposes both verbs; C# now matches).
- 404 carries a JSON envelope: `{ "error": "not_found" }`.
- Projection (`object.projection` over a read-only `source.rdb` `@kind: view`) routes are read-only — only `GET` list + `GET /:id` are mounted; no `POST` / `PATCH` / `PUT` / `DELETE`.
- HTTP status codes: `200` / `201` (POST) / `204` (PATCH/PUT/DELETE) / `400` (validation) / `404` (not found).
- Sort dispatch uses `EF.Property<object>(x, "<Name>")` — no runtime reflection (AOT-safe). Filter dispatch uses the same approach via `EfCoreFilterDispatch`.

## Gaps

### G2 — `filter[or]` / `filter[and]` nested boolean grouping

**Contract.** `filter[or]=[...]` and `filter[and]=[...]` keys nest disjunctions / conjunctions. Reference: [`api-contract.md` "Filter operators (8)"](../../../../docs/features/api-contract.md).

**Today.** Out of scope of FR-009 (which ships the flat 9-operator surface). Boolean grouping would need a richer URL grammar; defer until a real consumer demand surfaces.

### G3 — Multi-field sort

**Contract.** Single sort key only in the default contract (`sort=<field>:asc|desc`). Multi-field sort is NOT in scope for the contract today.

**Today.** Conformed — single sort key is the documented surface.

### G4 — Error code vocabulary

**Contract.** The exact `error` code vocabulary is NOT a hard Tier-1 invariant; consumers should treat any 4xx as user-facing and 5xx as retryable. Reference: [`api-contract.md` "Error response"](../../../../docs/features/api-contract.md).

**Today.** We emit `{ "error": "not_found" }` for 404 and `{ "error": "validation", "message": "..." }` for the sort-validation 400. **FR-036 wired explicit body validation with the cross-port `{ "error": "validation" }` envelope:** a POST runs `Validator.TryValidateObject(input, ...)` and a PATCH runs `Validator.TryValidateProperty(value, ...)` per present value → 400 `{ "error": "validation" }` (ASP.NET minimal-API never runs DataAnnotations on its own, so the annotations were previously decorative at the wire tier). The `issues` array is still TS-only idiomatic (Tier 2).

### G7 — Object/value-typed columns are non-PATCHable (deliberate, cross-port)

**Contract.** A `field.object`/`field.map` column (a value-object mapped to jsonb, single or `@isArray`) is EF-mapped as an owned navigation (`.OwnsOne`/`.OwnsMany(...).ToJson`).

**Today.** The partial-PATCH merge loop keys off `entry.Metadata.FindProperty(prop.Name)`, which returns null for a navigation, so a VO-typed column is skipped on PATCH (present values too). This is a **deliberate cross-port Day-1 simplification**, consistent with Java + Kotlin (both exclude `ObjectField` from the patch set) — NOT a C#-specific bug (FR-036 assessed a C#-only fix and rejected it: it would break the api-contract byte-identical parity). Making VO-typed columns PATCHable (bind the owned nav via `entry.Navigation(...).CurrentValue`, cross-port) is a separately-scoped follow-up FR.

### G5 — `EfCoreFilterDispatch` ordered-comparison fallback

**Contract.** `gt` / `gte` / `lt` / `lte` work uniformly for all numeric/date subtypes.

**Today.** [`EfCoreFilterDispatch.BuildComparison<T>`](../Runtime/EfCoreFilterDispatch.cs) tries `long.TryParse` first and falls through to lexicographic `string.Compare`. Works for `long` columns and for ISO 8601 string-backed dates (which sort lexicographically). Fragile for `decimal` / `double` / non-ISO date columns — those degrade silently to string-compare semantics. The contract still holds for the operator vocabulary; only the comparison precision is gappy.

**Workaround.** Consumers can hand-write a typed dispatcher in their repository layer that materializes `Expression<Func<T,bool>>` with the column's CLR type. A future closure pass would add `decimal.TryParse` + `DateTime.TryParse` to the dispatcher; tracked here rather than auto-closed because the right fix is per-port substrate-aware emit, not a runtime tweak.

### G6 — CORS

**Contract.** Generated controllers should NOT enforce CORS themselves — the consumer's `Program.cs` wires `app.UseCors(...)` per their origin policy. The Angular dev-server case is documented in [`docs/recipes/csharp-angular18.md`](../../../../docs/recipes/csharp-angular18.md).

**Today.** Conformed — the generator emits no `[EnableCors]` attributes.

### G8 — Write-through entity read-view (#214) — extension-seam + M:N notes

**Contract.** A write-through entity (writable table source + read-only replica view source + derived `origin.*` fields, FR-024 §7) generates a hybrid surface: a derived-free, table-mapped WRITE entity (`<Entity>`), plus a SECOND, view-mapped read model (`<Entity>View`) carrying the derived fields (EF Core cannot map one CLR type to both a table and a view). Reads (list / get / reverse finders) route to `db.<Entity>Views`; writes target `db.<Entity>Plural`; a create/update re-reads the row through the view by PK (read-your-writes).

**Today.** Conformed. Two notes:

- **`EmitMappedClass` override reach.** The write entity is still emitted through the `EmitMappedClass` extension seam (an adopter override applies to it), but the `<Entity>View` read model is emitted through the shared private impl directly, so an adopter's `EmitMappedClass`/`EmitClassHeader` override does NOT reach the read model. If read-model customization is needed, override `EmitWriteThroughReadModel`. Acceptable Day-1 limitation.

- **M:N on a write-through entity.** The FR-018 M:N traversal route (`GET /<entity>/{id}/<relation>`) on a write-through entity still addresses the source by the write-entity path and joins through the junction/target DbSets — it is not routed through the replica view (the view carries no junction). Not exercised by the shipped fixtures; revisit if a real consumer models an M:N on a write-through entity.

- **`<Entity>View` / `<Entity>Views` is a RESERVED name.** `CSharpNaming.ViewModelClassName` / `ViewDbSetName` mint the read model as `<Entity>View` (class + file) and `<Entity>Views` (DbSet) unconditionally from the write-through entity's name. A user object literally named `<Entity>View` (e.g. a write-through `Order` alongside a separate object named `OrderView`) collides — codegen would emit two `OrderView.g.cs` files / two `OrderView` types / two `OrderViews` DbSets. No code guard is added: the codegen runner already hard-errors on the duplicate output path, a clear, immediate failure (not silent corruption). Treat `<Entity>View` / `<Entity>Views` as reserved for a write-through entity's generated read model.

### G9 — a `field.map` member of a FLATTENED value object gets no EF column mapping

**Contract.** `@storage: flattened` spreads a value object's members onto the owning table as
`<parent field's column>_<member column>`. That prefix rule is migrate-ts's
(`expected-schema.ts` `flattenObjectField`) and TS owns the schema (ADR-0015), so the EF
configuration must name exactly the columns the migration creates. `flattenObjectField`
iterates the value object's fields **unconditionally** — every member gets a column.

**Today.** Four member kinds reach a flattened value object, and three are named:
scalars, enums (scalar and array), and nested `field.object` members (a nested owned type
pinned to its own `<prefix>_<col>` json column). **`field.map` is not.** It surfaces as
`Dictionary<string, T>`, and this port configures a top-level `field.map` nowhere either —
`DbContextGenerator` has no map branch at all — so there is no proven mapping to mirror.
Emitting `b.Property(...)` onto a dictionary risks making EF's model builder throw where it
currently ignores the member, which trades a wrong column for a broken build.

**Consequence.** The migration creates `<prefix>_<map member column>`; EF binds its own
`<Nav>_<Prop>` default. Reads and writes touching that member fail at the engine (Postgres
`42703: column ... does not exist`).

**Workaround.** Do not use `field.map` inside a flattened value object. Either store the
owning value object as jsonb (the default; the whole document is one column, so the member
needs no column of its own) or hoist the map to a top-level `field.map` on the entity.

**Loud, not silent.** `DbContextGenerator` emits a `meta gen` warning naming the member and
the exact column the migration will create, so the divergence is visible at generate time
rather than at the first query. Pinned by
`ObjectFieldCodegenTests.A_flattened_map_member_warns_instead_of_binding_a_wrong_column`.

**Closure.** Needs a decided EF mapping for `field.map` at BOTH tiers (top-level field and
flattened member) — it is one question, not two, and answering it only for the nested case
would leave the two tiers disagreeing.

## How to add a new gap

1. Append a numbered `### G<N>` section above.
2. Quote the contract clause it relates to and the file it lives in.
3. State today's behaviour honestly (silently ignored / partially conforming / etc.).
4. State the workaround (if any) so consumers aren't blocked.
5. Reference the FR / sub-project where the closure work is tracked.

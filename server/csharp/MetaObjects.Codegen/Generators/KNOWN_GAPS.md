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

### G7 — Value-object columns on TPH entities are still skipped on PATCH

**Contract.** A `field.object` column (a value-object mapped to jsonb, single or `@isArray`) is EF-mapped as an owned navigation (`.OwnsOne`/`.OwnsMany(...).ToJson`).

**`field.map` is not in this gap.** A map column is not a navigation — it is a scalar-shaped property carrying a value converter (G9) — so `FindProperty` resolves it and the generic merge arm writes it on PATCH. Map columns are patch-settable here, as on Java; Kotlin alone stages them out of its patch set (see its `KNOWN_GAPS.md`).

**Today.** On the vanilla (non-TPH) PATCH/PUT handler a VO-typed column IS patch-settable. The handler passes the entity's VO fields into `AppendPartialMergeLoop` (`RoutesGenerator.cs:256`), which emits a Program D typed value-object arm for each one AHEAD of the generic `entry.Metadata.FindProperty(prop.Name)` arm — an owned navigation is invisible to `FindProperty`, so the generic scalar path alone would silently drop the column. Per arm: a present value is deserialized, recursively validated (`ValueObjectValidator.Validate`), and assigned to the CLR navigation property; a present `null` clears a nullable VO column — a nullable array-of-VO additionally takes a post-save raw UPDATE, since EF's `OwnsMany(...).ToJson` writes `[]` for a null collection nav rather than SQL NULL — or 400s a `@required` one; an absent key leaves the column untouched. This is the same Program D shipment Java's `KNOWN_GAPS.md` records as cross-port (TS / Python / Java / Kotlin / C#), gated by `fixtures/api-contract-conformance/jsonb/scenarios/jsonb-value-object-patch.yaml` in both lanes.

**Residual.** TPH only: the per-subtype partial-update path passes an empty VO list (`RoutesGenerator.cs:961`), so VO columns on a TPH-rooted entity are still skipped on PATCH — the same staging-out Java's entry records for TPH.

**Close status.** The vanilla-path behaviour above may mean this entry is already closed for everything except the TPH residual; that ruling is deliberately NOT made here because it needs Program D's intent, which this file does not own. It is filed for exactly that decision as [issue #359](https://github.com/metaobjectsdev/metaobjects/issues/359). Until ruled, the entry stays open against the TPH residual.

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

### G9 — a `field.map` member of a FLATTENED value object gets no EF column mapping — **CLOSED**

**Was.** `@storage: flattened` spreads a value object's members onto the owning table as
`<parent field's column>_<member column>`, and migrate-ts's `flattenObjectField` emits a column
for **every** member. `field.map` was the one member kind `DbContextGenerator` did not name, so
the migration created `<prefix>_<map member column>` while EF bound its own `<Nav>_<Prop>`
default — reads and writes touching that member failed at the engine (Postgres `42703`). The
stated reason was that this port configured a top-level `field.map` nowhere either, so there was
no proven mapping to mirror.

**Now.** There is one. A top-level `field.map` gets `.HasColumnType("jsonb")` plus the shared
`MapJsonb` converter/comparer pair, and the flattened member takes the SAME suffix pinned to its
prefixed column name via `HasColumnName` — one `MapJsonbSuffix`, so the two tiers cannot drift.
Pinned by `ObjectFieldCodegenTests.A_flattened_map_member_binds_its_prefixed_jsonb_column` and
compile-proven against real EF Core 8 by `DbContextCompileTests` (whose fixture carries a map on
an entity, on a value object flattened into one, and on a read-only projection — three distinct
receivers).

**Residual.** The generator still warns for any member kind it cannot pin; `field.map` is no
longer one of them.

## How to add a new gap

1. Append a numbered `### G<N>` section above.
2. Quote the contract clause it relates to and the file it lives in.
3. State today's behaviour honestly (silently ignored / partially conforming / etc.).
4. State the workaround (if any) so consumers aren't blocked.
5. Reference the FR / sub-project where the closure work is tracked.

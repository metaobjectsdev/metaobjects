# FR-017 — TPH polymorphic codegen across the generator stack

**Status:** Design (ready for implementation in tiers; see §Tiered delivery)
**Applies to:** all five language ports (TypeScript reference + Java / Kotlin / C# / Python).
**Depends on:** [FR-014](2026-05-28-fr-014-tph-discriminator-design.md) (metamodel + loader — shipped on TS reference at commit `a6daacc0`).
**Related ADRs:** [ADR-0002](../../../spec/decisions/ADR-0002-open-closed-typed-nodes.md), [ADR-0013](../../../spec/decisions/ADR-0013-logical-field-types-vs-physical-column-attributes.md), [ADR-0021](../../../spec/decisions/ADR-0021-codegen-surface-coherence.md) (codegen surface coherence — stable-name registry).

## Why this doc exists

FR-014 ships the metamodel for table-per-hierarchy (TPH) single-table inheritance: an `object.entity` carrying `@discriminator` names the field whose value identifies subtype membership, and each subtype `object.entity` declares `@discriminatorValue`. The loader validates the four cross-attribute rules. The per-port ORM-emission table in FR-014 sketches how each stack (EF Core `HasDiscriminator`, JPA `@Inheritance`, SQLAlchemy `polymorphic_on`, Kotlin sealed class, TS discriminated union) idiomatically realizes the storage + type layer.

What FR-014 deliberately leaves out — and what this doc covers — is **the generator-stack surface around TPH**:

- Discriminated TS union types + per-subtype Zod schemas (`entityFile` shape changes).
- Polymorphic queries (`queriesFile` must project the discriminator + dispatch row → subtype).
- Storage: the Drizzle table emission must include the union of all subtype columns, subtype-only columns auto-nullable (the canonical TPH storage rule).
- REST contract decisions: how does `GET /auths` shape its response? Does `POST /auths` exist? What about per-subtype routes?
- TanStack hooks (`useAuths` returns a union; per-subtype `useBridgeAuths` / `useCreateBridgeAuth`).
- TanStack grid: polymorphic single-grid vs. per-subtype grids.
- React forms: per-subtype, never abstract.
- Filter allowlists per subtype (the discriminator is implicit and pinned).
- Spring (Java) generator stack: `EntityGenerator` / `PayloadGenerator` / `ControllerGenerator` / `RepositoryGenerator` / `FilterAllowlistGenerator` all change for TPH.
- Kotlin / C# / Python generator stacks: equivalent per-stack idioms.
- API-contract conformance scenarios that pin the polymorphic CRUD shape cross-port.

Without this design, every port would implement TPH inconsistently. The point of this doc is to pin the decisions once so every port emits equivalent surfaces.

## Layer placement (ADR-0013)

Everything in this doc is **codegen / generator-stack**, not metamodel. The metamodel is shipped in FR-014. The Drizzle table emission, the Zod schemas, the routes, the hooks, the forms — all are downstream of the loaded model. They consume `@discriminator` and `@discriminatorValue`; they do not introduce new attrs.

The one possible exception is a future addition (see §Open questions): an optional `@subtypeBranch` URL-segment override for per-subtype routes. That belongs in metamodel only if naming the route variant cannot be derived from the subtype's entity name. The default this doc specifies is "use the subtype's name, lowercased and pluralized" — purely conventional, no metamodel attr.

## Tiered delivery

This is a large feature. The decisions in this doc are written once; implementation lands in tiers so each tier is a coherent shippable unit:

| Tier | Scope | Effort | Adopter value |
|---|---|---|---|
| **1: types-only (TS)** | Discriminated TS union + per-subtype Zod schemas in `entityFile`; a `parse(row)` dispatch helper. No Drizzle / route / hook changes. | ~half day | Type-level adoption: consumers hand-wire Drizzle but get type-safe parsing. |
| **2: working CRUD (TS)** | Polymorphic Drizzle table (union of all subtype columns, subtype-only nullable); polymorphic `queriesFile`; per-subtype routes; per-subtype Zod create/update variants. | ~3-5 days | TPH is end-to-end usable in TS production. |
| **3: UI ergonomics (TS)** | Per-subtype TanStack hooks; polymorphic + per-subtype grids; per-subtype React forms; per-subtype filter allowlists. | ~3-5 days | Generated UI surfaces "just work" against TPH. |
| **4: per-port** | Java / Kotlin / C# / Python: each port re-implements Tiers 1-3 in its ORM idiom. | ~1 week per port, parallel | Cross-port parity. |
| **5: conformance** | API-contract conformance scenarios for polymorphic CRUD + persistence-conformance TPH query scenarios — all cross-port byte-equivalent. | ~3-5 days | Guarantees cross-port equivalence. |

Tier 1 ships under this same FR-017 design; Tiers 2-5 may each grow their own implementation-plan docs as they're picked up.

## Decision: TS types-only (Tier 1)

### Discriminated union emission

For an entity that carries `@discriminator`, `entityFile` emits one TS union type spanning every subtype that declares `@discriminatorValue` extending this entity. The union is keyed on the discriminator field name.

```ts
// Generated from object.entity "Auth" with @discriminator: "type"
// and subtypes BridgeAuth / CopayAuth / PriorAuthAuth declaring values
// "Bridge" / "Copay" / "PriorAuth".

export type Auth = BridgeAuth | CopayAuth | PriorAuthAuth;

// Type guard helpers — one per subtype.
export function isBridgeAuth(a: Auth): a is BridgeAuth {
  return a.type === "Bridge";
}
// ... etc.
```

The base type alias is `<BaseEntity>` (`Auth` here). Type guards are one-per-subtype, named `is<Subtype>(...)`. They check the discriminator field; they do NOT downcast — TS's discriminated-union narrowing does that for free.

When the base entity is `abstract`, the emitter still emits the union type but the base entity itself does NOT appear as a member.

### Per-subtype Zod schemas

For each concrete subtype, `entityFile` emits a Zod schema that is the base entity's schema `.merge(...)` with the subtype's own field schema. The discriminator field's value is pinned via `z.literal(...)`:

```ts
// Base Zod schema (already emitted today for any entity).
export const AuthSchema = z.object({
  id: z.number().int(),
  type: z.enum(["Bridge", "Copay", "PriorAuth"]),
});

// Per-subtype schemas — each merges the base, pins the discriminator value,
// and adds the subtype's own fields.
export const BridgeAuthSchema = AuthSchema.merge(z.object({
  type: z.literal("Bridge"),
  quantity: z.number().int(),
}));
export type BridgeAuth = z.infer<typeof BridgeAuthSchema>;

export const CopayAuthSchema = AuthSchema.merge(z.object({
  type: z.literal("Copay"),
  copayAmount: z.number(),
}));
export type CopayAuth = z.infer<typeof CopayAuthSchema>;
```

**Discriminator pin via `z.literal`.** Each subtype schema pins its `type` field to the literal value. So `BridgeAuthSchema.parse({type: "Copay", ...})` throws — typed gatekeeping is enforced by Zod, not just TypeScript.

### Discriminator dispatch

`entityFile` emits a single helper that takes a raw row and dispatches to the right subtype schema:

```ts
/** Parse a row from the auths table, dispatching by the discriminator value. */
export function parseAuth(row: unknown): Auth {
  // Read the discriminator without committing the row to any subtype yet.
  const head = z.object({ type: z.enum(["Bridge", "Copay", "PriorAuth"]) }).parse(row);
  switch (head.type) {
    case "Bridge":      return BridgeAuthSchema.parse(row);
    case "Copay":       return CopayAuthSchema.parse(row);
    case "PriorAuth":   return PriorAuthAuthSchema.parse(row);
  }
}
```

The switch is exhaustive because `head.type` is the enum union; TypeScript will fail to compile if a future subtype is added without a case. Callers wanting tolerance for unknown discriminator values can wrap `parseAuth` themselves.

### Insert / update schemas: deferred to Tier 2

For Tier 1, the existing `<Entity>InsertSchema` / `<Entity>UpdateSchema` shapes continue to emit against the base entity, NOT per-subtype. The polymorphic-create story (per-subtype `POST` routes + per-subtype create schemas) is a Tier 2 concern that interacts with routes / Drizzle storage. Tier 1 ships read-side typed parsing only.

### What gets emitted on the BASE entity vs. each SUBTYPE entity

Concrete shape of `entityFile` output:

| File | Contents (Tier 1) |
|---|---|
| `Auth.ts` (base) | `AuthSchema` (full union of fields across all subtypes), `Auth` type alias to the discriminated union, type guards, `parseAuth` dispatcher. |
| `BridgeAuth.ts` (subtype) | `BridgeAuthSchema` (base merged + own), `BridgeAuth` type, no separate type guard file. |
| `CopayAuth.ts` (subtype) | same as above. |

The subtype files each `import { AuthSchema } from "./Auth.js"` — base must be emitted first / locatable.

### Generator-registry impact (ADR-0021)

No new stable-name registry entry needed for Tier 1: this is all inside `entityFile`. Tiers 2-3 add new generators (see below) that DO need manifest + registry entries.

## Decision: working CRUD in TS (Tier 2)

### Drizzle TPH table emission

The discriminator base entity emits a single Drizzle `pgTable` whose column set is the **union of base + all subtype columns**, with every subtype-only column declared **nullable**. Subtype entity files do NOT emit their own Drizzle tables — TPH is single-table by definition.

```ts
export const auths = pgTable("auths", {
  // Base columns
  id: bigserial("id", { mode: "number" }).primaryKey(),
  type: varchar("type", { length: 32 }).notNull(),

  // BridgeAuth-only columns: nullable, since rows of any other subtype have NULL here.
  quantity: integer("quantity"),

  // CopayAuth-only columns: nullable.
  copay_amount: numeric("copay_amount", { precision: 10, scale: 2 }),

  // PriorAuthAuth-only columns: nullable.
  // ...
});
```

Subtype-only columns are detected by their declaring entity: any field declared on a `@discriminatorValue`-bearing subtype is subtype-only. Columns that appear on the base entity stay nullable-or-not per their own `@required`.

A subtype that re-declares a base field is treated as an override (already the way `extends` works); the override applies.

### Polymorphic queries

`queriesFile` for the discriminator base entity changes shape:

```ts
export async function findAllAuths(db: NodePgDatabase): Promise<Auth[]> {
  const rows = await db.select().from(auths);
  return rows.map(parseAuth); // dispatches per the discriminator
}

export async function findAuthById(db: NodePgDatabase, id: number): Promise<Auth | undefined> {
  const rows = await db.select().from(auths).where(eq(auths.id, id));
  if (rows.length === 0) return undefined;
  return parseAuth(rows[0]);
}
```

**Per-subtype query helpers** also emit:

```ts
export async function findAllBridgeAuths(db: NodePgDatabase): Promise<BridgeAuth[]> {
  const rows = await db.select().from(auths).where(eq(auths.type, "Bridge"));
  return rows.map((r) => BridgeAuthSchema.parse(r));
}
```

The per-subtype helpers filter on the discriminator column and parse with the subtype-specific schema. They are emitted into the **base entity's** queries file (not the subtype's), so that `Auth.queries.ts` is the single import surface for both polymorphic and per-subtype reads.

### Per-subtype creates / updates

The base entity does NOT get a single `createAuth(...)` — you cannot create an abstract `Auth`. Each subtype gets its own:

```ts
export async function createBridgeAuth(
  db: NodePgDatabase, args: BridgeAuthCreate,
): Promise<BridgeAuth> {
  const inserted = await db.insert(auths).values({
    type: "Bridge",
    ...args,
  }).returning();
  return BridgeAuthSchema.parse(inserted[0]);
}
```

`BridgeAuthCreate` is a per-subtype Zod schema with the discriminator field omitted (set to the literal automatically). The function injects the discriminator value before insert.

Update helpers are also per-subtype:

```ts
export async function updateBridgeAuth(
  db: NodePgDatabase, id: number, patch: Partial<BridgeAuthUpdate>,
): Promise<BridgeAuth | undefined> {
  // Won't change the discriminator (clients can't).
  const { type: _, ...safe } = patch as Record<string, unknown>;
  const rows = await db.update(auths)
    .set(safe).where(eq(auths.id, id)).returning();
  if (rows.length === 0) return undefined;
  return BridgeAuthSchema.parse(rows[0]);
}
```

The discriminator field is **never updatable** — clients can't change a Bridge into a Copay. Generated `updateXxx` strips the discriminator field from any patch.

### REST contract (TS routes)

`routesFile` for a discriminator-base entity emits:

| Method + path | Behavior |
|---|---|
| `GET /auths` | Polymorphic list. Returns `Auth[]` (union); response objects carry the discriminator field by value. |
| `GET /auths/:id` | Polymorphic get. Returns `Auth` or 404. |
| `GET /auths/bridge` | Per-subtype list. Returns `BridgeAuth[]`. |
| `GET /auths/bridge/:id` | Per-subtype get. Returns `BridgeAuth` or 404 (also 404 if the row exists but is a different subtype). |
| `POST /auths/bridge` | Per-subtype create. Body validated against `BridgeAuthCreate`. The discriminator value is injected by the route handler, NOT taken from the body. Returns the created `BridgeAuth`. |
| `PATCH /auths/bridge/:id` | Per-subtype update. Body validated against partial `BridgeAuthUpdate` minus discriminator. 404 if not that subtype. |
| `DELETE /auths/bridge/:id` | Per-subtype delete. 404 if not that subtype. |

**Why per-subtype POST paths instead of `POST /auths` with a discriminator-in-body.** Three reasons:
1. The URL is self-describing — `POST /auths/bridge` unambiguously says "create a Bridge". A body-discriminator design hides the intent.
2. Zod input validation runs against the subtype's schema, not a body-keyed-discriminated-union — simpler, faster, more type-safe.
3. Caching / observability is cleaner — log lines say `POST /auths/bridge`, not all `POST /auths` with mixed subtypes.

**No `POST /auths`** — there is intentionally no polymorphic create endpoint. (If an adopter has a real use case for one, an additive `@allowPolymorphicCreate: true` attr could enable it later; default off.)

The path segment `bridge` is `<subtype.name>` lowercased. Future override via `@subtypeRouteSegment: "...":` on the subtype entity (deferred to FR-017 v2).

### Filter allowlists

The base entity's filter allowlist (`AuthFilterAllowlist`) includes the discriminator field as filterable. So a client can `?filter[type]=Bridge` against `GET /auths` to filter by subtype.

Per-subtype routes have their own filter allowlist (`BridgeAuthFilterAllowlist`) which:
- Excludes the discriminator field (it's implicit in the URL).
- Includes the subtype's own fields plus inherited base fields.

### Generator-registry impact (ADR-0021 + canonical manifest)

Tier 2 adds no NEW stable-name generators — `entity`, `queries`, `routes` are pre-existing and absorb the TPH behavior. The manifest at `fixtures/generator-registry-conformance/registry.json` is unchanged for Tier 2.

## Decision: UI ergonomics (Tier 3)

### TanStack hooks

For a discriminator base:

- `useAuths()` — `useQuery` against `GET /auths`. Returns `Auth[]`.
- `useAuth(id)` — `useQuery` against `GET /auths/:id`. Returns `Auth | undefined`.

For each subtype:

- `useBridgeAuths()` — `useQuery` against `GET /auths/bridge`. Returns `BridgeAuth[]`.
- `useBridgeAuth(id)` — `useQuery` against `GET /auths/bridge/:id`.
- `useCreateBridgeAuth()` — `useMutation` against `POST /auths/bridge`. Accepts `BridgeAuthCreate`, returns created `BridgeAuth`.
- `useUpdateBridgeAuth()` — `useMutation` against `PATCH /auths/bridge/:id`.
- `useDeleteBridgeAuth()` — `useMutation` against `DELETE /auths/bridge/:id`.

The hooks live in the base entity's `.hooks.ts` file. Cache invalidation on a per-subtype mutation invalidates **both** the per-subtype query key AND the polymorphic key.

### TanStack grid

**Decision: single polymorphic grid is the default, per-subtype grids are opt-in.**

The base entity emits one `<AuthGrid>` component bound to `useAuths()`. Columns:
- The discriminator field renders as a `Tag` / `Badge` cell with the subtype name.
- Base fields render with their declared `view.<subtype>` renderers.
- Subtype-only fields render as `—` (em-dash) for rows of other subtypes.

Per-subtype grids (`<BridgeAuthGrid>`) opt-in via a metamodel attribute on the subtype: `@emitGrid: true`. Default false (the polymorphic grid is sufficient for most uses).

### React forms

Forms are always per-subtype. `<BridgeAuthForm>` binds to `BridgeAuthSchema` (create variant). The discriminator field never renders in the form — it's implicit. The form uses `useCreateBridgeAuth()` on submit.

No `<AuthForm>` is emitted (you can't create an abstract `Auth`).

### Generator-registry impact (ADR-0021)

Tier 3 introduces **no new stable-name generators**. `tanstack-query`, `tanstack-grid`, `form` (or their per-port equivalents) absorb TPH behavior internally. The canonical manifest at `fixtures/generator-registry-conformance/registry.json` is unchanged.

## Decision: per-port (Tier 4)

Each non-TS port mirrors Tiers 1-3 in its idiom. The key contracts that must hold cross-port:
1. **Single-table TPH storage** — every port's table emission uses a single physical table with subtype-only columns nullable.
2. **Polymorphic GET / per-subtype POST URLs** — `GET /auths` returns the union; `POST /auths/bridge` etc. are the per-subtype creates. URL paths must match cross-port exactly.
3. **Response shape carries the discriminator value** — `@type` field is always present and reflects the subtype.

### Per-port idiom table

| Stack | Storage | Type modeling | Polymorphic read | Per-subtype create |
|---|---|---|---|---|
| **Java JPA** | `@Inheritance(strategy = SINGLE_TABLE)` + `@DiscriminatorColumn(name="type")` on base + `@DiscriminatorValue("Bridge")` on subtype | Inherited Java classes | Spring repo `findAll()` on base | Per-subtype repo `save(BridgeAuth)` |
| **C# EF Core** | `modelBuilder.Entity<Auth>().HasDiscriminator(...).HasValue<BridgeAuth>(AuthType.Bridge)` | Inherited C# classes | `_ctx.Auths.OfType<BridgeAuth>()` for subtype queries | `_ctx.Auths.Add(new BridgeAuth(...))` |
| **Kotlin Exposed** | Sealed-class hierarchy + manual `Table.col` declarations using nullable types | Sealed `sealed class Auth` + `data class BridgeAuth : Auth()` | Per-subtype `transaction { ... where(...).map(...) }` | Per-subtype insert |
| **Python SQLAlchemy** | `__mapper_args__ = {"polymorphic_on": Auth.type, "polymorphic_identity": "auth"}` on base; subtypes set their own `polymorphic_identity` | SQLAlchemy inheritance | `session.query(BridgeAuth).all()` | `session.add(BridgeAuth(...))` |

Per-port routes:
- **Spring (Java)** — `@Controller` per subtype with `@RequestMapping("/auths/bridge")`. Polymorphic `GET /auths` controller on the base.
- **ASP.NET (C#)** — `[Route("auths/bridge")] BridgeAuthController` per subtype.
- **Spring (Kotlin)** — same as Java.
- **FastAPI (Python)** — `APIRouter(prefix="/auths/bridge")` per subtype.

### Per-port filter allowlist

Each port's filter-allowlist generator (already in the canonical manifest) emits a per-subtype allowlist excluding the discriminator. The base entity's allowlist includes the discriminator.

### Generator-registry impact (ADR-0021)

Tier 4 introduces **no new stable-name generators**. The existing `entity`, `routes`, `repository`, `dto`, `filter-allowlist`, `payload` generators across the four ports each absorb TPH behavior. The canonical manifest unchanged.

## Decision: conformance (Tier 5)

Two corpora gain TPH scenarios:

### `fixtures/api-contract-conformance/`

New fixtures pinning the polymorphic CRUD shape cross-port:

- `tph-polymorphic-list-and-get` — `GET /auths` returns subtype-tagged rows; `GET /auths/:id` returns one row.
- `tph-per-subtype-list-and-create` — `GET /auths/bridge` filtered; `POST /auths/bridge` create.
- `tph-per-subtype-update-and-delete` — subtype-only mutations.
- `tph-cross-subtype-404` — `GET /auths/bridge/123` for an id that exists but is a Copay returns 404.

Each fixture asserts request shape (URL + body) and response shape (status + body) cross-port byte-equivalently.

### `fixtures/persistence-conformance/`

New TPH query scenarios:

- `tph-insert-then-find-by-id` — insert a `BridgeAuth`, find by id; the result's subtype-only columns are NULL on other-subtype reads.
- `tph-insert-three-subtypes-list` — insert one of each subtype; `findAllAuths()` returns three rows tagged by `@type`.
- `tph-update-subtype-only-column` — update a Bridge's `quantity`; verify storage.
- `tph-no-cross-subtype-update` — attempt to update a Bridge with Copay-only fields; verify they're stripped / rejected.

## Open questions

1. **Per-subtype URL segment override.** Default is `lowercase(subtype.name)`. A future `@subtypeRouteSegment: "<custom>"` attr on the subtype entity could override. Defer until an adopter need surfaces.
2. **Polymorphic `POST /auths`.** Default is "not emitted". A future `@allowPolymorphicCreate: true` attr on the base entity could opt in. Defer.
3. **Mixed-source TPH.** Today, all subtypes of a discriminated base share the base's single `source.rdb` binding by definition (single-table). The metamodel does NOT allow per-subtype source overrides — this is an FR-014 invariant. FR-017 inherits it.
4. **Deep hierarchies.** Three-level (`Base → Mid → Leaf`) is supported in FR-014 metamodel. FR-017 codegen treats every concrete leaf as a subtype member of the discriminator-bearing root; intermediate abstract levels emit no concrete types or routes. This is the simplest mental model.
5. **Discriminator default value.** When a `field.enum` discriminator has no `@default` and a base row exists with no discriminator (legacy data), parsing fails. A `WARN_DISCRIMINATOR_BASE_NO_DEFAULT` warning at load time was discussed in FR-014; not implemented yet. Reconsider in Tier 5 if conformance scenarios surface it.

## Cross-references

- [FR-014](2026-05-28-fr-014-tph-discriminator-design.md) — metamodel + loader (shipped).
- [ADR-0013](../../../spec/decisions/ADR-0013-logical-field-types-vs-physical-column-attributes.md) — layer split (FR-017 sits in codegen).
- [ADR-0021](../../../spec/decisions/ADR-0021-codegen-surface-coherence.md) — generator stable-name registry (no manifest changes from FR-017; existing generators absorb TPH).
- [Metadata-codegen plan](../plans/2026-05-31-metamodel-batch-metadata-codegen-plan.md) — overall plan; FR-017 work originally listed as "TPH polymorphic codegen design" under FR-014 Step 1.

## Realization status

- **Tier 1 (TS types-only):** **shipped** (commit `7ac54a35`) — discriminated
  union + per-subtype type guards + `parse<Base>` dispatcher + per-subtype Zod
  discriminator pin.
- **Tier 2 (TS working CRUD):** **shipped** across four slices:
  - #1 Drizzle single-table emission (union of subtype columns, subtype-only
    columns forced nullable, no DB default).
  - #2 per-subtype full read schema `<Sub>Schema` (fixes the Tier 1
    `parse<Base>` reference, which pointed at a never-emitted schema) + the
    polymorphic & per-subtype queries file (base `find/list` dispatch through
    `parse<Base>`; per-subtype list/findById/create/update/delete against the
    single table; subtypes get no standalone queries file).
  - #3 per-subtype REST routes: a runtime-ts `mountCrudRoutes`
    `discriminator: { column, value }` option (subtype-scoped reads,
    cross-subtype 404, create-injects / update-strips the discriminator) +
    `routesFile` emitting polymorphic list/get at the base path and a per-subtype
    CRUD set at `<base>/<discriminatorValue lowercased>`; subtypes get no
    standalone routes file.
  - **Deviation noted:** per-subtype create/update use
    `<Sub>InsertSchema` (`.omit({<disc>: true})` on the route boundary,
    `.partial()` for update) rather than separately-named `<Sub>Create` /
    `<Sub>Update` aliases. Functionally equivalent; a named-alias polish is
    deferred.
  - **Edge deferred:** an *abstract* discriminator base. The conformance
    fixtures use a concrete base (which owns the table); an abstract base
    short-circuits the entity-file value-object path before the Drizzle path, so
    its single TPH table is not yet emitted. Revisit when an adopter needs it.
- **Tier 3 (TS UI ergonomics):** **shipped** across four slices (+ a prereq fix):
  - **#0 (prereq) base-type collision fix:** the discriminator base emitted
    `export type <Base>` twice (Drizzle InferSelectModel row + the Tier-1 union)
    — a latent non-compiling defect. The union now owns the bare `<Base>` name;
    the raw single-table row type is emitted as `<Base>Row`.
  - #1 TanStack hooks: polymorphic `use<Base>` / `use<Plural>` (union) + a
    query-key factory with polymorphic & per-subtype scopes; per-subtype
    list/get/create/update/delete hooks (create input `Omit<<Sub>, "<disc>">`);
    mutations invalidate `<base>Keys.all()`. Subtypes get no standalone hooks
    file.
  - #2 polymorphic grid: ONE `<Base>` grid typed against `<Base>Row` (all
    columns), folding in every subtype-only column, discriminator as a badge.
    Per-subtype grids opt-in via own `@emitGrid: true`.
  - #3 per-subtype React forms: base gets NO form; each subtype gets a
    `<Sub>Form` binding `<Sub>InsertSchema.omit({<disc>: true})` with the
    discriminator never rendered. Required emitting the `<Sub>` field-metadata
    constants object on the subtype file.
  - #4 per-subtype filter/sort allowlists (`<Sub>FilterAllowlist` /
    `<Sub>SortAllowlist`, discriminator excluded); per-subtype routes wire to
    them. The base allowlist keeps the discriminator (polymorphic filter).
  - codegen-ts + codegen-ts-tanstack + codegen-ts-react suites: 652/0.
- **Tiers 4–5:** unimplemented. Pick up as adopter need + per-port fan-out
  pressure dictates.

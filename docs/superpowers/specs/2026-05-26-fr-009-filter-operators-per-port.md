# FR-009 — Cross-port filter operators in generated REST routes

- **Date:** 2026-05-26
- **Status:** Design — plan-of-record. Resolves the `KNOWN_GAPS.md` "filter operators" deferral in all 5 route-codegen modules.
- **Target version:** 7.0.0
- **Scope:** Wire the 9 filter operators (`eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`, `like`, `isNull`) into every port's generated routes + add API contract conformance scenarios that gate them across ports.

## 1. Background

The cross-port REST API contract ([`docs/features/api-contract.md`](../../docs/features/api-contract.md)) declares 9 filter operators with the URL grammar `?filter[<field>][<op>]=<value>` (or `?filter[<field>]=<value>` as sugar for `eq`).

**Current state:** TS already implements the full operator set in `runtime-ts/drizzle-fastify` (Project D). The 4 backend route generators that shipped under FR-008 (Java Spring, Kotlin Spring, C# Minimal API, Python FastAPI) all deferred filter operator handling to their respective `KNOWN_GAPS.md`. **None of the 4 newly-generated backends actually filter today** — they only sort + paginate.

This FR closes that gap port-by-port and adds conformance scenarios so the contract stays gated cross-port.

## 2. The contract (Tier 1 invariant)

Per [`docs/features/api-contract.md`](../../docs/features/api-contract.md):

| Operator | Field-subtype gating | URL form |
|---|---|---|
| `eq` | all subtypes | `?filter[name][eq]=Ada` OR `?filter[name]=Ada` |
| `ne` | all subtypes | `?filter[name][ne]=Ada` |
| `gt` | numbers, dates, currency | `?filter[priceCents][gt]=10000` |
| `gte` | numbers, dates, currency | `?filter[createdAt][gte]=2026-01-01` |
| `lt` | numbers, dates, currency | `?filter[priceCents][lt]=50000` |
| `lte` | numbers, dates, currency | `?filter[priceCents][lte]=20000` |
| `in` | all subtypes | `?filter[status][in]=DRAFT,PUBLISHED` (comma-separated) |
| `like` | strings | `?filter[name][like]=%Ada%` (SQL `LIKE` semantics — `%` wildcard) |
| `isNull` | nullable fields | `?filter[bio][isNull]=true` (or `false`) |

**Field allowlist** — only fields declared with `@filterable: true` in the metadata appear in the per-entity allowlist. Unknown field → HTTP 400 `{"error": "invalid_filter_field"}`. Disallowed operator-for-subtype → HTTP 400 `{"error": "invalid_filter_op"}`. Invalid value coercion → HTTP 400 `{"error": "invalid_filter_value"}`.

**Type coercion**:
- `number` / `currency` → integer parsing; reject NaN / non-integer
- `date` / `timestamp` → ISO 8601 string accepted directly
- `string` → URL-decoded as-is
- `boolean` → `"true"` / `"false"`
- `isNull` value → `"true"` / `"false"`

**Combinator**: multiple filter params AND together. `?filter[name][like]=%Ada%&filter[priceCents][gt]=10000` = `name LIKE '%Ada%' AND priceCents > 10000`. No OR support in this FR (would require a richer URL grammar — separate FR).

## 3. Per-port implementation

Each port emits an `<Entity>FilterAllowlist` constant + a `parseFilter` helper that validates URL params against the allowlist + dispatches to the substrate's predicate type.

### 3.1 TypeScript

Already implemented in `runtime-ts/drizzle-fastify/parse-filter.ts`. **Scope here**: verify all 9 operators are covered + add conformance scenarios that gate them.

### 3.2 Java (Spring) — `codegen-spring`

Generator addition: `SpringFilterAllowlistGenerator` — emits `<Entity>FilterAllowlist.java` per entity:

```java
package acme.blog;

import java.util.Map;
import java.util.Set;

public final class AuthorFilterAllowlist {
    public static final Set<String> FIELDS = Set.of("name", "createdAt", "bio");
    public static final Map<String, Set<String>> OPS_BY_FIELD = Map.of(
        "name",      Set.of("eq", "ne", "in", "like", "isNull"),
        "createdAt", Set.of("eq", "ne", "gt", "gte", "lt", "lte", "isNull"),
        "bio",       Set.of("eq", "ne", "like", "isNull")
    );
}
```

Plus modify `SpringControllerGenerator.list()` to call a shared `FilterParser` runtime helper:

```java
@GetMapping
public ResponseEntity<?> list(/* ... existing params, plus: */
    @RequestParam Map<String, String> allParams
) {
    // ...
    FilterParseResult filter = FilterParser.parse(allParams, AuthorFilterAllowlist.FIELDS, AuthorFilterAllowlist.OPS_BY_FIELD);
    if (filter.error() != null) return ResponseEntity.badRequest().body(Map.of("error", filter.error()));
    List<AuthorDto> rows = repository.list(actualLimit, actualOffset, sortClause, filter.predicates());
    // ...
}
```

The repository interface gains a `List<FilterPredicate>` parameter that the consumer translates to their persistence DSL.

NEW small runtime: `server/java/codegen-spring/src/main/java/com/metaobjects/generator/spring/runtime/FilterParser.java` — a substrate-agnostic parser that returns a `List<FilterPredicate(field, op, valueRaw)>` for the consumer to dispatch. Ships as part of codegen-spring (not a separate module — too small to warrant one).

### 3.3 Kotlin (Spring-Kotlin) — `codegen-kotlin`

Same pattern. New generator method on `KotlinSpringControllerGenerator` that emits `<Entity>FilterAllowlist.kt` + threads `filter: List<FilterPredicate>` through to the consumer's repository.

For Exposed substrate: include a small `exposedFilterDispatch(table, predicates)` helper in the consumer-facing module that converts `List<FilterPredicate>` to an Exposed `Op<Boolean>`. Generator emits the call.

### 3.4 C# (ASP.NET) — `MetaObjects.Codegen`

Add `<Entity>FilterAllowlist.cs` to `RoutesGenerator` output:

```csharp
public static class AuthorFilterAllowlist
{
    public static readonly HashSet<string> Fields = new() { "name", "createdAt", "bio" };
    public static readonly Dictionary<string, HashSet<string>> OpsByField = new()
    {
        ["name"]      = new() { "eq", "ne", "in", "like", "isNull" },
        ["createdAt"] = new() { "eq", "ne", "gt", "gte", "lt", "lte", "isNull" },
        ["bio"]       = new() { "eq", "ne", "like", "isNull" }
    };
}
```

Modify `RoutesGenerator.GenerateOne()` to wire `FilterParser` in the list handler + emit an `EF.Property<>`-based dispatcher per entity that converts `FilterPredicate` to `Expression<Func<T,bool>>`. Closes C# `KNOWN_GAPS.md` G1 entirely.

### 3.5 Python (FastAPI) — `router_generator`

Add `<Entity>_filter_allowlist.py` per entity + `parse_filter` helper. Repository Protocol gains a `filter: list[FilterPredicate]` parameter.

For SQLAlchemy: ship a `_apply_filter(query, predicates, model)` helper that calls `getattr(model, predicate.field)` + dispatches the op via a small map. Consumer's repository imports it.

## 4. Cross-port API conformance — new scenarios

Add to `fixtures/api-contract-conformance/scenarios/` (NEW; current corpus has 10 scenarios — add 8 filter scenarios for a final 18):

- `filter-eq` — `?filter[name][eq]=Ada` → 1 row
- `filter-ne` — `?filter[name][ne]=Ada` → 4 rows
- `filter-gt` — `?filter[id][gt]=2` → ids > 2
- `filter-lt` — `?filter[id][lt]=3` → ids < 3
- `filter-in` — `?filter[name][in]=Ada,Alan` → 2 rows
- `filter-like` — `?filter[name][like]=A%` → 2 rows (Ada, Alan)
- `filter-isnull-true` — `?filter[bio][isNull]=true` → rows with null bio
- `filter-and` — `?filter[name][like]=A%&filter[id][gt]=1` → AND combinator works

Plus 2 error scenarios:

- `filter-invalid-field` — `?filter[unknown][eq]=x` → 400 `{"error": "invalid_filter_field"}`
- `filter-invalid-op` — `?filter[name][gt]=Ada` (string with numeric op) → 400 `{"error": "invalid_filter_op"}`

Total scenarios: 10 existing + 8 new + 2 error = **20 scenarios**.

Each port's runner picks them up automatically (parameterized over `scenarios/`).

## 5. Field allowlist authoring

Per CLAUDE.md Project D: mark a field with `@filterable: true` in metadata to include it in the allowlist. The metadata loader already validates `@filterable` (existing Java + Python + C# + TS support — verify).

For each port's generator: walk the entity's `field.*` children, include those where `@filterable: true` in the FILTERABLE set. Default behavior (no `@filterable` attr) = NOT filterable.

Operators-per-subtype mapping (CLAUDE.md Project D):
- string subtypes: `eq`, `ne`, `in`, `like`, `isNull`
- numeric / date / currency / timestamp: `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`, `isNull`
- boolean: `eq`, `isNull`

## 6. Implementation order

1. TS conformance scenarios — verify TS runtime supports all 9 (likely already does) + add 10 new scenarios
2. Run TS test → 20/20 reference
3. Java port — `SpringFilterAllowlistGenerator` + `FilterParser` runtime + 20/20 conformance
4. Kotlin port — same shape, Spring-Kotlin
5. C# port — closes KNOWN_GAPS G1 entirely
6. Python port — `router_generator` extension + FastAPI 20/20

Each port = focused agent run (~1-2 hours each).

## 7. Out of scope (deferred)

- **OR combinator** (`?filter[name][eq]=Ada|filter[id][gt]=10`) — needs richer URL grammar; separate FR if real consumer demand
- **Nested-field filters** (`?filter[author.name][eq]=Ada`) — joins are a separate concern; relationship navigation in REST
- **Full-text search** — substrate-specific; out of cross-port contract
- **Case-insensitive `like`** (`ilike`) — Postgres-specific; consumer post-processes if needed

## 8. Cross-references

- [`docs/features/api-contract.md`](../../docs/features/api-contract.md) — the URL grammar this FR implements
- [`fixtures/api-contract-conformance/`](../../fixtures/api-contract-conformance/) — corpus to extend
- TS reference: `server/typescript/packages/runtime-ts/src/drizzle-fastify/parse-filter.ts` + CLAUDE.md "Filter syntax + sort (Project D)"
- KNOWN_GAPS to close:
  - `server/csharp/MetaObjects.Codegen/Generators/KNOWN_GAPS.md` (G1)
  - `server/java/codegen-spring/src/main/java/com/metaobjects/generator/spring/KNOWN_GAPS.md`
  - `server/python/src/metaobjects/codegen/KNOWN_GAPS.md`
  - `KotlinSpringControllerGenerator.kt` docstring deferral note

# Slim the `@dbColumnType` vocabulary — derive what's derivable (cross-port)

**Goal.** Apply the project's own principle ("pattern-derivable from metadata = codegen,
never specify; never invent an attr for what's already there", ADR-0023) to the
`@dbColumnType` escape hatch. Most of its values encode information already present in
`field.subType` + `isArray` + `maxLength` and should be **derived, not declared**. This
is a breaking metamodel-vocabulary change, scoped to the **pre-1.0 consolidation window**
([ADR-0035](../../../spec/decisions/ADR-0035-one-zero-stability-commitment-and-version-unification.md)).

**The verdicts being implemented** (from the design conversation):
1. `text_array` → **remove**; derive native `text[]` from `field.string` + `isArray`.
2. `uuid_array` → **remove**; derive native `uuid[]` from `field.uuid` + `isArray`.
3. `uuid` (scalar) → **narrow**: `field.uuid` is the path; keep `dbColumnType:uuid` only as a documented "uuid column + string native" exception.
4. `text` → **not an option; fix the default**: `field.string` no-`maxLength` → `text`; with `maxLength` → `varchar(n)`. Remove the JVM `dbColumnType:text` value and the Kotlin `@kind:text` hack.
5. `jsonb` → **keep** (open-bag; not derivable).
6. `timestamp_with_tz` → **flip the default**: `field.timestamp` defaults to `timestamptz`; the rare without-tz case uses `dbColumnType:timestamp`. (**Phase 2** — native-type-changing.)

---

## Architectural keys (from the cross-port grounding)

- **The canonical Postgres DDL is TS-owned** — `migrate-ts` emits `canonical/schema.postgres.sql`, and every port provisions its test DB by executing it (ADR-0015). So the column-type *decision* lives in `migrate-ts`; each port's ORM/runtime mapper (TS codegen, C# EF, Kotlin Exposed, Java OMDB JDBC, Python pg8000) must **agree** with the canonical, and the persistence-conformance corpus is the cross-port gate.
- **The `@dbColumnType` value-set is NOT cross-port-identical today** and `registry-conformance` does not gate attribute *value-sets* (only types/subtypes/attrs). The JVM ports carry an extra `text` value; only Kotlin implements `uuid_array`/`text_array`. **Add a cross-port value-set gate** so this can't drift again.

### Current divergence (Postgres)
| | TS (canonical) | C# (EF) | Kotlin (Exposed) | Java (OMDB/DTO) | Python (Pydantic/runtime) |
|---|---|---|---|---|---|
| `string` no-maxLen | `text` | `text` | `varchar(255)` | `varchar(50)` | `str` (no DDL) |
| `string isArray` | `text[]` | `text[]` | not wired | not wired / throws | `list[str]` |
| `field.uuid` scalar | exists | `Guid`+`uuid` | `UUID`+`uuid` | `UUID`(DTO)+`uuid` | `uuid.UUID` |
| `field.uuid isArray` | derive | `Guid[]`/`uuid[]` | falls to scalar | **throws** | `list[uuid.UUID]` |
| `uuid_array`/`text_array` override | vestigial | vestigial | implemented | vestigial | vestigial |
| `dbColumnType: text` value | absent | absent | present+impl | present+vestigial | absent |
| `@kind: text` field hack | — | — | yes (unregistered attr) | — | — |
| `timestamp` default | no-tz | no-tz (forced) | no-tz | no-tz | no-tz (naive) |

---

## Target behavior (identical across all 5 ports)

### Derived — NO attribute (the metadata already says it)
- `field.string`, no `maxLength` → **`text`** (Postgres). With `maxLength: N` → **`varchar(N)`**.
- `field.string`, `isArray: true` → native **`text[]`** + the port's `List<String>`/`string[]`/`list[str]` native type.
- `field.uuid` scalar → **`uuid`** column + native UUID type (`java.util.UUID` / `Guid` / `uuid.UUID`; TS `string`).
- `field.uuid`, `isArray: true` → native **`uuid[]`** + `List<UUID>`/`Guid[]`/`list[uuid.UUID]`.
- `field.timestamp` → **`timestamptz`** (Phase 2; native `Instant`/`DateTimeOffset`/aware `datetime`).

### Declared — the only surviving `@dbColumnType` values
The closed set becomes **`{ uuid, jsonb, timestamp }`** (down from 6, identical in every port):
- **`uuid`** (on `field.string`) — "uuid *column*, `string` native type." The narrow escape hatch for when an app wants a string-typed id over a uuid column. `field.uuid` is preferred and documented as such.
- **`jsonb`** (on `field.string`) — the open JSON bag (parsed-value contract, #98). Not derivable.
- **`timestamp`** (on `field.timestamp`) — the rare opt-out from the new `timestamptz` default → emits `TIMESTAMP WITHOUT TIME ZONE` + the port's naive/local temporal type. (Phase 2.)

**Removed values:** `uuid_array`, `text_array`, `timestamp_with_tz` (now the default), and the JVM-only `text`. The Kotlin `@kind:text` field hack is removed (it's an unregistered attr that already fails strict verify).

---

## Phasing

**Phase 1 (vocab slim + derive arrays + text default; no native-type change):**
- Vocab: remove `uuid_array`, `text_array`, JVM `text`. Keep `uuid`, `jsonb`, `timestamp_with_tz` (still valid in Phase 1).
- Derive `text[]` (field.string+isArray) and `uuid[]` (field.uuid+isArray) — *build* Java OMDB native-array binding (new) + Kotlin native-array default + ensure migrate-ts canonical emits them + C#/TS already do; Python emits `list[...]` (no DDL).
- Fix JVM `field.string` default → `text` (Java OMDB stop hardcoding VARCHAR(50/255); Kotlin Exposed `text()` for no-maxLength). Remove the `@kind:text` hack.
- Add the cross-port `@dbColumnType` value-set conformance gate.
- **No native-type changes** → smaller blast radius; ships green first.

**Phase 2 (timestamp default flip — native-type-changing):**
- `field.timestamp` default → `timestamptz` (canonical migrate-ts + every port's temporal native type: `Instant`/`DateTimeOffset`/aware `datetime`). Remove `timestamp_with_tz`; add `dbColumnType: timestamp` (without-tz override). Update the wire/normalization contract + ADR-0019 temporal note as needed.
- Migration: adopters drop `dbColumnType:timestamp_with_tz` (now the default) and add `dbColumnType:timestamp` only where they genuinely want a naive column.

---

## Per-port delta summary (Phase 1)

- **migrate-ts (TS, canonical DDL):** confirm `field.string`+isArray → `text[]`, `field.uuid`+isArray → `uuid[]`; remove `uuid_array`/`text_array` recognition; field.string no-maxLength → `text` (already). The canonical `schema.postgres.sql` is the source of truth.
- **TS codegen (codegen-ts):** remove `uuid_array`/`text_array` from `db-constants`; field.uuid+isArray → `uuid[]` (.array() with uuid element); field.string+isArray already `text[]`. (TS already correct on text default + scalar arrays.)
- **C# (EF):** remove the two array values; ensure `field.uuid`+isArray → `Guid[]`/`uuid[]` (PrimitiveCollection); string default already `text`.
- **Kotlin (Exposed):** remove the two array values + the `text` value + the `@kind:text` hack; make `isArray` (string→`text[]`, uuid→`uuid[]`) the **default** (currently only via the now-removed overrides); `field.string` no-maxLength → `text()` not `varchar(255)`.
- **Java (OMDB + SpringTypeMapper):** remove the two array values + the vestigial `text` value; **build native `text[]`/`uuid[]` JDBC binding in OMDB** (new — currently throws/varchar(50)); `field.string` no-maxLength → align with canonical `text` (stop hardcoding VARCHAR(50)); `field.uuid`+isArray DTO → `List<UUID>` (currently throws).
- **Python (Pydantic + runtime):** remove the two array values; `field.uuid`+isArray already `list[uuid.UUID]`; runtime write-coercion for native arrays if needed (no DDL).

## Conformance
- **Value-set gate (new):** a cross-port test asserting each port's `@dbColumnType` legal-value-set == `{uuid, jsonb, timestamp_with_tz}` (Phase 1) / `{uuid, jsonb, timestamp}` (Phase 2), byte-identical.
- **persistence-conformance:** add/extend `op: roundtrip` scenarios for `field.string isArray` (→ `text[]`) and `field.uuid isArray` (→ `uuid[]`) so every port's runtime write+read is gated against the canonical native-array schema. Update `asset-native-column-types.yaml` (which uses the removed values) to the derived forms.
- **Migrate-ts expected-schema:** the canonical `schema.postgres.sql` is regenerated and is the cross-port source of truth; assert it emits `text`/`text[]`/`uuid[]` for the derived cases.

## Migration (adopter impact)
- `dbColumnType:uuid_array` / `text_array` → drop the attr; the array-ness is derived from `isArray` (model the field `isArray: true`).
- `dbColumnType:text` (JVM) / `@kind:text` → drop it; `text` is the default for a no-`maxLength` string.
- `dbColumnType:uuid` (262× in one large audited adopter) → keep working (still valid), but prefer migrating to `field.uuid` where a native UUID type is wanted (this also fixes the `String`↔`UUID` divergence the audit flagged).
- **Phase 2:** drop `dbColumnType:timestamp_with_tz` (now default); add `dbColumnType:timestamp` only for genuine without-tz columns.
- The 0.x→1.0 migration guide ([docs/1.0-readiness.md](../../1.0-readiness.md) B2) carries this.

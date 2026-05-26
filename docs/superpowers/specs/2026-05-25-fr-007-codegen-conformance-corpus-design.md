# FR-007 — Cross-language codegen conformance corpus

- **Date:** 2026-05-25
- **Status:** Design (deferred — not blocking) — placeholder for a future cross-language codegen conformance gate.
- **Target version:** 7.0.0+ (post-codegen-kotlin)
- **Scope:** Define a `fixtures/codegen-conformance/` corpus that gates **what** each port's codegen emits — file inventory, generator catalog, type-mapping table, FR-004 payload-VO shape — independently of *how* (each port emits its own ecosystem's native code).

## 1. Background

The project's other shared corpora (`fixtures/conformance/`, `fixtures/render-conformance/`, `fixtures/persistence-conformance/`, `fixtures/yaml-conformance/`, `fixtures/verify-conformance/`) gate cross-language behavior at the metamodel / wire-format / render / SQL-pipeline layer. Each port runs the same corpus and asserts the same outcomes.

**Codegen is the one layer with no shared corpus today.** TS emits Drizzle/Kysely/Fastify, C# emits EF Core + ASP.NET, Java/Kotlin emit Exposed/omdb-ktx, Python (planned) emits SQLAlchemy/FastAPI. Each port's codegen tests are entirely port-local snapshot tests against its own templates. There is no cross-language check that:

- Every port emits a *file* for every entity (and exactly the right files for each declared generator)
- The type-mapping table is consistent (a `field.currency` produces a `long`/`Long`/`number`/`int64` everywhere)
- The FR-004 payload codegen produces a value-object class with the same field tree across ports
- Naming conventions stay aligned per port (snake_case vs literal vs PascalCase) where the metadata declares a strategy

This gap is intentional today — codegen is the area with the highest legitimate cross-language divergence (idiomatic Drizzle ≠ idiomatic EF Core). But there ARE invariants worth gating, and a shared corpus is the only way to catch drift.

## 2. Scope of the corpus

A `fixtures/codegen-conformance/` corpus structured per-fixture as:

```
fixtures/codegen-conformance/<fixture-name>/
├── input/                          # the source metadata (canonical JSON)
│   └── meta.<concept>.json
├── manifest.json                    # cross-port expectations (Tier 1 invariants only)
└── ports/                           # per-port expected outputs (Tier 2 — port-specific)
    ├── ts/
    │   └── expected/<file>.ts
    ├── csharp/
    │   └── expected/<file>.cs
    ├── java-kotlin/
    │   └── expected/<file>.kt
    ├── python/
    │   └── expected/<file>.py
```

The `manifest.json` declares Tier-1 invariants:

```json
{
  "input": "meta.author.json",
  "tier1Invariants": {
    "filesPerEntity": ["entity", "table", "ddl"],
    "fieldTypeMapping": {
      "id":   { "metaType": "field.long",     "expectedSemantic": "int64" },
      "name": { "metaType": "field.string",   "expectedSemantic": "string", "constraints": { "maxLength": 100 } },
      "bio":  { "metaType": "field.string",   "expectedSemantic": "string", "nullable": true }
    },
    "payloadVoFieldTree": null
  }
}
```

The per-port `expected/*.X` files are the Tier-2 golden output. Each port's test runner walks `fixtures/codegen-conformance/`, runs its codegen against the input, and compares against its own `ports/<lang>/expected/*` golden files.

The **cross-port gate** is a separate check (in CI or a script) that walks `manifest.json` per fixture and asserts that every port's expected output:
- emits the declared `filesPerEntity` set
- each `fieldTypeMapping.<field>.metaType` produces an output of `expectedSemantic` (string-token check against the port's known semantic-to-native map)
- payload-VO codegen, where present, produces a class with the declared field tree

## 3. What's gated vs not

**Gated (Tier 1 invariant):**
- Per-entity file inventory per declared generator
- Field type semantic (long → 64-bit int in every port)
- Required vs nullable flags
- `@maxLength` propagation to the appropriate column type
- FR-004 payload-VO field tree (each port's generated payload class has the same property names + semantic types)
- Generator-catalog membership: every port must implement the same generator names (`entity`, `table`, `ddl`, `payload`, `repo`)

**NOT gated (intentionally divergent — Tier 2):**
- Native column type name (`varchar(100)` vs `VARCHAR(100)` vs `Varchar` constructor)
- Native repo style (Drizzle relations() vs EF Core DbSet<T> vs Exposed Table object vs omdb-ktx extension fns)
- Native serialization annotation (`@Serializable` vs `[Serializable]` vs `BaseModel` vs none)
- Native package/module naming conventions
- Native test harness or framework integration (Fastify route fn vs ASP.NET controller vs Ktor route)

## 4. Implementation outline

Three deliverables:

1. **Corpus directory** at `fixtures/codegen-conformance/` with 8-12 representative fixtures:
   - `single-entity-primitives` — one entity with every primitive field type
   - `nullable-fields`
   - `entity-with-pk-generation` (increment, uuid, assigned)
   - `currency-field` — minor units stay long across all ports
   - `enum-field` — closed-set enum
   - `relationship-fk` — two entities + composition
   - `source-rdb-with-kind-view` — projection
   - `template-prompt-with-payload` — FR-004 payload codegen
   - `payload-with-collection` — `origin.collection` nested payload
   - `payload-with-aggregate` — `origin.aggregate count/sum`
2. **Per-port runners**:
   - TS: extend `server/typescript/packages/codegen-ts/test/` with a parametrized snapshot test over the corpus
   - C#: extend `server/csharp/MetaObjects.Codegen.Tests/` similarly
   - Java/Kotlin: extend `server/java/codegen-kotlin/src/test/kotlin/.../CodegenConformanceTest.kt`
   - Python (when codegen ships): extend its codegen test suite
3. **Cross-port gate script** (`scripts/codegen-conformance-check.{ts,sh}`) that:
   - Walks `fixtures/codegen-conformance/`
   - For each fixture, reads `manifest.json`
   - For each declared port (`ports/*/expected/`), verifies the file inventory + field-type semantic mapping
   - Reports drift; fails CI if any port violates the manifest

## 5. Dependencies / order

- **Blocked on:** codegen-kotlin shipping (provides the 4th codegen target). Until then, the corpus could ship with TS + C# but with thinner coverage.
- **Helped by:** FR-004 payload codegen being complete in TS, C#, and Java/Kotlin (otherwise `payload-with-*` fixtures only cover 2-3 ports).

## 6. Out of scope

- **Runtime behavior gating** of generated code (that's covered by `persistence-conformance/` for the DB layer + `render-conformance/` for the prompt layer).
- **Framework controller / route generation parity** (each port's framework is too divergent; not worth gating).
- **Cross-port byte-identical generated code** (not the goal — Tier 2 divergence is expected and healthy).

## 7. Status note + visibility marker

Until this FR is implemented, a placeholder lives at `fixtures/codegen-conformance/README.md` documenting the gap and linking back to this spec. Any contributor adding a new codegen target or expanding existing codegen will encounter that README and remember the conformance gate is pending.

## 8. Cross-references

- TS codegen: `server/typescript/packages/codegen-ts/`
- C# codegen: `server/csharp/MetaObjects.Codegen/`
- Java/Kotlin codegen (planned): `server/java/codegen-kotlin/` — spec at `docs/superpowers/specs/2026-05-25-codegen-kotlin-design.md`
- FR-004 (payload codegen prerequisite): `docs/superpowers/specs/2026-05-22-fr-004-cross-language-prompt-construction-design.md`

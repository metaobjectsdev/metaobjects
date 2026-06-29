# Kotlin port — audit reference

The Kotlin port is a **codegen tier built on top of the Java port** — the loader,
render engine, and Maven plugin are all Java; `metaobjects-codegen-kotlin` emits
idiomatic Kotlin (KotlinPoet: `@Serializable data class`, Exposed `Table` objects,
Spring `@RestController`). Codegen runs as the same Maven plugin goal the Java port
uses (`mvn metaobjects:generate`). Schema migration and live-DB drift are
**Node-`meta`-only** (ADR-0015). The runtime persistence tier is **JetBrains Exposed**
(hand-written transaction bodies around the generated table objects), or optionally
**OMDB** (the Java `ObjectManagerDB`, callable from Kotlin).

---

## Finding generated files

Generated sources land under:

```
target/generated-sources/kotlin/
```

Each generated file carries an `@generated` guard comment. These files are not
committed — confirm the plugin is wired and the goal bound to `generate-sources` in
`pom.xml`. Per-generator output: `<Entity>.kt` (data class), `<Entity>Table.kt`
(Exposed Table), `<Entity>Controller.kt` (Spring controller).

---

## Run codegen + verify

```bash
mvn metaobjects:generate                              # codegen goal directly
mvn compile                                           # also runs it (bound to generate-sources)
mvn metaobjects:verify -Dmeta.verify.mode=codegen     # regen to temp, diff vs committed output
mvn metaobjects:verify -Dmeta.verify.mode=templates   # {{field}} refs vs payload VO
```

Kotlin generators run through the **same Maven plugin goal** as Java generators —
both are SPI-discovered by the `metaobjects-maven-plugin`. Schema migration + live-DB
drift run through the **Node `meta` CLI** regardless of server language — see the
migration reference.

The active generator list is declared in `pom.xml` under the plugin `<configuration>`
`<generators>` block — that is the source of truth for which generators run.

---

## Drift signatures (what to grep for)

| Signature | What it means |
|---|---|
| Hand-written `data class` with same fields as a modeled entity | `KotlinEntityGenerator` should own this (`<Entity>.kt`) |
| Hand-written `object ... : Table(` | `KotlinExposedTableGenerator` should own this (`<Entity>Table.kt`) |
| Hand-written `@RestController` on a CRUD entity | `KotlinSpringControllerGenerator` should own this |
| `@Serializable` on a payload class not in generated sources | `KotlinPayloadGenerator` should own this; check `pom.xml` generator list |
| `// keep in sync with` / `// mirrors the` | second-source-of-truth comment — always a finding |
| `transaction(db) {` bodies that duplicate every CRUD operation | hand-written Exposed transactions are expected (see Calibration), but if they duplicate generated-CRUD logic exactly, audit further |

---

## Owned generators

Kotlin does not scaffold-and-own generators — they are provided by
`metaobjects-codegen-kotlin` and wired by FQ class name in `pom.xml`. There is no
analog to the TS `codegen/generators/*.ts` pattern here.

To re-scaffold the agent-context into a Kotlin project, use the Node `meta` CLI (the
single agent-docs assembler per ADR-0033):

```bash
npx meta agent-docs --server kotlin [--out <dir>]
```

---

## Version-skew check

The resolved Maven artifact versions are what actually ran — check the effective POM
or the resolved dependency tree:

```bash
mvn dependency:list -Dincludes="com.metaobjects:*"
```

All `com.metaobjects:*` artifacts publish in lockstep on the `7.x` Maven line. A
mixed resolved version across `metaobjects-metadata`, `metaobjects-metadata-ktx`,
`metaobjects-codegen-kotlin`, and `metaobjects-maven-plugin` is an intra-port skew
finding. The Java/Kotlin `7.x` line vs TS/C#/Python `0.x` is intentional
cross-port versioning — **do not flag it** (only intra-port skew matters).

---

## Calibration gaps (do NOT flag these)

- **Exposed transaction bodies are hand-written — expected.** `KotlinExposedTableGenerator`
  emits the `Table` column definitions; the consumer hand-writes the (typically trivial)
  `transaction(db) { ... }` bodies that query and mutate those tables. This is the expected
  Kotlin runtime pattern — do NOT flag hand-written Exposed transactions as a defect.
- **Hand-written output parser is expected.** `KotlinOutputParserGenerator` emits a typed
  parser class, but the deserialization body inside it uses a hand-written kotlinx.serialization
  call — do NOT flag this. Only flag hand-rolled parsers in non-generated files where a
  `template.output` node exists.
- **Filter-operator route codegen deferred.** The generated `<Entity>Controller.kt` supports
  `?sort`, `?limit`/`?offset`, and `?withCount=1` envelope but defers filter-operator
  validation. Do NOT flag hand-added Kotlin filter handling as an adopter defect.
- **No JVM migrate goal.** Schema migration is Node-`meta`-owned for every port
  (ADR-0015). The Maven plugin has no migrate goal; `meta migrate` is correct.

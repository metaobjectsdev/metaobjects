# Java port — audit reference

The Java port targets Spring Boot consumers on Maven. Codegen runs as a build-time
Maven plugin goal (`mvn metaobjects:generate`). Schema migration and live-DB drift
are **Node-`meta`-only** (ADR-0015) — the Maven plugin has no migrate goal.
The runtime persistence tier is **OMDB** (`metaobjects-omdb`,
`com.metaobjects.manager.db.ObjectManagerDB`).

---

## Finding generated files

Generated sources land under:

```
target/generated-sources/java/
```

Each generated file carries an `@generated` guard comment (Java `/** @generated */`
or a line comment). The Maven `generate-sources` lifecycle phase runs codegen before
`compile` — these files are never committed; confirm the plugin is wired and the
goal bound to `generate-sources` in `pom.xml`.

---

## Run codegen + verify

```bash
mvn metaobjects:generate                              # codegen goal directly
mvn compile                                           # also runs it (bound to generate-sources)
mvn metaobjects:verify -Dmeta.verify.mode=codegen     # regen to temp, diff vs committed output
mvn metaobjects:verify -Dmeta.verify.mode=templates   # {{field}} refs vs payload VO
```

Schema migration + live-DB drift run through the **Node `meta` CLI** regardless of
server language — see the migration reference. `mvn metaobjects:verify -Dmeta.verify.mode=db`
is rejected (exit 2).

The generator list and the `<sourceDir>` are both declared in `pom.xml` under the
plugin `<configuration>`. To see which generators are active:

```bash
mvn metaobjects:generate -Dmeta.gen.list=true
```

---

## Drift signatures (what to grep for)

| Signature | What it means |
|---|---|
| Hand-written `record` with same fields as a modeled entity | `SpringDtoGenerator` should own this (`<Entity>Dto.java`) |
| Hand-written `@RestController` on a CRUD entity | `SpringControllerGenerator` should own this; trust `mvn metaobjects:generate -Dmeta.gen.list=true`, not stale docs |
| `interface <Entity>Repository` with no `@generated` comment | `SpringRepositoryGenerator` emits the stub; compare field by field |
| `// keep in sync with` / `// mirrors the` | second-source-of-truth comment — always a finding |
| `ObjectMapper.readValue(` outside a `*Parser.java` file | check if a `template.output` node exists — output-parser codegen ships in Java |
| `LIMIT ?` / `OFFSET ?` assembled by hand | generated CRUD routes handle pagination; OMDB `getObjects` accepts `QueryOptions` |

---

## Owned generators

Java does not scaffold-and-own generators — they are provided by
`metaobjects-codegen-spring` and wired by FQ class name in `pom.xml`. There is no
analog to the TS `codegen/generators/*.ts` pattern here.

To re-scaffold the agent-context into a Java project, use the Node `meta` CLI (the
single agent-docs assembler per ADR-0033):

```bash
npx meta agent-docs --server java [--out <dir>]
```

---

## Version-skew check

The resolved Maven artifact versions are what actually ran — check the effective POM
or the resolved dependency tree, not the declared `${metaobjects.version}` property:

```bash
mvn dependency:list -Dincludes="com.metaobjects:*"
```

All `com.metaobjects:*` artifacts publish in lockstep on the Java `7.x` Maven
line. A mixed resolved version across `metaobjects-metadata`, `metaobjects-omdb`,
`metaobjects-codegen-spring`, and `metaobjects-maven-plugin` is an intra-port skew
finding. The Java `7.x` line vs TS/C#/Python `0.x` is intentional cross-port
versioning — **do not flag it** (only intra-port skew matters).

---

## Calibration gaps (do NOT flag these)

- **Hand-written output parser is expected.** The `SpringOutputParserGenerator` emits
  a typed `<Name>Parser` class, but the Jackson `readValue` one-liner inside it is
  hand-written by the generator — it is NOT a defect to see Jackson deserialization in
  generated `*Parser.java` files. **Do not flag Jackson `readValue` calls in
  `*Parser.java` files.** Only flag hand-rolled parsers in *non*-generated files where
  a `template.output` node exists.
- **Filter-operator route codegen deferred.** The generated `<Entity>Controller.java`
  supports `?sort`, `?limit`/`?offset`, and `?withCount=1` envelope but defers
  filter-operator validation (`?filter[field][op]=value`). Do NOT flag hand-added
  Java filter handling as an adopter defect.
- **Repository interface is a hand-implemented stub.** `SpringRepositoryGenerator`
  emits `<Entity>Repository.java` as a stub `interface`; the consumer hand-writes the
  implementation against OMDB (or any persistence layer). Hand-written repository
  implementations that match the generated interface exactly are expected.
- **No Java migrate goal.** Schema migration is Node-`meta`-owned for every port
  (ADR-0015). The Maven plugin has no migrate goal; `meta migrate` is correct.

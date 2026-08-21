# Command-line tools (per-port CLI matrix)

MetaObjects deliberately does **not** ship one universal binary. Per the CLI
architecture locked in
[`docs/superpowers/specs/2026-05-30-ts-schema-authority-consolidation-design.md`](../superpowers/specs/2026-05-30-ts-schema-authority-consolidation-design.md)
and [ADR-0015](../../spec/decisions/ADR-0015-single-shared-migrate-engine.md), the
command surface splits in two:

- **Schema is language-agnostic** — it operates on the shared canonical metadata +
  a DB connection. It lives in **one canonical Node `meta` CLI** (`migrate`,
  `verify --db`), used by any project regardless of backend language. This is the
  "Flyway/Atlas-style standalone tool" model — not re-implemented per language.

  **A non-TS adopter needs Node (or Bun) to create or evolve a database.** No
  pre-built binary is published today — releases carry no binaries, and a
  self-built single-file executable still needs the `pg` peer resolvable for the
  Postgres dialect (see the `@metaobjectsdev/cli` README). Plan for `npx meta …`
  in your build, or vendor the CLI. Shipping a real release binary is tracked as
  future work; until it exists, this doc will not claim one.
- **Codegen is inherently language-specific** (`codegen-spring` is Java,
  `codegen-ts` is TS, …) — so it runs in **each language's own build tool**. There
  is no unified codegen binary, no proxying, and no `meta-ts`/`meta-java` names.

## The matrix

| Capability | Tool | Invocation | Notes |
|---|---|---|---|
| Project scaffold (`init`) | Node `meta` | `meta init` | TS projects |
| **Agent-context scaffold** (`agent-docs`) | **Node `meta`** | `npx meta agent-docs --server <lang>` | **any backend** — single assembler (ADR-0033); non-Node CLIs redirect here |
| **Schema migrate** | **Node `meta`** | `meta migrate` | **any backend** — schema is Node-only (ADR-0015) |
| **Schema drift** (`verify --db`) | **Node `meta`** | `meta verify --db` | **any backend** — live-DB drift, Node-only |
| **Codegen drift** (`verify --codegen`) | **Node `meta`** | `meta verify --codegen` | TS reference (ADR-0021 D2) — regen-to-temp + diff committed output |
| **Template/prompt drift** (`verify --templates`) | **Node `meta`** | `meta verify --templates` | TS reference (ADR-0021 D2) — `{{field}}`↔payload; the bare-`verify` default |
| **Vocabulary search** (`types`) | **Node `meta`** | `meta types [query]` | **any backend** — apropos/`kubectl explain` over the live metamodel registry (names + descriptions + when-to-use); the vocabulary is cross-port identical (registry-conformance) |
| TS codegen | Node `meta` | `meta gen` | TS projects |
| C# codegen | `dotnet meta` | `dotnet meta gen` / `verify --templates` / `verify --codegen` | a .NET tool (`ToolCommandName=dotnet-meta`); invoked `dotnet meta` so it never shadows the Node `meta`; ships the ADR-0021 D2 subverbs (`--db` rejected, exit 2; bare `verify` = `--templates`). `gen` also accepts `--template-spec <json>` (+ `--template-root <dir>`, default `templates`) — the declarative Mustache template-codegen surface (the cross-port JSON contract shared with Python); see [declarative template scopes](codegen-concepts.md#declarative-template-scopes) |
| Java/Kotlin codegen | Maven plugin | `mvn metaobjects:generate` (`metaobjects:generate`) | Kotlin generators run through the same goal — see below. The `generate`/`verify`/`docs` goals are declared `threadSafe` and support parallel multi-module reactor builds (`mvn -T`) (#233) |
| Java/Kotlin verify | Maven plugin | `mvn metaobjects:verify -Dmeta.verify.mode=codegen\|templates` (`metaobjects:verify`) | parameter-driven ADR-0021 D2 modes (one goal covers BOTH Java + Kotlin): `codegen` (default, back-compat — regen + fail on drift vs committed output, generator-neutral) / `templates` (`{{field}}`↔payload drift via the render `Verify` engine). `db` rejected ("schema verify is the migrate engine, ADR-0015") |
| Python codegen | console-script | `metaobjects gen` / `verify --codegen` / `verify --templates` | `[project.scripts] metaobjects` — **not** `meta` (that's the Node schema CLI); ships the ADR-0021 D2 subverbs (`--db` rejected, exit 2). `gen` also accepts `--template-spec <json>` (+ `--templates <dir>`, default `templates`) — the declarative Mustache template-codegen surface (the cross-port JSON contract shared with C#); see [declarative template scopes](codegen-concepts.md#declarative-template-scopes) |

## `verify` is one verb with explicit subverbs (ADR-0021 D2)

Historically `verify` meant *different things per port* (TS/C# = template drift,
Java/Python = codegen drift, `--db` = schema drift) and the modes were not
parallel. [ADR-0021 D2](../../spec/decisions/ADR-0021-codegen-surface-coherence.md)
fixes that: **`verify` is one verb with three explicit subverbs**, one
vocabulary everywhere, each port implementing the modes it supports.

| Subverb | What it checks | Touches a DB? |
|---|---|---|
| `verify --db` | **Schema drift** — does the live database (or snapshot) match the metadata? (migrate engine, ADR-0015) | yes |
| `verify --codegen` | **Codegen drift** — regenerate from metadata into a temp dir and fail if it differs from the committed generated output. Catches "metadata changed but `meta gen` wasn't re-run" and "someone hand-edited a generated file". | no |
| `verify --templates` | **Template/prompt drift** — `Renderer.verify` checks each `template.*` node's `{{field}}` references against its payload VO (FR-004). | no |

Rules of the contract:

- **Combinations aggregate.** Pass any mix (`verify --db --codegen --templates`);
  each selected mode runs and the **exit code is non-zero if *any* mode reports
  drift**.
- **Bare `verify` = the port's documented back-compat default.** TS/C# default to
  `--templates`; Java/Python default to `--codegen`. In every case bare `verify`
  also prints a one-line note advertising the explicit subverbs.
- **`--codegen` needs to know where the committed output lives.** It diffs
  against the configured `outDir` (and any per-target `outDir`) from
  `metaobjects.config.ts`. With no config it errors clearly (exit 2) rather than
  silently passing — there is nothing to diff against.
- **Unknown/invalid flag → exit 2** with usage.

**Port status (staged per ADR-0021):** the **TypeScript Node `meta` is the
reference** and implements all three subverbs today. **Python `metaobjects`
ships the subverbs**: `verify --codegen` (regen-to-temp + diff vs `--out`, the
historical default), `verify --templates` (each `template.*` node's `{{field}}`
↔ payload-VO field tree via the render `verify()` gate, resolving refs through a
filesystem provider rooted at `--templates-root`), and `verify --db` which is
**cleanly rejected with exit 2** ("schema verify is the migrate engine,
ADR-0015"). Bare `verify` stays `--codegen` for back-compat. The **C# `dotnet
meta`** port likewise ships the codegen-side subverbs: `verify --templates` (its
historical template/prompt drift gate, the C# back-compat default), `verify
--codegen` (regenerate the default generator suite to a temp dir and diff against
the committed `--out` tree, never touching it), and a **clean `--db` rejection
(exit 2)** — bare `dotnet meta verify` keeps `--templates` and prints the subverb
note. The **Java/Kotlin `mvn metaobjects:verify`** port expresses the same vocabulary as a
`mode` parameter (Maven goals are parameter-driven, not flag-driven): `-Dmeta.verify.mode=codegen`
(default, byte-identical to the historical goal — regen-to-temp + diff vs committed
output; drift is computed per **unique `outputDir`** over the whole `<generators>`
selection, so several generators may share one `outputDir` without cross-flagging each
other's committed files as stale) and `-Dmeta.verify.mode=templates` (each `template.*` node's `{{field}}`↔payload-VO
field tree via the render `Verify` engine, resolving refs through a filesystem provider rooted
at `-Dmeta.verify.templateRoot`). The one goal covers BOTH Java (`codegen-spring`) and Kotlin
(`codegen-kotlin`) since they share it. `mode=db` is **cleanly rejected** ("schema verify is the
migrate engine, ADR-0015"); an unknown mode fails listing the valid ones. (Schema `--db` remains
Node-only by the ADR-0015 design — see below.)

## Declarative config (`metaobjects.config.yaml`) — Python codegen

Alongside its flag-only mode (`metaobjects gen <metadata_dir> --out <dir>`), the
Python `metaobjects` CLI supports a declarative project config,
`metaobjects.config.yaml` (#267). The **schema keys are identical to the TS
`metaobjects.config.ts` vocabulary** — a polyglot adopter learns one
targets-registry shape regardless of port. A JSON Schema ships at
[`server/python/src/metaobjects/codegen/metaobjects-config.schema.json`](../../server/python/src/metaobjects/codegen/metaobjects-config.schema.json)
for editor autocomplete and non-Python validation.

```yaml
metadata: metaobjects            # optional, default "metaobjects" — relative to this file
providers:                       # optional; "module:symbol" refs, resolved config-relative (no PYTHONPATH=)
  - my_project.providers:register_custom_types
libraries: [ai]                  # optional; MetaObjects-shipped library packages (see below)
targets:
  api:
    outDir: src/generated/api
    generators: [entity, routes] # optional; stable names from `metaobjects gen --list`; omit = default suite
  admin:
    outDir: src/generated/admin
    entities: [Author, Book]     # optional allowlist; omit = every entity
```

- **`metaobjects gen`** with no positional `<metadata_dir>` runs config mode:
  it loads the config and metadata once and runs every target into its own
  `outDir`, with a cross-target guard against two targets writing the same
  output path. `--target <name>` scopes the run to a single target.
- **`metaobjects verify --codegen`** — including bare `verify`, since
  `--codegen` is the Python default (see above) — runs the matching config
  mode with no positional `<metadata_dir>`: it regenerates the whole selection
  into a temp tree (the exact `gen` pipeline, including the cross-target
  duplicate-output-path guard) and diffs each **unique `outDir`** against the
  union of the co-resident targets' regen, aggregating the exit code (non-zero
  if *any* outDir has drifted). Targets sharing an `outDir` are verified
  together, so a shared `outDir` is never a false-positive `extra`. `--target`
  widens to the `outDir`-sharing closure (an `outDir` is verified as a unit).
  Strict-attr loading (ADR-0023) still applies unless `--lax` is passed.
- **`--config <path>`** picks the config file explicitly on either command;
  with no positional metadata dir and no `--config`, both commands default to
  looking for `./metaobjects.config.yaml` in the current directory.
- **Providers resolve config-relative.** A `providers:` entry is imported
  with the config file's own directory prepended to `sys.path`, so a
  consumer provider module living beside the config resolves with no
  `PYTHONPATH=` needed (unlike the flag-only `--provider module:symbol`
  path, which relies on the ambient environment).
- **Back-compat is load-bearing.** Passing an explicit positional
  `<metadata_dir>` (with `--out` on `gen`, or `--out` on `verify --codegen`)
  keeps the original flag-only path byte-identical — the config file is never
  consulted. Config mode activates only when no positional `<metadata_dir>`
  is given.

## `libraries` — opting into a MetaObjects-shipped library package

MetaObjects ships a small set of standard metadata packages under `library/`. A project
opts into one by name, and its nodes become available to `extends`:

```ts
// metaobjects.config.ts  (Node `meta`)
export default defineConfig({
  libraries: ["ai"],             // makes metaobjects::ai::LlmCallBase resolvable
  generators: [entityFile()],
});
```

```yaml
# metaobjects.config.yaml  (Python `metaobjects`)
libraries: [ai]
```

```jsonc
// then, in your own metadata
{ "object.entity": { "name": "AgentCall", "extends": "metaobjects::ai::LlmCallBase", ... } }
```

- **Opt-in, never automatic.** A library package registers real top-level nodes. A project
  that never references one should not find them in its model, its generated output or its
  docs — so nothing is loaded until the key names it.
- **An unknown name is a hard config error** that lists the packages this version ships.
  The programmatic loader API skips an unrecognised package instead, deliberately: an API
  caller asking for something a given version does not ship should still be able to load
  its own metadata, but a name a human typed into a config file is a mistake worth failing
  on — skipped, it resurfaces later as `ERR_UNRESOLVED_SUPER` pointing at the adopter's own
  metadata, which is the wrong place to send someone looking.
- **Every command that loads metadata honours it** — `gen`, `verify`, `docs`, `migrate`,
  `prompt-snapshot`. It was previously reachable only from the programmatic
  `MetaDataLoader.fromDirectory`, which no CLI uses, so a generator that consumes a library
  was registered *for* the command line while its input was unreachable *through* it
  ([#333](https://github.com/metaobjectsdev/metaobjects/issues/333)).

On the JVM the same opt-in is a pom element, read by `metaobjects:generate` and
`metaobjects:verify`:

```xml
<loader>
  <name>my-model</name>
  <libraries><library>ai</library></libraries>
</loader>
```

and programmatically, `MetaDataLoader.fromDirectory(name, dir, opts, List.of("ai"))` or
`loader.setLibraries(List.of("ai"))` before `init()`. Java had neither the option nor an
embed until [#332](https://github.com/metaobjectsdev/metaobjects/issues/332): the port
shipped `LlmTraceHelperGenerator` with no way to load the metadata that generator exists to
consume, and its tests stayed green only by declaring a bespoke `LlmCallBase` inline under
a different package — the bypass ADR-0024 already named, and the reason a port can ship a
generator it cannot feed without anyone noticing.

## `meta gen` / `meta verify` run an advisory anti-pattern pass (Node `meta`)

Both `meta verify` and a real `meta gen` write run (not `--dry-run`) end with a
**"verify-as-teacher"** advisory scan over your authored source. It flags a few
high-precision constructs you hand-rolled that the metadata could model and names
the construct that replaces it:

| Hand-rolled pattern | Suggested construct |
|---|---|
| an aggregate computed by hand (SQL `AVG`/`SUM`, a summing `.reduce(...)`) | `origin.aggregate` (on an `object.projection`) |
| money as a float / hand-rolled minor units (a money-named field with `* 100`, `/ 100`, `.toFixed(2)`, `parseFloat`) | `field.currency` |
| a fixed value set enforced by a SQL `CHECK (... IN (...))` | `field.enum` |

It is **warnings only** — it never changes the exit code (bias to under-flagging;
a >15% false-positive rate is a project kill criterion). Suppress it with
`--no-antipatterns` on either command, or `META_NO_ANTIPATTERNS=1` in the
environment. This pass is **Node-`meta`-specific**; the C#/Java/Kotlin/Python
codegen surfaces do not run it.

## Schema is Node-only — by design

No port other than the Node `meta` exposes `migrate` or `verify --db`. The C#,
Java, Python, and Kotlin command surfaces are **codegen only** (`gen` + codegen
`verify`). The Java port's former `metaobjects:migrate` / live-DB `metaobjects:verify` Maven
goals and the C#/Python migrate surfaces were removed in the schema-authority
consolidation; the only schema entry point anywhere is the Node `meta`.

## Migration output formats (`--migration-format`)

The engine generates the up/down SQL **once**; a pluggable output adapter decides
the file envelope ([ADR-0015](../../spec/decisions/ADR-0015-single-shared-migrate-engine.md) §3).
The format is **orthogonal to dialect** — a Flyway shop is still on postgres or
sqlite — so it is its own flag:

| Format | Layout | Selected by |
|---|---|---|
| `default` | `<ts>-<slug>/up.sql` + `down.sql` | default |
| D1/Wrangler | `<seq>_<slug>.sql` + `.down/<same>` | `--dialect d1` |
| `flyway` | `V<N>__<slug>.sql` + `U<N>__<slug>.sql` | `--migration-format flyway` |

**Why `--migration-format` and not `--format`:** `--format` is already the global
output-rendering flag (`toon` / `json` / `text`). The config key, being namespaced
under `migrate`, has no such clash — set `migrate.format` once in
`.metaobjects/config.json` and a JVM shop never passes the flag. The flag wins
over the config key.

**Flyway specifics (#192).** This is the adapter ADR-0015 designated when the Java
`meta:migrate --flyway` mojo was removed. Versions are assigned by scanning the
target dir for the highest `V<N>__` and incrementing, so it composes with
hand-authored migrations already present; a dotted version (`V10.5__`) increments
on its leading integer. The down SQL is emitted as `U<N>__` — Flyway's own undo
convention. Undo is a paid Flyway edition feature and **Community ignores `U__`
files** rather than failing, so they are inert-but-correct there and become live on
Teams/Enterprise. Output dir defaults to Flyway's convention
`src/main/resources/db/migration`; `--out-dir` overrides it.

**Flyway owns apply.** `--apply`, `apply-pending` and `--rollback` are **refused**
under this format, each naming the Flyway command instead: writing behind Flyway
desyncs its `flyway_schema_history`. Generate with `meta migrate`, apply with
`flyway migrate`. `--dialect d1` with `--migration-format flyway` is also refused —
D1 has its own Wrangler layout and transport.

```bash
meta migrate --db "$DB_URL" --dialect postgres \
  --migration-format flyway --slug add_program_view
# -> src/main/resources/db/migration/V4__add_program_view.sql
# -> src/main/resources/db/migration/U4__add_program_view.sql
```

## Agent-context scaffold is Node-only — by design

The `.metaobjects/AGENTS.md`/`CLAUDE.md` always-on files and the
`.claude/skills/metaobjects-*/` reference tree are assembled by **one** tool: the
Node `meta agent-docs` command. Per [ADR-0033](../../spec/decisions/ADR-0033-single-agent-context-assembler.md)
the per-port native assemblers (Python/Java/C#) and their byte-identity conformance
gates were removed — that content is effectively one static artifact, and every port
already needs the Node `meta` CLI or its binary for schema ops (ADR-0015).

```bash
npx meta agent-docs --server <lang>    # csharp | java | kotlin | python | node
```

The C#, Java/Kotlin, and Python CLIs keep a **non-executing `agent-docs` pointer
stub** that prints `agent-context scaffolding moved to the meta CLI — run: npx meta
agent-docs --server <lang>` to stderr and exits non-zero. The **live staleness check**
in `gen`/`verify` stays per-port (it only *reads* the scaffold to nudge when it drifts);
its message now points at `npx meta agent-docs --server <lang>`.

## Running Kotlin codegen via Maven

`codegen-kotlin`'s generators extend `MultiFileDirectGeneratorBase` — the same
generator SPI the `metaobjects:generate` Mojo loads — so they run through the existing goal
with no Kotlin-specific Mojo. Configure a Kotlin generator on the Maven plugin:

```xml
<plugin>
  <groupId>com.metaobjects</groupId>
  <artifactId>metaobjects-maven-plugin</artifactId>
  <configuration>
    <generators>
      <generator>
        <classname>com.metaobjects.generator.kotlin.KotlinEntityGenerator</classname>
        <args><outputDir>${project.build.directory}/generated-sources/kotlin</outputDir></args>
      </generator>
    </generators>
  </configuration>
</plugin>
```

`mvn metaobjects:generate` emits the Kotlin sources; `mvn metaobjects:verify`
codegen-drift-checks them. See `server/java/codegen-kotlin/README.md` for the full
generator list.

# Command-line tools (per-port CLI matrix)

MetaObjects deliberately does **not** ship one universal binary. Per the CLI
architecture locked in
[`docs/superpowers/specs/2026-05-30-ts-schema-authority-consolidation-design.md`](../superpowers/specs/2026-05-30-ts-schema-authority-consolidation-design.md)
and [ADR-0015](../../spec/decisions/ADR-0015-single-shared-migrate-engine.md), the
command surface splits in two:

- **Schema is language-agnostic** — it operates on the shared canonical metadata +
  a DB connection. It lives in **one canonical Node `meta` CLI** (`migrate`,
  `verify --db`), used by any project regardless of backend language, shipped as a
  standalone binary so non-TS adopters need no Node toolchain for schema ops. This
  is the "Flyway/Atlas-style standalone tool" model — not re-implemented per
  language.
- **Codegen is inherently language-specific** (`codegen-spring` is Java,
  `codegen-ts` is TS, …) — so it runs in **each language's own build tool**. There
  is no unified codegen binary, no proxying, and no `meta-ts`/`meta-java` names.

## The matrix

| Capability | Tool | Invocation | Notes |
|---|---|---|---|
| Project scaffold (`init`) | Node `meta` | `meta init` | TS projects |
| **Schema migrate** | **Node `meta`** | `meta migrate` | **any backend** — schema is Node-only (ADR-0015) |
| **Schema drift** (`verify --db`) | **Node `meta`** | `meta verify --db` | **any backend** — live-DB drift, Node-only |
| **Codegen drift** (`verify --codegen`) | **Node `meta`** | `meta verify --codegen` | TS reference (ADR-0021 D2) — regen-to-temp + diff committed output |
| **Template/prompt drift** (`verify --templates`) | **Node `meta`** | `meta verify --templates` | TS reference (ADR-0021 D2) — `{{field}}`↔payload; the bare-`verify` default |
| TS codegen | Node `meta` | `meta gen` | TS projects |
| C# codegen | `dotnet meta` | `dotnet meta gen` / `verify` | a .NET tool (`ToolCommandName=dotnet-meta`); invoked `dotnet meta` so it never shadows the Node `meta` |
| Java/Kotlin codegen | Maven plugin | `mvn metaobjects:generate` (`meta:gen`) | Kotlin generators run through the same goal — see below |
| Java/Kotlin codegen drift | Maven plugin | `mvn metaobjects:verify` (`meta:verify`) | regenerate + fail on drift vs committed output (generator-neutral) |
| Python codegen | console-script | `metaobjects gen` / `verify` | `[project.scripts] metaobjects` — **not** `meta` (that's the Node schema CLI) |

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
- **Bare `verify` = `--templates`** (documented back-compat default). It also
  prints a one-line note advertising the explicit subverbs.
- **`--codegen` needs to know where the committed output lives.** It diffs
  against the configured `outDir` (and any per-target `outDir`) from
  `metaobjects.config.ts`. With no config it errors clearly (exit 2) rather than
  silently passing — there is nothing to diff against.
- **Unknown/invalid flag → exit 2** with usage.

**Port status (staged per ADR-0021):** the **TypeScript Node `meta` is the
reference** and implements all three subverbs today. The other ports (C#
`dotnet meta`, Java/Kotlin `mvn meta:verify`, Python `metaobjects`) converge on
the same subverb vocabulary in staged, conformance-gated follow-on slices; each
keeps its current behavior as the bare-`verify` default until it adopts the
explicit subverbs. (Schema `--db` remains Node-only by the ADR-0015 design — see
below.)

## Schema is Node-only — by design

No port other than the Node `meta` exposes `migrate` or `verify --db`. The C#,
Java, Python, and Kotlin command surfaces are **codegen only** (`gen` + codegen
`verify`). The Java port's former `meta:migrate` / live-DB `meta:verify` Maven
goals and the C#/Python migrate surfaces were removed in the schema-authority
consolidation; the only schema entry point anywhere is the Node `meta`.

## Running Kotlin codegen via Maven

`codegen-kotlin`'s generators extend `MultiFileDirectGeneratorBase` — the same
generator SPI the `meta:gen` Mojo loads — so they run through the existing goal
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

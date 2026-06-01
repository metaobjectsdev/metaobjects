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
| TS codegen | Node `meta` | `meta gen` | TS projects |
| C# codegen | `dotnet meta` | `dotnet meta gen` / `verify` | a .NET tool (`ToolCommandName=dotnet-meta`); invoked `dotnet meta` so it never shadows the Node `meta` |
| Java/Kotlin codegen | Maven plugin | `mvn metaobjects:generate` (`meta:gen`) | Kotlin generators run through the same goal — see below |
| Java/Kotlin codegen drift | Maven plugin | `mvn metaobjects:verify` (`meta:verify`) | regenerate + fail on drift vs committed output (generator-neutral) |
| Python codegen | console-script | `metaobjects gen` / `verify` | `[project.scripts] metaobjects` — **not** `meta` (that's the Node schema CLI) |

## Two meanings of `verify` — keep them distinct

- **Schema `verify --db`** (Node `meta`, any backend): live-DB drift — does the
  database match the metadata? Node-only, ADR-0015.
- **Codegen `verify`** (`dotnet meta verify`, `mvn meta:verify`, `metaobjects
  verify`): regenerate code from metadata into a temp location and fail if it
  differs from the committed generated output — "a teammate changed metadata
  without regenerating → caught". This is the enterprise-CI primitive added per
  port; it does **not** touch a database.
- (Separately, the FR-004 **template/prompt** drift check — `Renderer.verify` —
  also surfaces under `verify` in the ports that ship it; it checks `{{...}}`
  references against the payload VO. It is a third, orthogonal facet.)

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

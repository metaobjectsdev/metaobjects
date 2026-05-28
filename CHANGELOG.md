# Changelog

All notable changes to `@metaobjectsdev/*` TypeScript packages are documented
here. The format follows [Keep a Changelog](https://keepachangelog.com/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
(pre-1.0; MINOR bumps may introduce breaking changes with notice).

## [Unreleased]

## [0.7.0-rc.9] — 2026-05-27

### Added
- **`routesFileHono()` stock generator** — emits Hono route registration
  (`register<Entity>Routes(app, { db })`) for every writable entity,
  cross-port-API-contract-conformant with the existing Fastify
  `routesFile()`. Lets Cloudflare-Workers / Hono-server consumers
  codegen the CRUD-5 endpoints they previously hand-wrote. New helper
  `parseHonoFilterParams` ships in `@metaobjectsdev/runtime-ts/hono`
  (parallel to the existing drizzle-fastify export).

## [0.7.0-rc.8] — 2026-05-27

### Fixed
- **Java: generic required-attr enforcement.** Pre-rc.8, Java required-attr
  validation was per-subtype (an explicit block per subtype that wanted it).
  rc.8 adds a generic pass mirroring TS / C# / Python: any node whose schema
  declares `required: true` attrs that are absent on the loaded node fires
  `ERR_MISSING_REQUIRED_ATTR`. The previously-explicit R1 (prompt) and R1b
  (toolcall) blocks in ValidationPhase collapse into the generic pass.
  Closes a latent contract gap surfaced during the rc.7 cross-port
  `template.toolcall` rollout.

### Changed
- **Hardcoded type-count guards in TS / C# tests** are now derived from
  the schema constants. Previously `expect(allTypes).toHaveLength(70)` (TS)
  / `Core_provider_registers_exactly_70_types` (C#) bumped manually on every
  new subtype; now they assert each base type's subtype list directly,
  catching drift only where it matters (in the relevant subtype family
  rather than a global integer).

## [0.7.0-rc.7] — 2026-05-27

### Added
- **`template.toolcall` reaches Java + C# + Python cores** — the TS port
  shipped the subtype in rc.5/rc.6; this release brings the other three
  ports to parity per ADR-0011. Same vendor-agnostic attrs (`@toolName`
  required, `@payloadRef` required, plus governance `@owner`/`@since`).
  Same "no `@textRef` requirement" — toolcalls have no renderable body.
  Kotlin inherits the Java port. The provider-extension conformance
  fixtures (which moved to `template.briefing` in rc.5) continue to gate
  the provider-extension contract cross-port; the new core subtype gets
  its own coverage in each port's unit tests.
- **`registry.extend()` on Python `TypeRegistry`** (`@metaobjectsdev/metadata`
  Python equivalent) — closes the cross-port parity gap surfaced during
  rc.3 implementation. Same signature semantics as the TS and C# versions:
  raises `ERR_PROVIDER_ATTR_CONFLICT` on duplicate attr; `ERR_UNKNOWN_SUBTYPE`
  if the target (type, subType) isn't registered.

### Fixed
- No TS source changes vs rc.6; the version bump keeps the rc.N marker
  aligned across the four-port release surface.

## [0.7.0-rc.6] — 2026-05-27

### Fixed
- **rc.5 declared `@description` as a per-subtype attr on `template.toolcall`**,
  which conflicted with the `@description` common-attr that `docProvider` adds
  to every type — surfacing as `"Common attr 'description' conflicts with
  per-type attr on template.toolcall"` at load time. rc.5 was therefore
  unusable for any consumer with template.toolcall metadata. rc.6 removes
  the duplicate declaration; tool descriptions surfaced to the LLM read the
  same `@description` common attr that doc-gen uses. No consumer-facing API
  shift beyond the bug fix.

## [0.7.0-rc.5] — 2026-05-27

### Added
- **`template.toolcall` is now a core MO subtype** (`@metaobjectsdev/metadata`)
  per [ADR-0011](spec/decisions/ADR-0011-template-toolcall-as-core-subtype.md).
  Three vendor-agnostic attrs: `@toolName` (required), `@payloadRef`
  (required, points at the output value-object), `@description` (optional,
  surfaced to the LLM for tool selection). Plus the governance attrs
  `@owner` / `@since`.

  Critically: **`template.toolcall` does NOT inherit `genericAttrs`** the way
  `template.prompt` and `template.output` do. No `@textRef` requirement — a
  tool-call has no renderable text body; the body IS the structured output
  schema resolved via `@payloadRef`. This is the design rationale for
  toolcall being its own subtype rather than `template.output + @toolName`.

  Vendor wire details (Anthropic's retry-with-reminder, OpenAI's function-
  calling envelope, MCP's tool definitions, etc.) are NOT in core. Consumers
  add vendor specifics via `registry.extend(TYPE_TEMPLATE, "toolcall",
  { attributes: [...] })` — same pattern `dbProvider` uses for `source.rdb`.

  Cross-port rollout: TS ships in rc.5; Java / C# / Python in a follow-up.
  Kotlin inherits the Java port.

### Changed
- Conformance fixtures `provider-extension-new-subtype-success` and
  `provider-extension-missing-provider-fails` swap their test-only provider
  from `example-template-toolcall` (now meaningless — toolcall is core) to
  `example-template-briefing` (a hypothetical briefing template, clearly
  fictional). The fixtures still demonstrate `registry.register` of a new
  subtype, just using a name that doesn't collide with the new core
  subtype. TS / C# / Python adapter providers and fixture inputs/expected
  files updated to match.

- `template-constants.ts` design comment refreshed to acknowledge three
  template subtypes (prompt / output / toolcall) and document each one's
  attr-schema basis. Internal-only — no consumer-facing change beyond the
  ADR + the new exports (`TEMPLATE_SUBTYPE_TOOLCALL`, `TEMPLATE_ATTR_TOOL_NAME`,
  `TEMPLATE_ATTR_DESCRIPTION`).

## [0.7.0-rc.4] — 2026-05-27

### Fixed
- **rc.3 was packed with stale `dist/`** — the CLI's `meta gen` /
  `meta verify` / `meta migrate` / `meta prompt-snapshot` commands did
  not actually thread `config.providers` through to `loadMemory` on
  npm, even though the source had the change. Same for `loadMemory`'s
  `providers` option support in `@metaobjectsdev/sdk`. rc.4 ships with
  a fresh build so the providers API is actually live for consumers.
- Side-effect of the fixture refactor investigation: the docs
  `extending-with-providers.md` § "When to add a subtype vs. an attr"
  gained two real-world escalation triggers (existing subtype's
  required attrs don't apply; load-time error detection requires
  subtype since `@-attrs` follow open policy).

No API change vs. rc.3 — only the published artifacts now match the
documented behavior.

## [0.7.0-rc.3] — 2026-05-27

### Added
- **Consumer-supplied providers via `loadMemory({ providers })`**
  (`@metaobjectsdev/sdk`, `@metaobjectsdev/codegen-ts`, `@metaobjectsdev/cli`) —
  the SDK's `loadMemory(repoRoot, opts?)` now accepts a `providers?:
  readonly MetaDataTypeProvider[]` option. Consumers (and the codegen
  config) can register additional metamodel subtypes/attrs without
  forking the loader.

  - Defaults stay back-compatible: the bundle composed is
    `[...coreProviders, forgeTypesProvider, ...(opts.providers ?? [])]`.
    `forgeTypesProvider` is now a first-class `MetaDataTypeProvider`
    (id `"metaobjects-forge"`, depends on `"metaobjects-core-types"`);
    the legacy `registerForgeTypes()` is a thin back-compat wrapper.
  - Advanced opt-out: `loadMemory(root, { providers: [...], replaceDefaults:
    true })` skips the default bundle entirely; the caller owns the full
    provider set.
  - Codegen config: `MetaobjectsGenConfig.providers?` lets a project's
    `metaobjects.config.ts` declare its providers once. The CLI's `gen`
    / `verify` / `migrate` / `prompt-snapshot` commands all read the
    config and thread `config.providers` into `loadMemory` — no silent
    skipping, no per-command divergence.
  - Stable error codes: composition surfaces `ERR_PROVIDER_DUPLICATE_ID`,
    `ERR_PROVIDER_MISSING_DEPENDENCY`, `ERR_PROVIDER_DEPENDENCY_CYCLE`
    via `composeRegistry`. The contract is identical across Java, TS,
    C#, and Python.

- **Cross-port parity (TS / C# / Python; Java deferred).** Java already
  has SPI auto-discovery for type providers; a programmatic `compose()`
  factory parallel to TS `composeRegistry` is deferred to a follow-up.

  - **C#:** the runtime API entry is `MetaDataLoader.FromDirectory(dir,
    registry)`, which already takes a custom registry; `Provider.
    ComposeRegistry(providers)` is the supported composition surface.
    New `ProviderExtensionTests` (6 cases) assert the cross-port
    contract end-to-end.
  - **Python:** `MetaDataLoader.from_directory(dir, providers=...)`
    already accepts a provider list; the conformance adapter now
    discovers `providers.json` per fixture (parity with C#). New
    `tests/unit/test_provider_extension.py` (5 cases) mirrors the TS
    test suite.

- **5 conformance fixtures** under `fixtures/conformance/` exercising
  the contract cross-port:
  `provider-extension-new-subtype-success` (positive: a test-only
  `example-template-toolcall` provider registers `template.toolcall`),
  `provider-extension-missing-provider-fails` (`ERR_UNKNOWN_SUBTYPE`),
  `provider-extension-dependency-cycle` (`ERR_PROVIDER_DEPENDENCY_CYCLE`),
  `provider-extension-missing-dependency`
  (`ERR_PROVIDER_MISSING_DEPENDENCY`), and
  `provider-extension-duplicate-id` (`ERR_PROVIDER_DUPLICATE_ID`).
  Each fixture's `providers.json` is the public seam — explicit
  `providers` declarations bypass any ambient discovery, so the
  fixture's declared set is exactly the set the loader composes.

## [0.7.0-rc.2] — 2026-05-27

### Added
- **`entityFile({ allowlists: false })` opt-in flag** (`@metaobjectsdev/codegen-ts`) —
  Worker/Lambda consumers can disable the Fastify-flavored
  `<Entity>FilterAllowlist` + `<Entity>SortAllowlist` emission. Generated
  entity files then carry no `@metaobjectsdev/runtime-ts/drizzle-fastify`
  imports at all and `runtime-ts` can be omitted from the consumer's deps
  entirely. The client-side `<Entity>Filter` type is still emitted (zero
  runtime-ts dependency). Default remains `true` for back-compat; consumers
  using `routesFile()` should leave the default. Closes the long-term
  recommendation from the 0.7.0-rc.1 Worker-consumer friction batch
  (commit bd0bcb8).
- **Loader error envelope + source-on-node** (`@metaobjectsdev/metadata`) —
  per [ADR-0009](spec/decisions/ADR-0009-loader-error-envelope-and-source-on-node.md),
  every `MetaData` node now carries a `source: ErrorSource` provenance field
  (`{ format: "json", files: [...], jsonPath: "..." }` for loaded nodes;
  `{ format: "code" }` for programmatically constructed). `ParseError` now
  conforms to the cross-port `LoaderError` schema: required `code`, required
  `message`, required `source` envelope. New `LoadResult.warnings:
  LoaderWarning[]` channel (legacy parser/validator strings are wrapped at
  the loader boundary as `WARN_LEGACY` envelopes; future overlay-merge
  detection in FR5c will be the first feature to emit native envelope-shaped
  warnings). New public exports from `@metaobjectsdev/metadata`:
  `ErrorSource`, `LoaderError`, `LoaderWarning`, `NodeContext`, `Contributor`
  types, plus the `codeSource()` helper. Foundation for FR5b (YAML
  positions), FR5c (multi-file merge attribution), FR5d (reference-resolution
  errors), FR5e (database-source errors).
- **`outputParser()` stock generator** in `@metaobjectsdev/codegen-ts/generators` —
  for every declared `template.output`, emits a typed Zod parser file with a
  dual-API surface (`parseXxx(text)` throws, `safeParseXxx(text)` returns
  Result). Field-type → Zod-type mapping covers all scalars, arrays, and
  nested `field.object` with `@objectRef`. The emitted file is self-contained
  (no cross-file payload import) and exports a `<TemplateName>Data` type-alias
  derived via `z.infer`; consumers who also wire `promptRender()` can use the
  payload-VO interface from `prompts.ts` interchangeably (structurally
  identical). Wire it into `metaobjects.config.ts`:
  `generators: [..., outputParser()]`.
- **`meta verify` extension** for `template.output` drift — the build-time
  drift gate now checks both subtypes. Output diagnostics carry `(output)`
  prefix; prompt diagnostics gain `(prompt)` prefix for symmetry.
- **Conformance fixture `template-output-simple`** — shared cross-language
  corpus gains `input/meta.npc.json`, `expected.json`, and
  `expected/NpcResponseOutput.output.ts` byte-exact codegen artifact. TS
  conformance runner verifies `outputParser()`'s output matches.
- **`source.rdb` discriminator filters entity-file emission**
  (`@metaobjectsdev/codegen-ts`) — metaobjects without a writable
  `source.rdb` child now route through a streamlined value-only path
  emitting only the structural TS interface + `<Name>InsertSchema` Zod
  schema. The Drizzle table, `InferSelectModel`/`InferInsertModel`
  aliases, `<Entity>FilterAllowlist`/`<Entity>SortAllowlist`,
  `<Entity>Filter` type, and `$entity`/`$table`/`$path` constants object
  are skipped entirely. Pure metadata-driven discriminator (type=`source`,
  subtype=`rdb`, `MetaSource.isWritable()`) — not an `object.value`
  vs `object.entity` type-ID gate, so the same filter also covers
  transient / in-memory shapes that declare no source. Closes the
  "dead generated tables" smell in consumers that model nested response
  payloads as value objects. Branch slots between `isProjection` and
  the existing vanilla-entity path; both pre-existing paths are
  unchanged. New helper `hasWritableRdbSource(entity)` from
  `@metaobjectsdev/codegen-ts/source-detect`.
- `meta verify` log line format adds `(<subtype>)` after the template name
  (e.g., `[npcTurn] (prompt) ERR_*`). A pre-FR6 log scraper that matched
  on the bare `[name]` prefix needs to update its regex.
- **BREAKING (codegen-ts):** Generated `<Entity>.queries.ts` CRUD helpers now
  accept a Drizzle `db` instance as the **first parameter** of every function
  (`findUserById(db, id)`, `listUsers(db, opts)`, `createUser(db, data)`,
  `updateUser(db, id, data)`, `deleteUserById(db, id)`). The module-level
  `import { db } from "<dbImport>"` line is no longer emitted; instead, every
  file declares a dialect-correct `type Db = ...` alias at the top. Migration:
  bump, regen, search-and-replace call sites — see the new
  [wiring-generated-queries.md](docs/recipes/wiring-generated-queries.md)
  recipe for the full guide. Background: [ADR-0008](spec/decisions/ADR-0008-parameter-passing-generated-repo-helpers.md).
  Enables Cloudflare Workers / edge consumers to drop their typecheck stubs;
  enables multi-tenant servers + test-isolated `db` setups. `routesFile()` is
  unchanged.
- **BREAKING (metadata):** `ParseError` constructor signature changed. Was
  `new ParseError(msg, { code?, source?: string, path? })`; now
  `new ParseError(msg, { code, source: ErrorSource })`. Direct construction
  outside the metadata package is rare (loader-internal API), but anyone
  catching + repackaging a `ParseError` reads `.source` as the new envelope
  type, not a string. Legacy `error.path` is gone — read
  `error.source.jsonPath` instead.
- **BREAKING (metadata):** `LoadResult.warnings` retyped from `string[]` to
  `LoaderWarning[]` per ADR-0009. Consumers that inspected warning content
  via `result.warnings[i].includes(...)` should now read
  `result.warnings[i].message.includes(...)`. The public
  `ExportResult.warnings` (returned by `loadAndExportJson()`) keeps its
  `string[]` shape — extracted via `.map((w) => w.message)`.

See [ADR-0010](spec/decisions/ADR-0010-template-output-parser-codegen.md)
for the cross-port design.

### Fixed
- **`@metaobjectsdev/cli` now pulls `@metaobjectsdev/runtime-ts` transitively.**
  Generated entity files emit `import type { FilterAllowlist, SortAllowlist }
  from "@metaobjectsdev/runtime-ts/drizzle-fastify"` unconditionally; until
  now, consumers who installed only `cli` (the recommended umbrella) hit
  unresolved-import errors on the first `meta gen`. `cli` now declares
  `runtime-ts` as a runtime dependency at the same pinned workspace version.
  The imports are type-only, so the addition has no Worker/Lambda bundle
  impact. (Reported from a 0.7.0-rc.1 Worker consumer.) Long-term, an opt-in
  flag on `entityFile({ allowlists: false })` will let Workers consumers skip
  the imports entirely — that's a separate follow-up.
- **`meta migrate --dialect d1` no longer fails against wrangler's local D1
  sandbox.** `introspectD1` was calling `SELECT sqlite_version()` to populate
  `SnapshotMeta.sqliteVersion`, but workerd blocks that function in the local
  D1 sandbox. The introspector now tries the call once and falls back to a
  static known-good version (`"3.44.0"` — matches Cloudflare D1's shipped
  SQLite) on failure. Remote `wrangler d1 execute` paths still answer the
  function and use the live value. (Reported from the same 0.7.0-rc.1
  consumer.)
- **`field.enum` columns emit Drizzle `text({ enum: [...] as const })`**
  (`@metaobjectsdev/codegen-ts`) — CHECK-constrained enum columns now
  carry an `enum` option on the `text()` call, narrowing Drizzle's
  inferred select-model type from bare `string` to a literal union
  (e.g. `"supports" | "opposes" | ...`). The `as const` suffix is what
  Drizzle's type signature requires to lift the values into the type
  position. Affects every non-array `field.enum`; isArray enum columns
  remain `text({ mode: "json" })` (Zod still validates element membership).
- **`field.object isArray:true objectRef:RefName` emits
  `text({ mode: "json" }).$type<RefName[]>()`**
  (`@metaobjectsdev/codegen-ts`) — SQLite JSON columns storing arrays
  of nested objects now carry a typed element annotation via ts-poet
  `imp()` cross-module hoisting (e.g. `citations: text("citations", {
  mode: "json" }).$type<SourceLens[]>()`). Sibling fix to the scalar
  `.$type<E[]>()` patch from 0.7.0-rc.1; closes the last row-type
  widening case that forced consumers to `as unknown as z.ZodType<>`
  cast the codegen'd `<Name>InsertSchema` at the LLM-tool-use boundary.

## [0.6.0] — 2026-05-25

### Added
- **Cloudflare D1 dialect for `meta migrate`** — `--dialect d1`,
  `meta init --d1`, `wrangler.toml` binding resolution, `introspectD1` via
  shell-out, `renderD1` = `renderSqlite` + D1-safety post-pass (strip explicit
  txns, reject `ATTACH`/`VACUUM`), `writeMigrationD1` (Wrangler
  `<seq>_<slug>.sql` + `.down/` sidecar), optional `--apply` hook. See
  [`docs/superpowers/specs/2026-05-24-meta-migrate-d1-dialect-design.md`](docs/superpowers/specs/2026-05-24-meta-migrate-d1-dialect-design.md).
- Projection (`source.dbView`) migrations now emit DDL for D1 alongside
  Postgres/SQLite.
- New `render` package added to the publish-candidate set (Tier 0); 12
  packages now released in lockstep.

### Changed
- `Dialect` union extended to include `"d1"`; existing `"sqlite"` /
  `"postgres"` paths unchanged.
- `MigrateBlock` in `.metaobjects/config.json` gained an optional `d1`
  sub-block (`binding`, `remote`, `autoApply`, `wranglerConfigPath`).
- Generated `deleteXById(...)` helpers now use `.returning()` so the
  response shape is portable across D1, libsql/Turso, and Postgres (was
  previously libsql/Turso-specific).

### Fixed
- SQL injection in `introspectD1` pragma calls via crafted SQLite identifier
  names; pragma queries now double-quote-escape identifiers (the Kysely-based
  `introspectSqlite` path was already safe via Kysely's parameterization).
- Removed dead `parseWranglerExecuteJson` export from `cli/lib/wrangler.ts`.
- `codegen-ts/src/templates/jsdoc.ts` now satisfies `exactOptionalPropertyTypes`.

### Security
- Pragma identifier injection patched in the D1 introspector; see Fixed.

## [0.5.0] — 2026-05-23

First public release. 11 publish-candidate packages on `latest`; `cli` shipped
as `0.5.1` patch shortly after. Projects D–G shipped end-to-end (typed filter
syntax, source-aware entities + projections, currency, TanStack codegen).
See [`spec/roadmap.md`](spec/roadmap.md) for the full Projects D–G coverage.

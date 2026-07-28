# MetaObjects — Claude Context

## What this project is

MetaObjects is a **cross-language metadata standard** for declaring typed entity models that drive code generation, runtime metadata access, and drift detection — across TypeScript, C#, Java, Python, and Kotlin (Kotlin runs on the JVM via `metadata-ktx` + `codegen-kotlin`).

The metamodel is the **durable spine**; generated code is the **disposable artifact**. Substrate is local-first: typed metadata lives in your repo, generated code is idiomatic per-language output that runs without any MetaObjects dependency at runtime. If `@metaobjectsdev/*` disappears tomorrow, you keep working code.

## Four pillars

Equal weight — all four ship per-language today across the five ports (TS / C# / Java / Python / Kotlin), with cross-port conformance corpora verifying byte-identical behavior:

1. **Codegen** — emit idiomatic per-language code (Drizzle/Zod + Fastify for TS, EF Core + ASP.NET for C#, Spring REST + DTO + Repository for Java via `codegen-spring`, Pydantic + FastAPI for Python, KotlinPoet + Exposed + Spring for Kotlin via `codegen-kotlin`). Hand-edit-preserving regen via three-way merge.
2. **Runtime metadata** — load metadata at runtime, drive behavior dynamically (CRUD, validation, relationships, dynamic admin UIs, LLM tool registration). On Kysely (TS), a DB-API 2 driver via ObjectManager (Python), modernized JDBC + Spring-tx via OMDB (Java), Exposed (Kotlin), EF Core (C#).
3. **Drift detection** — `meta verify` catches divergence between code and metadata (covers entity codegen, prompt templates, output parsers, schema). Quality-of-life on top of codegen + runtime.
4. **Prompt construction** — a prompt is code, not a string scattered across services. Declare a prompt's payload as a typed projection (payload bloat becomes a diff), keep its text external and provider-resolved, and render it deterministically: snapshot-testable, cache-stable (no whitespace change silently breaking exact-prefix prompt-cache hits), and drift-checked at build time so a renamed field can't degrade a prompt. Conformance-gated, so the guarantee holds in every language port. **Render + payload-VO codegen + `verify` + `template.output` parser-on-receipt (FR-006) + the output-format prompt fragment & tolerant `extract` parser (FR-010) ship in all five ports today** — the library-side building blocks of the pillar are complete. The one remaining library-side piece is MCP exposure of declared prompts/tools (see `spec/roadmap.md`); the application-level consolidation (eval harness, end-to-end declared-prompt orchestration) and consumer adoption are exercised in adopter projects, not in this library repo. Designed in `docs/superpowers/specs/2026-05-22-fr-004-cross-language-prompt-construction-design.md`.

## Status

_Last refreshed 2026-07-28._

**TypeScript reference implementation** is **published to npm at `0.20.8`** (14 `@metaobjectsdev/*` publish candidates on the `latest` tag, full lockstep; the two `angular` packages are on their own `0.6.x` line). C# at `0.19.6` (NuGet); Python at `0.19.8` (PyPI); Java / Kotlin at `7.11.6` (Maven Central). **The `0.20.8` line is an npm-only patch** (the changed code is in `migrate-ts` plus a small `cli` call-site threading change; PyPI / NuGet / Maven Central unchanged) — **#241** replaces #226's refusal with an **auto-generated, appliable foreign-key cascade**: `meta migrate --dialect d1` now rebuilds an FK-referenced table on remote D1 by DROPping referrers first, RENAMEing parents into place (parents-first), and wrapping the sequence in `PRAGMA defer_foreign_keys = ON` (D1's implicit transaction makes `PRAGMA foreign_keys = OFF` a no-op, which is why #226 could only refuse rather than fix). It also closes #226's residual under-refuse gap by keying the affected-set on the **union** of the actual and expected FK graphs. Multi-table FK cycles are still refused (unresolvable without a cascade), self-references are handled, and existing `meta gen` / `meta migrate` output is byte-identical for migrations that don't rebuild an FK-referenced table on D1. Follow-up: #243 (dependent-view / Pass-2c interaction). See `CHANGELOG.md` [0.20.8]. **The prior `0.20.7` line was an npm-only patch** (the changed code was all in `cli` / `migrate-ts`; PyPI / NuGet / Maven Central unchanged) — **#226** made `meta migrate --dialect d1` **refuse at generation time** (instead of silently emitting an un-appliable migration) when a change would rebuild a table that another table's foreign key references: on remote D1 the SQLite rebuild recipe's `PRAGMA foreign_keys = OFF` is a no-op inside D1's implicit transaction, so dropping the referenced table failed with `FOREIGN KEY constraint failed` against populated production DBs (self-references included; the auto-cascade fix landed in #241 above); and **#242** added **`meta migrate apply-pending`**, a first-class subcommand that replays the committed migration files against `--db` (ledger-tracked, no diff, no metadata load) — the fresh-DB / CI provisioning path the diff-first `--apply` can't serve. Existing `meta gen` / `meta migrate` output was byte-identical for migrations that didn't rebuild an FK-referenced table on D1. See `CHANGELOG.md` [0.20.7]. **The prior `0.20.6` line is a coordinated PATCH across all four registries** (npm `0.20.6` · PyPI `0.19.8` · Maven `7.11.6` · NuGet `0.19.6`) — **#234** ships the **`@lenient` opt-out on `field.uri` / `field.inet`** and pins **strict URI/inet well-formedness identical across all five ports**. A `field.uri` must be an absolute, scheme-bearing URI and a `field.inet` an IPv4/IPv6 literal — previously C#/Java/Kotlin accepted relative URIs, and the JVM ports resolved hostnames into `field.inet` via a **blocking DNS lookup on the request path with a silent value rewrite** (both now fixed, a bug/security fix). **`@lenient: true`** (a new optional boolean on `field.uri` / `field.inet`, registered cross-port + gated by `registry-conformance`) opts a field **out** of strict enforcement: codegen binds a plain string, and a `field.inet @lenient` uses a plain `text` column (so toggling it is schema-affecting). Strict remains the default (attr absent/false → byte-identical output). Also fixes a latent Zod-4 bug — `field.inet` emitted the removed `z.string().ip()`, now a version-agnostic IPv4/IPv6 regex union. Gated by the shared `validation-conformance` corpus + a real-Postgres lenient-inet idempotence round-trip; an adversarial pre-release review caught two cross-port parser divergences the probe set missed (H1 leading-zero IPv4, H2 IPv4-mapped IPv6). See `CHANGELOG.md` [0.20.6]. **The prior `0.20.5` line is a coordinated release across all four registries** (npm `0.20.5` · PyPI `0.19.7` · Maven `7.11.5` · NuGet `0.19.5`) — two cross-port fixes plus two npm-only `migrate-ts` fixes, all additive (PATCH). **#237** (metamodel, all five ports) registers **`@maxTokens` on `template.toolcall`** — the vendor-agnostic per-call token budget already core on `template.prompt` — as an ADR-0037 §2c configuration attribute (optional `int`), gated by `expected-registry.json` + the `template-toolcall-maxtokens` conformance fixture; **`@fallback` is deliberately NOT promoted** (ADR-0011 charters retry/fallback as consumer-provider, its value a vendor-specific object). **#236** (loader, all four ports; Kotlin inherits the JVM loader) **exempts an abstract node from the generic required-attr check**, so an abstract `template.prompt` may hoist shared children yet leave a required `@payloadRef` to its concrete subtypes (enforcement stays at the concrete level — a concrete node missing `@payloadRef`, inherited or own, still errors `ERR_MISSING_REQUIRED_ATTR`), gated by `abstract-template-prompt-hoists-payloadref`. The two **npm-only `migrate-ts`** fixes: **#235** keeps an empty-string column `@default: ""` on sqlite/d1 (only `undefined` now means no-default; a falsy `.length` guard had it perpetually drifting into a destructive recreate), and **#240** stops the OFFLINE `--allow adopt-view` path emitting an illegal `CREATE OR REPLACE VIEW` for a structurally-changed projection (the legal/illegal decision now keys on the **expected** view's columns only, so a known projection drop+creates offline too). Existing `meta gen` output is byte-identical. See `CHANGELOG.md` [0.20.5]. The prior npm `0.20.4` line was an npm-only bug-fix patch (NuGet / PyPI / Maven unchanged — schema migrations are TS-owned, ADR-0015, so no other port has a migrate engine to fix): `meta migrate --allow adopt-view` no longer emits an illegal `CREATE OR REPLACE VIEW` when adopting an UNMANAGED Postgres view (no fingerprint — created before view stamping, or hand-written) that was ALSO structurally changed (column rename / reorder / mid-insert) in the same migration — Postgres rejected that DDL at apply time (`cannot change name of view column …`), aborting the migration on any DB that already held the prior view (invisible until apply). The adopt branch now runs the same `viewReplaceIsLegal` decision the managed path makes: a legal append stays a non-destructive `replace-view`, a PROVABLY illegal structural change (known columns, non-prefix) becomes `drop-view` + `create-view` (re-stamped, so the next migrate converges), and an opaque `@sql` view (columns unknown) keeps its non-destructive replace. Adopting still requires `allow.adoptView` in both cases (the drop half carries the gate before the recreate-pair auto-allow, so it can't silently clobber hand-written SQL). Gated by unit + emit tests and a real-Postgres round-trip. See `CHANGELOG.md` [0.20.4] (#239). The prior `0.20.3` line is a coordinated additive patch (npm `0.20.3` · PyPI `0.19.6` · Maven `7.11.4` · NuGet `0.19.4`): npm ships the `meta docs` prompt-text + prompt data-flow site feature (TS-only), and all four ports ship #238 (ADR-0046) — an `object.value` may now carry a navigation-only `identity.reference` with explicit `@enforce: false` (a DTO/message/wire shape referencing an entity by id), the already-chartered logical-reference form. Zero new registry vocabulary — a child-licensing relaxation (ADR-0037 step 0), so `registry-conformance` is unaffected; the loader resolves the `@references` target (dangling → `ERR_INVALID_REFERENCE`) and codegen emits no FK/DDL, while a value's OWN identity (primary/secondary) and any enforced reference stay banned (`ERR_SUBTYPE_RULE_VIOLATION`). It also makes the M:N `@through`-junction-must-be-`object.entity` guard explicit (value purity used to imply it — a value can't be a join table). Existing `meta gen` output is byte-identical. Cross-port loader change (TS/Java/Python/C#; Kotlin inherits the JVM loader), gated by four new shared conformance fixtures. See `CHANGELOG.md` [0.20.3].** The prior `0.20.2` line is a bug-fix patch (NuGet / PyPI / Maven unchanged — D1 is a TS-only dialect; no changed product file elsewhere): `meta verify --dialect d1` no longer reports permanent, unfixable false schema drift for a hand-migrated D1/SQLite database whose schema genuinely matches its metadata. Four fixes to the shared migrate diff, all sqlite/d1-scoped (Postgres unchanged): `json` and cosmetic `VARCHAR(N)` length no longer read as type drift (SQLite has one text storage class); anonymous inline `CHECK (…)` constraints reconcile by normalized expression (with comments/literals masked so a `CHECK (` inside them can't produce a phantom check, and comma spacing normalized outside literals only); and a bare SQL `NULL` default — which the D1/wrangler runner stringifies to the string `"null"` — is correctly no-default rather than a literal on every no-default column (was permanent, destructive-recreate false drift). Surfaced by a public reference-impl consumer; an adversarial review caught two regressions in the fix (a literal-unaware comma-collapse; the relaxed CHECK finder) — both fixed + pinned. See `CHANGELOG.md` [0.20.2].** The prior `0.20.1` line fixes two first-touch TS quickstart blockers surfaced by a fresh-external-install pressure test (NuGet / PyPI / Maven unchanged — no changed product file): (1) the `meta migrate baseline` greenfield trap — an offline baseline recorded the metadata's desired schema as already-applied, so on an empty DB no `CREATE TABLE` was ever emitted and the server 500'd `no such table` while the CLI reported success; `baseline` now refuses when it proves the target `--db` is empty and every hint (`meta gen`, no-snapshot, `--help`) routes to the working `meta migrate --from-db --db <url> --dialect <d> --slug init --apply`; (2) un-extensioned generated relative imports failed `TS2835` under a stock `tsc --init` (nodenext) — the `codegen.extStyle` default flips `none`→`js` (`./Author.js`, resolves under both nodenext AND bundler) and `meta init` scaffolds `extStyle: "js"`, so generated code type-checks OOTB (gated by a nodenext compile gate). See `CHANGELOG.md` [0.20.1].** The prior `0.19.4` / `7.11.3` line extends the [ADR-0045](spec/decisions/ADR-0045-generated-api-surface-owns-write-semantics.md) `field.timestamp @autoSet` stamping guarantee from vanilla entities to the TPH (single-table discriminator) per-subtype API surface** ([#203](https://github.com/metaobjectsdev/metaobjects/issues/203)/[#229](https://github.com/metaobjectsdev/metaobjects/issues/229)) — a **Maven + PyPI** release (npm + NuGet product code unchanged; only their cross-port test lanes were touched, no re-release). The generated **Java, Kotlin and Python** TPH per-subtype controllers/routers now stamp `@autoSet` — each was a SEPARATE unstamped code path (Java's `emitTph` delegated raw to the consumer repository interface with no `stampForInsert`, Kotlin bound the columns straight from the DTO, Python omitted the stamp lines); **C# and TypeScript already stamped** on the TPH path (EF route stamping / Zod schema transforms) and were verified unchanged. On create both `@autoSet` columns stamp from one captured `now()` (equal); a PATCH bumps every `onUpdate` column and never rewrites `onCreate`; caller-supplied values are ignored; `@autoSet` is excluded from each port's per-subtype settable set. A subtype declaring its OWN `@autoSet` column (rather than inheriting from the shared base) is a documented compile-safe non-goal. Gated cross-port by a new `tph-autoset-patch` scenario on the shared `api-contract-conformance/tph` corpus (every port's generated TPH lane + the TS/C# reference lanes); byte-identical output for a TPH hierarchy with no `@autoSet` field. Also fixes the **vanilla (non-TPH) Java `<Entity>Patch` write-once `@autoSet` bug** — the settable set now excludes `@autoSet` so an HTTP PATCH can't overwrite a write-once `onCreate` timestamp (mirrors the Python fix in `0.19.3`). See `CHANGELOG.md` [0.19.4]. **The prior `0.19.3` line completes the ADR-0044 payload-record collision-naming rollout ([#219](https://github.com/metaobjectsdev/metaobjects/issues/219)) across the remaining ports** (no breaking changes, no new vocabulary): when two `object.value`s share a bare short name across packages (both reachable from one payload by FQN `@objectRef` — valid since ADR-0041/0042), the **Python** payload generator deduped by `fqn()` (bare when a loaded object's own package is unset) and collapsed both `Note`s into one class dropping the second shape, while **Java** and **Kotlin** (one-file-per-record) wrote both records to the same `NotePayload` path — second clobbers first, last-wins. All three now run ADR-0044's three-pass pipeline (FQN-keyed closure walk → collision-scoped naming, `AcmeAlphaNotePayload` on collision, `ERR_PAYLOAD_NAME_COLLISION` backstop → emit through the name map); non-colliding output is byte-identical, per-port gated (the Kotlin xpkg conformance test [#220] upgraded from "a file exists" to compile+assert two distinct classes). `ERR_PAYLOAD_NAME_COLLISION` is promoted to the shared error-code ledger + the central registries that gate it (TS `errors.ts` exact-bidirectional, Python `errors.py` superset, Java `ErrorCode.java`). Per-registry scope: **PyPI** carries the Python fix; **Maven** the Java + Kotlin fixes; **npm** the additive `errors.ts` ledger entry only (the TS payload fix shipped in `0.19.2`); **NuGet** is a version-parity bump (the C# fix + its local code shipped in `0.19.2`, C# unchanged here). See `CHANGELOG.md` [0.19.3]. **The prior `0.19.2` line was an npm + NuGet patch** (PyPI and Maven Central unchanged — neither port had a changed file; no breaking changes, no new vocabulary): generated `<Entity>Form`s validated **every** submit against `InsertSchema`, whose optionals reject `null`, so editing any row holding a NULL optional column was blocked outright — errors surfaced on fields the user never touched, `handleSubmit` never fired, and the save silently did nothing; the resolver now switches on `defaultValues` presence to `UpdateSchema`, which is also the semantically right pairing (an edit submits a PATCH) (#227); three CLI/codegen fixes surfaced by building the canonical advanced-modeling example — `verify --codegen`'s throwaway regen root not carrying the project's `templates/` dir forward (spurious drift failure for any template-output project), a relative `outDir` resolving against ambient `process.cwd()` instead of the resolved `--cwd` (both `gen`'s write path and `verify --codegen`'s read path), and a `render-helper.ts` `@payloadRef` missing `stripPackage()` before emission; and **#219 stage 1 / ADR-0044** — payload record emission is now FQN-keyed with collision-scoped naming in **TypeScript + C#** (two same-short-name `object.value`s across packages previously collapsed: TS deduped by bare name and silently dropped the second, C# stripped the package before resolution and picked whichever its bare-name scan hit first — the wrong shape). Not breaking: non-colliding output is byte-identical, pinned by no-churn tests. **Python, Java and Kotlin remain affected** by the same bug class through different mechanisms (Python class-shadowing, Java/Kotlin file clobber) — tracked as the remaining stages on #219. See `CHANGELOG.md` [0.19.2]. **The prior `0.19.1` line was a coordinated patch** (no breaking changes, no new vocabulary): an explicitly authored `validator.length @min` is now authoritative over the FR-036 Pin 1 implicit non-empty floor — every port previously clamped an authored `@min` with `max(@min, 1)` and silently discarded it, so `@min: 0` on a `@required` string was inexpressible; now `@min: 0` restores "must be provided, may be empty" and any explicit `@min` always wins (#224); the `@required` vocabulary (spec files, embedded definitions, registry manifest, `metaobjects-authoring` skill) now matches that shipped behavior (#224 §A5); and `meta verify --dialect d1 --d1 <binding> [--remote]` can target Cloudflare D1 through the existing wrangler transport, with `--db file:` into `.wrangler/state/**/d1/**` now warning it is verifying the local database rather than silently doing so (#225). See `CHANGELOG.md` [0.19.1] (and the separate PyPI [0.19.1] entry for the Python-only hotfix folded into this line's `0.19.2`). **The prior `0.19.0` / `7.11.0` line was a coordinated additive minor** (no breaking changes): **image support** — a metadata-driven `view.image` form control on `field.string` (storage is an opaque key; no image bytes cross the wire), whose generated `<Entity>Form` (`codegen-ts-react`) renders an upload/crop `<ImageUpload>` widget via a react-hook-form `<Controller>`, backed by a consumer-supplied `ImageUploadAdapter` (`upload`/`imageUrl`) over React context — plus a new **`metaobjects-ui-web`** TS-applied concern provider (`spec/metamodel/ui-web.json`) that now owns `view.image`'s five presentation attrs (`@aspectRatio`, `@maxEdge`, `@store`, `@accept`, `@maxBytes`) and the previously-deferred **`@rows`** on `view.textarea` (core `view.json` still registers zero view attrs, so the FR-033 invariant holds; non-TS ports mirror the spec file but never apply it — TS-web-only). New client surface: `@metaobjectsdev/runtime-web` (`canvasToJpegBlob`/`reencodeJpeg` + adapter types) and `@metaobjectsdev/react` (`<ImageUpload>`, `<ImageUploadAdapterProvider>`/`useImageUploadAdapter()`, `cropToBlob`, an optional `./form.css` export; `react-easy-crop` is an optional lazy-loaded peer). Also folds in a `0.18.0` test-only fixup (the `@formExclude` registration had left two full-suite tests red on `main`; regenerated, no re-release — published `0.18.0` product code was correct). See `CHANGELOG.md` [0.19.0]. **The prior `0.18.0` / `7.10.0` line was a coordinated additive minor** (no breaking changes): **view-kind form-control dispatch** in `codegen-ts-react` — the generated `<Entity>Form` now renders the right control per field view (enum→`<select>`, `view.textarea`→`<textarea>`, `view.checkbox`, `view.radio`; styled submit wrapper; aria-labels) instead of a bare `<input>` for every scalar — plus **`@formExclude` registered cross-port** on the `field.*` wildcard: the form template read it but core never registered it (strict `verify` rejected it as `ERR_UNKNOWN_ATTR`), now first-class in all five ports via the data-driven UI provider. Configurable `@rows` was deferred (no clean cross-port home for an attribute on a TS-only view subtype — `ui.json` `extends` throws where `view.textarea` is deregistered, core `view.json` breaks the FR-033 "core owns zero view attrs" invariant; textareas use a fixed `rows={4}`). See `CHANGELOG.md` [0.18.0]. **The prior npm `0.17.1` was an npm-only patch** on top of the 0.17.0 line (PyPI/NuGet/Maven unchanged): it fixes the write-through-entity generated REST routes to read through the replica view so read-your-writes returns the derived `origin.passthrough` field — the #214 read-half had shipped in the query layer + the view, but the routes layer was left mounting vanilla table CRUD (a `readView` on `runtime-ts` `mountCrudRoutes` + `codegen-ts` routes wiring), now gated by a cross-port `api-contract-conformance` write-through corpus (TS/C#/Kotlin). See `CHANGELOG.md` [0.17.1]. **The `0.17.0` / `7.9.0` line is a coordinated additive minor** bundling **#195** projection read-model origins (`origin.aggregate @agg: any|all|collect`, `origin.computed @expr`, `origin.first`), **#207** projection row-scope `@filter` (view outer `WHERE`), **#208** DDL-ownership escape valves (`source.rdb` `@sql` hand-written body + `@unmanaged` marker; ADR-0043), **#214** entity read-view codegen READ half (all five ports), and **Program D** value-object jsonb-column PATCH parity — plus a full documentation + agent-context skills refresh (the seven `meta init` skills accuracy-passed + Fable-reviewed; runtime-ui gained its Python + C# language refs). No breaking changes. See `CHANGELOG.md` [0.17.0]. **The prior `0.16.0` / `7.8.0` line was a coordinated BREAKING release (FR-036)** bundling the held **FR-035 present-key PATCH tristate** (absent≠null: absent→untouched / present-null→clears / present-null-on-`@required`→400) with **FR-036 cross-port constraint-validation enforcement + semantic pins**: `@required` string = NON-EMPTY (reject `null`/`""`, accept whitespace); `validator.regex @pattern` = FULL-MATCH; `@maxLength`×`validator.length @max` = strictest-wins; **C# and Python now ENFORCE field constraints over HTTP** (both were decorative at the wire tier); POST + PATCH validate present values on all five ports, **vanilla AND TPH per-subtype**. A missing `@required` value-type POST now 400s everywhere; a server-defaulted/`@autoSet`/auto-gen-PK `@required` field is correctly optional on POST. All conformance-gated (validation-conformance + api-contract, both lanes) — an xhigh review before release caught 11 cross-port divergences, all fixed + gated. See `CHANGELOG.md` [0.16.0]. **The prior `0.15.21` / `7.7.11` line was a bug-fix release** (npm `0.15.21` · PyPI `0.15.13` · Maven `7.7.11`; **NuGet unchanged at `0.15.10`** — the C# port needed no fix and was the reference the other three were corrected against). No metadata changes, no new vocabulary. It closes a family of migrate-engine defects that were destructive or silent: a **wrong-row write/delete** in every writable mount (a numeric-looking string id on a TEXT/uuid PK hit a *different* row); **every incremental `meta migrate` rebuilding every uuid-PK table**; `@autoSet` emitting `DEFAULT now()` on SQLite/D1 (**un-appliable migration**); `field.enum @values` changes **never migrating** on SQLite (stale CHECK → production insert failures); the SQLite emitter **dropping index `@expr`/`@where`/`@orders`** (a partial-UNIQUE silently becoming fully UNIQUE); an **auto-allowed `drop-view`**; `@kind: storedProc` projections **crashing `meta migrate`**; and quoted boolean defaults stored as TEXT so `= 0` matched nothing. It also fixes **hardcoded primary-key types in the Java, Kotlin and Python generators** — a `@generation: uuid` entity got broken output (Kotlin's **did not compile**) while its own DTO correctly used UUID. Every migrate fix is now gated by an `emit → apply to a real engine → introspect → re-diff must be EMPTY` round-trip plus value-semantics probes; the absence of that gate (nothing ever ran the pipeline twice against a real DB) is what let the class survive a suite of thousands of tests. The prior **`0.15.19` / `7.7.9` line was a coordinated release across all four registries** (additive, non-breaking): `origin.aggregate @filter` (a scoping filter — an `attr.filter` object — rendered as SQL `FILTER (WHERE …)` / SQLite `CASE WHEN`) is now registered in all five ports + registry-conformance (with an `origin-aggregate-filtered` fixture), closing the "projections can't express my scoped aggregate" gap; and the agent-context skills + docs make the projection/DB-view contract explicit — a projection's `CREATE VIEW` is generated from its `origin.*` children, so a hand-written view is drift (and, being unmanaged, invisible to `meta verify --db`), with the "custom SQL views" hand-write exception bounded to genuinely-irreducible views, a new audit view-necessity signature + a **VOCAB CANDIDATE** new-subtype-opportunity hunt, and a new `docs/features/downstream-metadata-decisions.md` adopter guide. **npm `0.15.18` was an npm-only, non-breaking patch on top of the coordinated `0.15.17` line** (PyPI/NuGet/Maven unchanged — TS-only fixes; advances the 1.0 quiet period): the `codegen-ts` `promptRender` **FQN `@objectRef` fix** (a prompt payload value-object nesting an `@objectRef` to another value-object emitted invalid `pkg::Name` TypeScript — now package-stripped to the bare name, matching `entityFile`) plus a batch of **agent-context skills fixes** (four of six `metaobjects-*` skills had invalid YAML front-matter so they never intent-triggered; wrong C# reference flags; the reference-fragment install reverted from deploy-all to stack-scoped; deprecated `codegen-ts/generators` imports + singular tanstack paths; ADR-0040 `index.lookup` vocabulary; and a stale Kotlin fixture that had left `agent-context-conformance` red on `main`). A cross-port hunt confirmed the `promptRender` FQN leak was **TS-only** (Java/C#/Kotlin/Python payload codegen already strip); PR #190 added the missing Python + Kotlin regression tests. The `0.15.17` line is a coordinated release across all four registries: (1) **BREAKING — `origin.passthrough` is type-preserving** (a passthrough field must match its `@from` source's `field.<subType>` + array-ness or fail load with `ERR_PASSTHROUGH_TYPE_MISMATCH`; opt out with `@convert: true`; retires the narrow `ERR_PARAMETER_REF_PASSTHROUGH_TYPE_MISMATCH`) (#185/#186); (2) **typed value-object jsonb columns end-to-end all ports** — single + `@isArray` array-of-VO round-trip through every port's write/read codec; Kotlin codegen moved off kotlinx `@Serializable` to a generated per-package Jackson `MetaJsonbMapper` (no serialization compiler plugin), C#/Java/Python array-of-VO codecs fixed (#187); (3) **load-order-independent super-resolution** — a dotted `extends: Owner.member` to an inherited member now resolves regardless of file load order (was a Node-vs-Bun `readdir` build-portability bug) via on-demand memoized resolution (#188/#189). The `0.15.6` line is a coordinated cross-port loader-ordering fix (all four registries bumped together): an overlay-only file could be merged *before* the base file declaring the entity it re-opens, so an `object.projection` overlay re-open (and any overlay reaching a not-yet-loaded `extends`/`origin` target) failed super-resolution with spurious `ERR_INVALID_ORIGIN` / `ERR_UNRESOLVED_SUPER` / `ERR_MISSING_REQUIRED_ATTR` — surfacing as a TS-vs-Python divergence but latent in every port. Each loader now stable-partitions overlay-only sources/roots to merge last, deterministically, cross-port conformance-gated (`projection-overlay-abstract-identity`) (#160). The prior `0.15.5` / PyPI `0.15.6` line shipped two consumer-provider CLI fixes (offline `meta migrate` now threads `metaobjects.config.ts` providers #157; a Python `metaobjects … --provider module:symbol` hook #158). The `0.15.4` line fixes cross-package same-name root nodes being wrongly merged by the TS/C#/Python loaders (#155). (The `0.15.1` / `7.7.1` line shipped the **`index.*` type + `identity.secondary` key-purity** [ADR-0040]: `identity.secondary` is now a *unique* alternate key with `@unique` **removed** — a legacy `@unique` fails load with `ERR_UNKNOWN_ATTR` — and a new **`index.lookup`** subtype carries *non-unique* retrieval [`@fields` required; `@using`/`@expr`/`@where`/`@orders` are RDB-physical escapes], cross-port conformance-gated; **breaking**, migration in `docs/features/migrations/identity-secondary-to-index-lookup.md`. This is on top of the `0.15.0` metamodel-1.0 vocabulary program + the ADR-0039 own-accessor fix.)

**All five ports ship loader + canonical serializer + conformance + codegen + render + payload-VO + `verify`:**

- **TypeScript** — `codegen-ts` (Vite-style plugins; Drizzle, Zod, Fastify) + `runtime-ts` + `migrate-ts` + the universal web client packages (`runtime-web`, `react`, `tanstack`).
- **C#** — `MetaObjects` (loader + canonical serializer + conformance) + `MetaObjects.Render` (Mustache + payload-VO + `verify`) + `MetaObjects.Codegen` (EF Core entities + `AppDbContext` + CRUD minimal-API routes). Schema migrations are TS-owned (ADR-0015): the C# migrate engine and the `migrate`/`--from-db` CLI surface were removed; the C# CLI is `gen`/`verify` only, packaged as a .NET tool invoked **`dotnet meta`** (not a bare `meta` — that name belongs to the Node schema CLI). EF Core runtime data-access stays per-port.
- **Java** — `metadata` + `omdb` + `om` + `dynamic` + `core-spring` + `metadata-ktx` (Kotlin facade) + `codegen-spring` (Spring controllers + DTOs + repositories + filter allowlists + payload records + output parsers) + `codegen-mustache` + `codegen-plantuml` + `render` + `maven-plugin` (`meta:gen`/`meta:editor` + a `meta:verify` **codegen-drift** goal — distinct from the removed live-DB `meta:verify`; Kotlin generators run through `meta:gen` via the shared SPI). FR-003 (OMDB runtime persistence + binding registry + typed jsonb + Spring-tx + source/origin metamodel) fully shipped, including Plan 4 (engine-debt remediation: atomic mapping cache, JDBC codec registry, `inTransaction` template). **Schema migrations are owned by the TypeScript toolchain** (`@metaobjectsdev/cli migrate`); the Java port's diff-and-converge migration engine and its `meta:migrate` / live-DB-drift `meta:verify` Maven goals were removed, and per ADR-0015 Decision 2 the dev/test runtime auto-create path (`MetaClassDBValidatorService` + the drivers' `createTable`/`createIndex`/`createForeignKey`/`createSequence` DDL) is **also** removed — **OMDB is pure data-access** (CRUD/query/codec/transactions only).
- **Python** — `metaobjects` (loader + canonical serializer + conformance + render + verify + codegen) + an `ObjectManager` runtime layer. The `migrate` module was removed (schema is TS-owned, ADR-0015); Python is pure data-access (codegen + ObjectManager runtime), with a **`metaobjects` console-script** (`gen`/`verify` codegen — no `migrate`). All five conformance corpora green.
- **Kotlin** — `codegen-kotlin` (KotlinPoet on JVM): entity + Exposed table + Spring controller + payload + relations + filter allowlist + validator + stored-proc + output-parser generators. `integration-tests-kotlin` runs the persistence-conformance corpus through Exposed against Testcontainers Postgres.

**Cross-port conformance corpora** (every port runs the shared corpus):
- Metamodel: `fixtures/conformance/` (255 fixtures; 19 shared corpora in total — per-corpus counts + the corpus x port matrix live in `docs/CONFORMANCE.md`). TS / C# / Java / Python all green.
- Render: `fixtures/render-conformance/`. TS / C# / Java / Kotlin / Python byte-identical.
- Persistence: `fixtures/persistence-conformance/`. **Query** scenarios run on every port (TS / C# / Java / Kotlin / Python), each provisioning its test DB by executing the committed, TS-produced `canonical/schema.postgres.sql` (Postgres only — Derby dropped for the cross-port query corpus, ADR-0015). The **migration** scenarios are exercised by **TS only** (TS owns schema migrations). **The corpus now gates WRITES, not just reads (SP-H):** an `op: roundtrip` scenario type INSERTs through each port's runtime/ORM write codec (NOT raw SQL), reads the row back, and asserts the wire-normalized value. The `AllTypes` entity (`roundtrip-all-types.yaml`) carries one field of **every** persistable `field.*` subtype — string/int/long/double/float/decimal/boolean/date/time/timestamp(+tz)/currency/enum/uuid/object — plus an **array-of-VO** `field.object @isArray @storage:jsonb` column (`labels`, written as 2-element / empty-`[]` / single-element arrays across the three rows) — so every subtype write+read (incl. the array-of-value-object jsonb codec) round-trips through every port against Testcontainers PG. (`field.byte`/`field.short`/`field.class` were cut as non-functional registration-only stubs — the matrix tracks only genuinely-supported subtypes; see `fixtures/registry-conformance/README.md` → "Per-subtype write-round-trip matrix".)
- API-contract: `fixtures/api-contract-conformance/`. TS / C# / Java / Kotlin / Python all green — each port runs **two lanes**: a hand-rolled reference server AND its **generated** API artifact booted over HTTP (the deployed controller/routes; TS+C# full-stack vs Testcontainers PG, Java/Kotlin/Python generated controller + in-memory repo behind the consumer seam). The generated fan-out found 10 real deployment bugs golden snapshots missed.
- YAML / verify corpora green across the ports that ship those layers.

**Key cross-language features shipped:** FR5 family (a/b/c/d/e + WARN envelope-shape — actionable loader errors per ADR-0009); FR-003 (Java RDB runtime persistence + projections; schema migrations are TS-only — the Java migration engine was removed); FR-006 (template.output parser-on-receipt codegen per ADR-0010 in all 5 ports); FR-008 + FR-009 (cross-port REST API contract + 10 filter operators); FR-018 (M:N relationship codegen in all 5 ports — entity navigation + idiomatic ORM wiring [Drizzle m2m / EF Core `UsingEntity` / Spring repo+JPA / Exposed / Pydantic+route as the SQLAlchemy-secondary equivalent] + REST traversal `GET /<source-plural>/{id}/<relation>` + Tier-2 docs, gated by the shared api-contract m2m corpus in both lanes + persistence-conformance; the TanStack M:N client hook is a deferred client-ergonomics follow-up); SP-H (field-subtype end-to-end hardening: every concrete `field.*` subtype write+read round-trips cross-port via the persistence `op: roundtrip` gate; cut `field.byte`/`field.short`/`field.class` non-functional stubs; cross-port filter-op reconciliation for uuid/currency); source v2 paradigm (ADR-0007); metadata-ktx Kotlin facade; per-target output directories (TS codegen).

**Current release line.** `0.20.x` (npm) · `0.19.x` (NuGet / PyPI) · `7.11.x` (Maven Central). The `0.15.0` / `7.7.0` release is a coordinated **minor with breaking changes**: (1) the **metamodel-1.0 vocabulary program** — `field.uri` / `field.inet` subtypes + a `@stringFormat` attribute (ADR-0036/0037), `field.timestamp` **instant-by-default** with an `@localTime` naive opt-out, `@dbColumnType` **slim-and-derive** (array-ness + `text` derived; `uuid_array`/`text_array`/`@kind:text` dropped), and reverse-navigation via generated explicit FK finders (ADR-0038); (2) the **ADR-0039 own-accessor correctness fix** — resolving/effective accessors are the default everywhere, so a concrete field/entity that `extends` an abstract parent now correctly inherits its properties and members in codegen + runtime (an entire latent bug class, cross-port conformance-gated). Breaking: instant-default timestamps and the `@dbColumnType` slim. See `CHANGELOG.md` for the per-version detail. GA promotion is the next release move.

See `spec/roadmap.md` for the active + planned work picture.

## Public repository hygiene

**This repository is PUBLIC.** Never commit references to other/private projects or to a developer's local environment. In any committed file — specs, plans, code, docs, fixtures — before every commit:

- **No other-project names.** Do not name private or sibling consumer projects. Use generic terms: "a downstream consumer", "the reference web consumer", "a C# adopter", "a sibling project".
- **No absolute local paths.** Never commit a developer's home path (e.g. `/home/<user>/…` or a `~/`-rooted path). Use repo-relative paths or placeholders (`<repo-root>`, `<consumer-repo>`) in command examples.
- **Scan the staged diff** for both of the above and genericize anything found before committing.

A local pre-commit hook enforces this (`.githooks/pre-commit`). The committed hook names **no** private project: it enforces generic structural patterns (absolute home paths) and loads a private-name denylist from a path you configure (kept in a private repo, never here). One-time per clone:

```
git config core.hooksPath .githooks
git config hooks.denyListPath /path/to/your/private/denylist.txt
```

It blocks commits whose added lines match (`git commit --no-verify` bypasses, discouraged); the npm author email is the one allowed exception. Guard a new private name by editing that private denylist (single source of truth) — never add real names to this public repo or the committed hook.

**Pre-push typecheck gate** (`.githooks/pre-push`, same `core.hooksPath`): `bun test`
transpiles per-file and does NOT typecheck, so type-broken code can ship green on the
test suite while the CI `typecheck` job goes red — and a direct admin push to `main`
bypasses branch protection. This hook closes that hole locally: when a push touches
`server/typescript/` or `client/web/`, it runs the same `bun run --filter '*' build &&
… typecheck` gate CI runs and **blocks the push when it is red** (~6s on a clean tree;
skipped entirely for non-TS pushes). Bypass in an emergency with `git push --no-verify`
or `SKIP_TS_TYPECHECK=1 git push`. The Java/C#/Python compile+conformance gates do NOT run on PRs (hosted CI runs
them on release tags + manual dispatch only, for cost). Instead, every push to
`main` triggers `local-ci.yml` on the maintainer's self-hosted runner: affected
ports only (via `scripts/ci-affected-ports.sh`), parallel per-port jobs, each
running `scripts/ci-local.sh --only <port> --strict-toolchains`; a nightly
dispatch runs the full matrix. PRs get the leak-scan only — run
`scripts/ci-local.sh --quick` locally before opening one.

## Monorepo layout

This repo holds all implementations of the standard, organized by deployment target → language/platform → framework integration:

```
metaobjects/
├── spec/                          # canonical metamodel docs (target-agnostic)
├── fixtures/conformance/          # cross-language test fixtures
│
├── server/                        # runs on a server
│   ├── typescript/   java/   python/   csharp/
│
└── client/                        # runs on an end-user device
    ├── web/                       # browser (TS-only — the browser is TS-native)
    └── ios/  android/             # future
```

**TypeScript plays two distinct roles**, and the layout reflects that:
- **Server-side TS** is a peer port to Java/Python/C# at `server/typescript/`.
- **Universal web client TS** at `client/web/` is consumed by ALL backends (a Java backend serving React still uses the TS client packages).

**Where does a new package go?**
1. Server-side or client-side? → top-level dir.
2. What language/platform? → second-level dir.
3. What framework integration? → package name at the third level.

Worked examples: a Drizzle TS-server integration → `server/typescript/packages/...`; an Angular browser integration → `client/web/packages/angular/`; future iOS SwiftUI → `client/ios/packages/swiftui/`.

## TS package layout

**Server-side** (`server/typescript/packages/`):
- `metadata/` (`@metaobjectsdev/metadata`) — metamodel loader, types, constants
- `codegen-ts/` (`@metaobjectsdev/codegen-ts`) — framework-neutral TS codegen engine (entityFile, queriesFile, routesFile, barrel)
- `codegen-ts-react/` (`@metaobjectsdev/codegen-ts-react`) — React codegen (formFile)
- `codegen-ts-tanstack/` (`@metaobjectsdev/codegen-ts-tanstack`) — TanStack codegen (tanstackQuery, tanstackGrid, tanstackGridHook)
- `runtime-ts/` (`@metaobjectsdev/runtime-ts`) — Node-side runtime (Kysely, Drizzle, Fastify helpers)
- `migrate-ts/` (`@metaobjectsdev/migrate-ts`) — migration tooling
- `sdk/` (`@metaobjectsdev/sdk`) — workspace memory, path helpers
- `cli/` (`@metaobjectsdev/cli`, binary `meta`) — CLI commands: `init`, `gen`, `migrate`

**Client-side / universal web** (`client/web/packages/`):
- `runtime-web/` (`@metaobjectsdev/runtime-web`) — pure framework-agnostic browser core (currency, filter-qs, EntityFetcher contract, GridConfig). Zero React, zero TanStack.
- `react/` (`@metaobjectsdev/react`) — React runtime: `useEntityForm`, `<CurrencyInput>`.
- `tanstack/` (`@metaobjectsdev/tanstack`) — TanStack runtime: `EntityFetcherProvider`, `<EntityGrid>`, default cell renderers.
- Future: `angular/`, `svelte/`, `react-native/`.

### Framework integration: separate codegen and runtime packages

Each framework integration ships as a **pair** of packages — one for codegen (server-side, runs at `meta gen` time) and one for runtime (browser-side, runs in the user's app). Mirrors Prisma (`prisma` + `@prisma/client`), Apollo (`@apollo/codegen-cli` + `@apollo/client`), and Drizzle (`drizzle-kit` + `drizzle-orm`).

| Integration | Codegen | Runtime |
|---|---|---|
| React | `@metaobjectsdev/codegen-ts-react` | `@metaobjectsdev/react` |
| TanStack (depends on React) | `@metaobjectsdev/codegen-ts-tanstack` | `@metaobjectsdev/tanstack` |

Each codegen package emits imports that target its matching runtime package. Codegen packages live under `server/typescript/packages/` because they execute server-side, even though their output targets the browser. Runtime packages live under `client/web/packages/` and have zero Node-only deps.

Two disjoint dependency trees:

```
Runtime side (browser):              Codegen side (server):

  @metaobjectsdev/runtime-web ←┐         @metaobjectsdev/codegen-ts ←┐
        ↑                    \              ↑                   \
        └── @metaobjectsdev/react ┐             ├── @metaobjectsdev/codegen-ts-react
                ↑               \            └── @metaobjectsdev/codegen-ts-tanstack
                └── @metaobjectsdev/tanstack
```

Future framework integrations (Angular, Svelte, React Native) follow the same two-package pattern.

A user's `metaobjects.config.ts`:

```ts
import { defineConfig } from "@metaobjectsdev/cli";
// Owned generators scaffolded by `meta init` (ADR-0034 scaffold-and-own).
import { entityFile } from "./codegen/generators/entity";
import { queriesFile } from "./codegen/generators/queries";
import { routesFile } from "./codegen/generators/routes";
import { barrel } from "./codegen/generators/barrel";
import { formFile } from "@metaobjectsdev/codegen-ts-react";
import { tanstackQuery, tanstackGrid } from "@metaobjectsdev/codegen-ts-tanstack";

export default defineConfig({
  generators: [entityFile(), queriesFile(), routesFile(), formFile(), tanstackQuery(), tanstackGrid(), barrel()],
});
```

A consumer's React component:

```ts
import { formatCurrency } from "@metaobjectsdev/runtime-web";
import { CurrencyInput, useEntityForm } from "@metaobjectsdev/react";
import { EntityFetcherProvider, EntityGrid } from "@metaobjectsdev/tanstack";
```

## Other conventions

- **TS runtime**: Bun-first for development (zero-config TS, native test runner). Node-compatible for distribution; users install via npm/pnpm/bun without lock-in to Bun's runtime.
- **Module system**: ESM only. No CommonJS, no transpile step required.
- **Storage format**: JSON files in `metaobjects/meta.<concept>.json` at project root. `.metaobjects/.gen-state/` (gitignored) holds the codegen merge base.
- **Codegen substrate**: ts-poet for greenfield emit, ts-morph for in-place edits, Biome for format pass, `git merge-file --diff3` for hand-edit-preserving regen.
- **Runtime substrate**: Kysely for TS (user-provided connection, async-only).
- **Migration substrate**: Postgres + SQLite for TS v0.3.

## Explicitly out of scope

- A custom DSL. Plain typed metadata only — Wasp's seven-year DSL-tax is the cautionary tale.
- A spec-driven workflow like Kiro / Spec Kit. Humans don't author rich specs; Claude proposes metadata, humans review.
- A proprietary runtime. All generated code runs without MetaObjects installed; runtime libraries are normal language-native packages.
- A prompt-to-app builder (not Lovable, Bolt, or v0). MetaObjects generates entity-shaped boilerplate; users hand-write the interesting business logic.
- Replacing CLAUDE.md, cursor rules, or other prompt-engineering surfaces — MetaObjects complements them.
- An LLM provider. The MCP integration is model-agnostic.
- An AI agent platform. (Codegen Inc. died Jan 2026 trying that.)

## Working with Claude on this project

- For new features or non-trivial changes, prefer the **brainstorming → plan → implementation** flow. Don't jump to implementation without a plan.
- Entity records are **prescriptive** (drive codegen + runtime). The other record types (decision, principle, convention, glossary, failure) are **descriptive** (supporting context for reasoning).
- Confidence and provenance are first-class on memory records. Bias toward under-flagging on drift checks (false-positive rate >15% is a kill criterion).
- Templates are user-owned plain TS. Anything inside a generated file is fair game to hand-edit; three-way merge preserves it.
- TDD discipline throughout implementation.
- **Cross-language conformance fixtures** live at `fixtures/conformance/`. Adding new metamodel behavior means adding a conformance fixture so every language port (TS, Java, Python, C#) automatically verifies it. See `spec/conformance-tests.md` for the fixture format and canonical serializer contract.

## File organization

**Default convention**: one file per domain concept under `metaobjects/`. Multiple objects per file when they share a domain. Projections (`source.dbView`) live inline with their base entity.

```
project-root/
├── metaobjects/                       # VISIBLE — entity declarations
│   ├── meta.common.json               # shared abstracts (BaseEntity)
│   ├── meta.commerce.json             # Program, Purchase, ProgramSummary
│   ├── meta.users.json                # Subscriber
│   └── meta.content.json             # Video, Week, Workout, Exercise
├── .metaobjects/                      # HIDDEN — tool state
│   ├── config.json                    # static project state
│   └── .gen-state/                    # codegen merge base (gitignored)
└── metaobjects.config.ts              # runtime config
```

File-naming: `meta.<concept>.json`. Each file declares its `package`:

```jsonc
{ "metadata.root": {
    "package": "myapp::commerce",
    "children": [
      { "object.entity": { "name": "Program", ... }},
      { "object.entity": { "name": "Purchase", ... }}
    ]
}}
```

**Optional layered overlay pattern** (for larger projects with team-level concern boundaries):

```
metaobjects/
├── meta.user.json                     # STRUCTURAL (always present)
├── meta.user.ui.json                  # UI overlay (views, layouts)
└── meta.user.db.json                  # DB overlay (sources, dbColumns)
```

All three share the same `package` and object `name`. The Loader merges them. Use only when team-level concerns justify the file proliferation. Default to single-file-per-domain.

**`BaseEntity` pattern**: shared abstract bases live in `meta.common.json`. Concrete entities use `extends: "BaseEntity"` to inherit `id` + `createdAt` without redeclaring.

## URL prefix policy

`apiPrefix` in `metaobjects.config.ts` flows through codegen to both route registration and hook fetch URLs.

```ts
export default defineConfig({
  apiPrefix: "/api",        // generated routes mount under /api; hooks fetch /api/<entity>
});
```

## Codegen architecture (Vite-style plugins)

`@metaobjectsdev/codegen-ts` follows a Vite-style plugin model.

**Core interface** — every emitter implements `Generator`:

```ts
import type { Generator, GenContext, EmittedFile } from "@metaobjectsdev/codegen-ts";

interface Generator {
  name: string;                          // kebab-case; surfaces in diagnostics
  filter?: (entity: MetaData) => boolean;
  generate(ctx: GenContext): EmittedFile[] | Promise<EmittedFile[]>;
}
```

Helpers `perEntity()` and `oncePerRun()` cover the common "file per entity" / "one-shot" cases.

**Built-in factories**: `entityFile`, `queriesFile`, `routesFile`, `formFile`, `barrel`. Per ADR-0034 (scaffold-and-own), `meta init` copies the `entityFile`/`queriesFile`/`routesFile`/`barrel` reference templates into the consumer repo at `codegen/generators/*.ts` and the scaffolded config imports those owned local copies; importing them from `@metaobjectsdev/codegen-ts/generators` still works but is **deprecated** (removal in a future major).

**User wiring** (`metaobjects.config.ts`):

```ts
import { defineConfig } from "@metaobjectsdev/cli";
// Owned generators scaffolded by `meta init` (ADR-0034 scaffold-and-own).
import { entityFile } from "./codegen/generators/entity";
import { queriesFile } from "./codegen/generators/queries";
import { routesFile } from "./codegen/generators/routes";
import { barrel } from "./codegen/generators/barrel";

export default defineConfig({
  outDir: "packages/database/src/generated",
  dialect: "sqlite",
  apiPrefix: "/api",
  generators: [entityFile(), queriesFile(), routesFile(), barrel()],
});
```

**Per-target output directories.** Each generator can write to its own
directory/package via a named `targets` registry + per-generator `target`, so
generated code lands with its runtime concern (model → database package, routes →
API app, hooks/forms/grids → web app). A target is `{ outDir, importBase?,
outputLayout?, dbImport? }`; the top-level `outDir` is the implicit `default`
(entity-module) target. Cross-target references to the entity module are emitted as
extension-less `importBase` package paths (`@acme/database/generated/acme/commerce/Program`)
while same-target references stay relative; the entity-module target must set
`importBase` when any generator routes elsewhere. With no `targets`, output is
byte-identical to a single-`outDir` project. Full config reference: `@metaobjectsdev/cli`
README, "Multiple output targets".

**Two config files, by design:**
- `metaobjects.config.ts` (TypeScript) — generator wiring, type-checked.
- `.metaobjects/config.json` (JSON) — static project state. Parseable by non-TS tooling (CI scripts, etc.).

The runner `runGen()` (1) loads metadata, (2) resolves targets + derives the
entity-module target, (3) precomputes shared render state once, (4) runs each
generator with a per-target `RenderContext`, (5) errors on duplicate full output
paths, unknown target, missing `importBase` for cross-target imports, or any
generator throw, (6) writes each file under its target's `outDir` (overwriting only
files carrying the `@generated` header; refusing others).

### Filter syntax + sort (Project D)

Generated CRUD endpoints support a typed, metadata-driven filter + sort layer:

**URL grammar** (bracketed qs): `?filter[field][op]=value&sort=field:asc|desc&limit=N&offset=N`. Bare value is sugar for `eq`.

**Eight operators**, gated by field subtype:
- `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`, `like`, `isNull`
- Strings get `eq/ne/in/like/isNull`; numbers + dates get `eq/ne/gt/gte/lt/lte/in/isNull`; booleans get `eq/isNull`.

**Authoring:** mark fields with `@filterable: true`. `@sortable` inherits from `@filterable` by default.

**Generated artifacts per entity**:
- `<Entity>FilterAllowlist` — server-side allowlist
- `<Entity>SortAllowlist` — server-side sort allowlist
- `<Entity>Filter` — client TS filter type

**Client usage:**
```tsx
import { useSubscribers } from "./generated/Subscriber.hooks";

const { data } = useSubscribers({
  email: { like: "%@example.com" },
  subscribed: true,
  sort: "createdAt:desc",
  limit: 25,
});
```

**Server validation:** every request validated against the allowlist. Unknown field / disallowed op / invalid value → 400 with structured error code.

**Architecture:** `parseFilterParams` (in `@metaobjectsdev/runtime-ts/drizzle-fastify`) translates parsed qs into a Drizzle expression tree. `buildFilterQs` (in `@metaobjectsdev/runtime-web` and `@metaobjectsdev/tanstack`) serializes a typed filter object back to a bracketed qs URL.

### Source-aware entities + projections (Project E)

`source` is a top-level metadata type describing where an object's data lives. Subtypes: `dbTable` (writable, default) and `dbView` (read-only).

**Authoring a projection:**

```jsonc
{ "object.entity": {
    "name": "ProgramSummary",
    "extends": "Program",
    "children": [
      { "source.dbView": { "@name": "v_program_summary" }},
      { "field.int": { "name": "weekCount", "children": [
        { "origin.aggregate": {
            "@agg": "count", "@of": "Week.id", "@via": "Program.weeks" }}
      ]}},
      { "identity.primary": { "@fields": ["id"] }}
    ]
}}
```

**`origin`** subtypes: `passthrough` (cross-entity field reference) and `aggregate` (count/sum/avg/min/max). Origins drive view DDL.

**Source-aware codegen dispatch:**
- Projection (dbView only) → read-only Zod, read-only routes, read-only hooks.
- Write-through (dbTable + dbView) → mutations target table, queries target view.
- Vanilla entity → standard behavior.

**`columnNamingStrategy`** in `metaobjects.config.ts`: `snake_case` (default) | `literal` | `kebab-case`.

### Currency (Project F)

`field.currency` declares "this column stores money as integer minor units."

```jsonc
{ "field.currency": {
    "name": "priceCents",
    "@currency": "USD",
    "children": [
      { "view.currency": { "@locale": "en-US" }}
    ]
}}
```

**Storage:** integer minor units (cents for USD, yen for JPY). Wire format is unchanged from `long`. Server never formats currency; all formatting is client-side via `Intl.NumberFormat`.

**Runtime imports** (browser-safe sub-paths):

```tsx
import { formatCurrency, parseCurrency } from "@metaobjectsdev/runtime-web";
import { CurrencyInput } from "@metaobjectsdev/react";
```

**Cross-language ports** must preserve the wire contract: integer minor-unit storage, `@currency` (ISO 4217), `@locale` (BCP 47) attrs.

### TanStack codegen + metadata-driven grids (Project B)

`@metaobjectsdev/codegen-ts-tanstack` ships two generators:

- `tanstackQuery()` — emits `<Entity>.hooks.ts` per entity (5 hooks: `useEntity`, `useEntities`, `useCreate/Update/Delete<Entity>`).
- `tanstackGrid()` — emits `<Entity>.columns.tsx` per entity with a `layout.dataGrid` child.

**Grid metadata:**

```jsonc
{ "layout.dataGrid": {
    "name": "default",
    "@columns": ["email", "firstName", "subscribed", "createdAt"],
    "@defaultSortField": "createdAt",
    "@defaultSortOrder": "desc",
    "@pageSize": 25
}}
```

**Runtime surface (`@metaobjectsdev/runtime-web` and `@metaobjectsdev/tanstack`)**:
- `<EntityFetcherProvider value={fetcher}>` — supplies the fetcher function.
- `<CellRendererProvider value={{...}}>` — renderer overrides keyed by view subtype.
- `<EntityGrid columns={...} grid={...} data={...} />` — opinionated TanStack Table component.

**Per-entity opt-out**: `@emitTanstack: false` on an entity skips both hook and column files.

## Cross-language porting

Preserve the following contracts exactly across all language ports:

**Metamodel subtype vocabularies (must be identical across languages):** the `registry-conformance` gate (`fixtures/registry-conformance/`) is the structural enforcer of this rule — each port emits its registry as a canonical manifest byte-matched to `expected-registry.json`. **All five ports (TS / C# / Java / Kotlin / Python) are live + green** (SP-G Java/Kotlin reconciliation complete; the JVM runners compose from the defined metamodel provider set so codegen-base/om classpath SPI does not pollute the measured vocabulary). See `fixtures/registry-conformance/README.md`.
- Filter operators: `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`, `like`, `isNull`
- Object subtypes: `entity` (owns data: own identity, writable sources, lifecycle), `value` (pure shape: NO identity, NO source, ever; constructed — by caller/assembly/embedding — never populated; may `extends` entity fields for shape), `projection` (derived read-only representation: fields `extends`-bound / origin-derived / self-declared-under-external-assembly, all read-only at subtype level; identity optional and MUST extend an entity identity; sources restricted to read-only `@kind`s; the declared field set IS the exposure — inclusive list, fail-closed). A field carrying `origin.*` is derived ⇒ read-only wherever it lives (incl. on entities). An entity's primary source must be a writable `@kind` (read-only kinds only in read role). See [ADR-0028](spec/decisions/ADR-0028-object-taxonomy-projection-value-purity.md). (FR-024 Phase E — `object.projection`/`value` are registered in `expected-registry.json` and the projection/value validation passes [identity pass-through, value-purity, projection-licensing, `@via` inference/cardinality, extends/origin agreement, derived-field providability] are enforced cross-port in all 5 ports. The **B4b** entity-primary-source-readonly cutover [the "writable `@kind`" clause above — `ERR_ENTITY_PRIMARY_SOURCE_READONLY`] + the projection codegen fan-out (read-only DTOs for view-kind projections; FR-015 proc-callables for proc-kind projections; api-docs label `object.projection` units as `projection` and document their generated `<Name>Dto`) are now shipped cross-port; the remaining FR-024 work is the declared-API surface — tracked in #10.)
- Source subtypes: `rdb` (paradigm; ADR-0007). The pre-v2 `dbTable`/`dbView` subtypes are RETIRED — `source.rdb` + `@kind: table|view|materializedView|storedProc|tableFunction` is the form, with read-only-ness derived from `@kind`. Multi-source via `@role` (exactly one `primary` per object). Source physical name = `@table` (NOT `@name`); field physical name = `@column` (renamed from `@dbColumn`). Referential actions on relationships: `@onDelete` / `@onUpdate`.
- Origin subtypes: `passthrough`, `aggregate`
- Relationship subtypes: `association`, `aggregation`, `composition`. Cardinality via `@cardinality: one|many`; target via `@objectRef`. **M:N (FR-018) slim vocabulary:** `@cardinality: "many"` + `@objectRef` (target) + `@through` (the junction/through entity — a third entity that MUST declare two `identity.reference` children, one per FK side). The relationship's FK fields are **derived** from those references (the `identity.reference` SSOT for FK direction), never restated. `@sourceRefField` (optional) disambiguates a *directed* self-join by naming the source-side FK field on the junction (the other reference is the target side). `@symmetric` (optional boolean) marks an *undirected* self-join (union-on-read) — valid only when `@objectRef` == the declaring entity, and mutually exclusive with `@sourceRefField`. The pre-FR-018 `@joinEntity`/`@joinFields` attrs are REMOVED. Validation errors: symmetric-on-hetero / symmetric+sourceRefField → `ERR_BAD_ATTR_VALUE`; junction-missing-two-references / sourceRefField-not-matching / M:N-attr-on-1:N → `ERR_INVALID_RELATIONSHIP`.
- Index subtypes: `index.lookup` (non-unique retrieval index; uniqueness is encoded in the **type**: `identity.secondary` = unique alternate key, `index.lookup` = non-unique; `@unique` is REMOVED from `identity.secondary` — `ERR_UNKNOWN_ATTR` on any legacy `@unique`). RDB-physical escapes `@using`/`@expr`/`@where`/`@orders` are registered by the db provider on **both** `identity.secondary` and `index.lookup`. `index.fulltext` / `index.vector` / `index.spatial` are reserved on the subtype axis — documented, NOT registered (YAGNI + 1.0 vocab freeze). See [ADR-0040](spec/decisions/ADR-0040-index-type-and-secondary-key-purity.md).
- Layout subtypes: `dataGrid`
- API subtypes: `api.base` / `api.operational` (request/response surface; subtype axis = interaction model, NEVER protocol — protocol lives in `binding.*` per operation: `rest` now, `messaging`/`grpc` reserved). Children: `operation.query` (outputRef → `object.projection`) / `operation.command` (inputRef → `object.value`, may also outputRef). Derived CRUD (FR-008/009) stays the zero-config default; declared `api` extends it. Org-tier modeling (application/service/network/deployment) stays OUT of core — provider SPI, FQN references. See [ADR-0030](spec/decisions/ADR-0030-declared-api-surface-and-org-tier-boundary.md). (FR-024 declared-API — planned; not yet in `expected-registry.json`; the remaining third of FR-024 after the projection/value taxonomy + validation parity.)
- Currency attrs: `@currency` (ISO 4217), `@locale` (BCP 47)
- Schema attrs: `@schema` on `source.rdb` (DB schema name; Postgres default `public`, SQLite rejects non-default values)
- Storage attrs: `@storage` on `field.object` (with `@objectRef`) — values `flattened` / `jsonb` / `subdocument`. Unifies "owned types" (flattened storage) and "structured JSONB" (jsonb storage). Defaults to single-jsonb-column when absent (back-compat).
- Enum: `field.enum` is a first-class field subtype (peer of `currency`), string-backed. Required `@values` string-array attr (member symbols). Members must be a non-empty set, each matching `^[A-Za-z_][A-Za-z0-9_]*$`, no duplicates — every port's loader enforces this (own-only) emitting `ERR_BAD_ATTR_VALUE` (missing `@values` → `ERR_MISSING_REQUIRED_ATTR`). Reuse via abstract `field.enum` + `extends`. Codegen: TS union + `z.enum`, C# `enum` + EF `HasConversion<string>()`, DB `varchar` + `CHECK`. Int-backed values, display labels, and native PG enum are deferred (see `docs/superpowers/specs/2026-05-23-enum-datatype-design.md`).
- Documentation common attrs (any node): `description`, `title`, `notes`, `deprecated`, `replacedBy`, `seeAlso`, `aliases`. Registered via the cross-language `commonAttrs` registry hook (`registerCommonAttrs` / `RegisterCommonAttrs` / `register_common_attrs` / Java `MetaDataRegistry.registerCommonAttribute` — wired in all four ports). `notes` is the internal-only rationale slot — never emitted to user-facing doc-gen (JSDoc / XML-doc / Postgres `COMMENT ON` / Mermaid prose). TS doc-gen ships all three tiers; C# ships XML-doc + COMMENT ON. See `docs/superpowers/specs/2026-05-24-documentation-provider-design.md`.

**Wire format:**
- Currency: integer minor units on the wire always. Float arithmetic for money is forbidden.
- Pagination: `?limit=N&offset=N` — identical across all generated endpoints.
- **Runtime return types**: a port's runtime `ObjectManager` returns **native in-process language types** (`field.decimal`→`BigDecimal`/`decimal`/`Decimal`, TS `string`; temporal→native; jsonb→native map). Wire canonicalization (the bullets above + `normalization.md`) is applied at the **serialization boundary**, never inside the runtime query path. See [ADR-0019](spec/decisions/ADR-0019-runtime-return-type-contract.md).

**Grammar:**
- Dotted-path syntax for `@via`: `"Program.weeks"` or `"Program.weeks.workouts"`.
- Dotted-path syntax for `@of`: `"Week.id"`.
- `extends` may target a nested child to ANY depth: `Customer.id`, cross-package `acme::sales::Customer.id`, triple-nest `Customer.priceCents.display` (object → field → view). Addressing model: a package qualifies the ROOT-level node only; each subsequent dotted segment traverses CHILD NAMES (nested children carry BARE names — packages never fold onto non-root nodes). Intermediate segments resolve by unique name (cross-type collision = unresolved); the FINAL segment is type-scoped to the referrer (a field resolves fields; an identity identities; a view views). `extends` is THE inheritance mechanism; `origin.*` never inherits. `@via` lives on `origin.*` only and may be omitted ONLY when exactly one single-hop relationship leads from the base entity to the `from`/`of` entity (multi-hop always explicit). See [ADR-0029](spec/decisions/ADR-0029-entity-child-extends-and-via-inference.md).
- Package segments: `::` separator — `acme::common::id`.
- **Canonical JSON:** reserved structural keywords are bare (`name`/`package`/`extends`/`abstract`/`overlay`/`isArray`/`children`/`value`); inline attributes are `@`-prefixed. `@`-prefixing a reserved word (e.g. `@isArray`) is invalid (`ERR_RESERVED_ATTR`). **YAML authoring is sigil-free** — bare attrs; the desugar re-adds `@` when lowering to canonical JSON; canonical JSON is the on-disk interchange (YAML is the universal authoring front-end across ports). See [ADR-0006](spec/decisions/ADR-0006-ai-first-yaml-authoring.md).

**Loader pipeline:**
- `extends:` resolution happens after all files are loaded (deferred, not eager).
- Overlay/merge: same `package` + same object `name` across multiple files → merged. Last-writer-wins on attr conflicts; structural children accumulate.
- Default scan path: `metaobjects/**/*.json` (recursive).

**D1 is TS-only.** Cloudflare D1 is a peer of `sqlite`/`postgres` in TS's `dialect` vocabulary. It is SQLite at the SQL level — Java/Python/C# don't have an analogue (Cloudflare Workers run JS). When adding cross-language vocabulary, D1 doesn't constrain anything: its uniqueness is wrangler-CLI transport + Wrangler-native file layout (`migrations/<seq>_<slug>.sql`), both of which are TS-only concerns.

**Constants discipline:**
- TS: named constants in `packages/metadata/src/constants.ts`. Never inline metamodel strings as literals in code.
- New type or subtype names: add to TS constants first; add the parallel in other language implementations.

## Design judgment (durable principles)

These are the load-bearing principles that have emerged through implementation. Apply them every time.

- **Expanding the metamodel vocabulary follows ONE decision procedure (ADR-0037) — driven by semantic behavior, not surface storage.** Don't ask "is X a string/number/date?"; ask "what does X *do*?" Ordered test: (0) **derivable** from existing subtype + attrs (`isArray`/`@maxLength`) + structure? → derive in codegen, add nothing; (1) **physical-only** (native type/meaning unchanged)? → the `@dbColumnType` escape hatch, not first-class vocab; (2) logical — **does X have its own native type, behavior, or attributes** (a *thing* that owns custom logic)? → **subtype** (the extension point: `field.uuid`, `field.uri`, `field.inet`); a **structural variant *within* a subtype** (changes generated shape, shares native type)? → **`@kind`** (the one chartered structural-variant axis: source table/view, uri url/urn — never a catch-all, never on a plain string); otherwise X just **modifies/validates/configures** an existing type → **attribute** (boolean flag `@localTime`; validation `@stringFormat` email/hostname; config `@maxLength`). The "string formats" set splits by behavior: url/uri→`field.uri`, ip→`field.inet` (native types + behavior), only email/hostname→`@stringFormat` (plain validated strings); uuid is already `field.uuid`. Self-documentation over economy; no same-name overloads (hence `@stringFormat`, not a third `@format`). Consult it every time. See [ADR-0037](spec/decisions/ADR-0037-metamodel-vocabulary-expansion-decision-framework.md).

- **Pattern-derivable from metadata = codegen, never hand-code.** This is the metaobjects raison d'être. If you find yourself proposing that users hand-write something the metadata fully describes (FK references, basic CRUD, validator chains, type-safe finders, relations() blocks), stop. Codegen it. The only exception is what metadata genuinely cannot express (custom SQL views, regex patterns from outside metadata, business logic). When in doubt, generate.

- **Study reference implementations for subtle pipeline behavior; don't re-derive from spec.** For complex orchestration (loader, parser, super resolution, overlay/override merging, registry lifecycle), the spec describes WHAT but the implementation captures HOW — including edge cases and error handling. When porting, read existing implementations first. First-principles reasoning produces subtly wrong behavior that breaks cross-language interop.

- **"Validated by spike" ≠ "right design".** A spike proves a technique works under a specific test. It doesn't prove it is the best production choice. Always ask "what's the UX cost?" alongside "does this work?"

- **NEVER call `own*()` accessors by default — resolving/effective is the default; `own` breaks `extends` (ADR-0039).** `extends` is a super-*reference*, not a flatten: inherited attrs/children live on the parent, reachable only via the *resolving* accessors (`attr()`/`children()`/`getMetaAttr(name)` / Python `attrs().get()`). Reading a field/node's effective property (`isArray`, `subType`, `@maxLength`, `@precision`, `@default`, `@column`, `@objectRef`, `@storage`, …) or iterating its member set through an **own-only** accessor (`ownAttr`/`ownChildren`/`ownFields`/`field.isArray` native flag / Java `,false`) silently drops everything inherited via `extends` — corrupting codegen and runtime. The **one** legitimate `own*()` use: **codegen emitting a generated subclass, iterating `ownFields()` so inherited members aren't re-emitted** (the generated base already has them). The metamodel-internal siblings (own-mode canonical serializer, overlay-merge, super-resolution walks) use the same "emit only the declared-here layer" principle. The one attr deliberately own-only is `@dbColumnType` (physical, never inherited). Every `own*()` call must carry a comment naming its sanctioned case; any other own read is a bug. Watch the naming inversion: Python `attr()` is OWN, TS `attr()` resolves. See [ADR-0039](spec/decisions/ADR-0039-own-accessor-discipline.md).

- **Bind metadata→native types at build time, never runtime reflection.** Resolving an object's native class/module from its FQN must happen in generated code (static imports for data-oriented ports; a domain-sliced, FQN-keyed registry for OO ports), not via `Class.forName`/`Type.GetType`/`importlib` — runtime reflection is impossible in TS and breaks under GraalVM native-image / .NET AOT. See [ADR-0001](spec/decisions/ADR-0001-cross-language-type-binding.md).

- **Record significant cross-cutting decisions as ADRs.** Durable, cross-language/cross-feature architectural contracts live in `spec/decisions/` (Nygard format). Consult them before changing a cross-language contract; add a new ADR when you make one. Feature-level decisions stay in the FR spec; this file holds only the one-line rule + the pointer.

- **Strict metadata provenance — never invent a metamodel attribute (ADR-0023).** Every type/subtype/attribute the loader accepts in THIS repo must come from a registered metamodel provider; the library boots strict + seals the registry after the defined-provider bootstrap, so any undeclared attr is `ERR_UNKNOWN_ATTR` and any post-bootstrap registration is `ERR_REGISTRY_SEALED` (codegen "making up" an attr is a hard build failure). Before adding ANY new metamodel attribute: (1) prove it **cannot be computed** from existing metadata — if a generator can derive it (FK refs, column types, validator chains, naming), derive it, don't add an attr; (2) get **explicit human agreement** and write the can't-be-computed justification into the FR spec / ADR; (3) add it to a registered provider AND a `registry-conformance` fixture so all five ports gate it. Downstream apps may add their own providers or loosen strictness — but the library's tests never permit an unregistered attr. See [ADR-0023](spec/decisions/ADR-0023-strict-metadata-provenance.md). The legitimate escape hatch for arbitrary author-supplied properties is the registered `attr.properties` bag (exempt from the strict-attr check), not a new first-class attr.

## Coding discipline (TS)

- **Named constants for metamodel strings — always.** Type names, subtype names, reserved JSON keys, special attribute names, structural separators, and wildcards live in `packages/metadata/src/constants.ts` — import and use them. Gets you compile-time typo safety.
- **Use `as const` arrays + type unions** for closed sets (e.g., `FIELD_SUBTYPES = [...] as const; type FieldSubType = (typeof FIELD_SUBTYPES)[number]`).
- **String literals OK only for**: error message text, instance/entity names that are user data, and test data values that aren't metamodel-level concepts.
- **No backwards-compat hacks.**
- **No `any` escape hatches.** Use `unknown` and narrow.

## Useful commands

```
meta init                             # scaffold metaobjects/, .metaobjects/, codegen/generators/, metaobjects.config.ts, .gitignore
meta gen [<entity>...]                # codegen: render templates → format → three-way merge → write
meta gen --dry-run                    # preview without writing
meta migrate                          # diff metadata vs DB schema; emit migration SQL
meta migrate --dry-run                # preview without writing migration file
```

The above is the **Node `meta`** (schema + TS codegen). Each non-TS port runs
codegen through its own build tool — `dotnet meta gen`/`verify` (C#),
`mvn metaobjects:generate`/`:verify` (Java/Kotlin), `metaobjects gen`/`verify`
(Python). Schema (`migrate`, `verify --db`) is Node-`meta`-only. Full matrix +
rationale: [docs/features/cli.md](docs/features/cli.md) (locked CLI architecture,
ADR-0015).

## Running tests

The Bun workspace root is the **repository root** (`/package.json`), which globs `server/typescript/packages/*` and `client/web/packages/*`. Java/Python/C# live outside the JS workspace (not globbed). Run `bun install` **once at the repo root**. Run `bun test` **scoped** — `cd server/typescript && bun test` for the server suite (this also picks up `server/typescript/bunfig.toml`'s test preload), and per-package for `client/web`. **Never run a bare `bun test` at the repo root**: it walks `java/`, `python/`, `csharp/`, and `fixtures/` looking for test files, turning a fast per-package run into many minutes.

```
bun install                                        # once, at the repo root
cd server/typescript && bun test                   # server suite (per-package; a bare run over the whole server suite now exceeds 5 min — scope it)
cd client/web/packages/<pkg> && bun test           # a single client package
bun run --filter '*' typecheck                     # whole workspace, from repo root
bun run --filter '*' build                         # whole workspace, from repo root
```

## How to contribute

PRs welcome. When contributing:

- Follow the TDD discipline: write tests first, then implementation.
- Use named constants for all metamodel strings — never inline `"field"`, `"object"`, etc.
- No `any` — use `unknown` and narrow.
- Run `bun test` in the relevant package before opening a PR. All tests must pass.
- For cross-language changes, ensure the wire format and vocabulary are preserved exactly.
- Look at existing generator implementations before adding a new one — the pattern is intentionally consistent.

For significant new features or architectural changes, open an issue first to discuss the approach.

**Publishing to npm:** see [docs/RELEASING.md](docs/RELEASING.md) — the procedure (RC → smoke-test → promote) plus the non-obvious gotchas (publish with `bun`, regen the lockfile after every version bump, runtime imports must be `dependencies`, verify a real external install in npm *and* pnpm).

## Roadmap pointer

See `spec/roadmap.md` for current and planned library work. (Consumer-adoption validation and the application-level prompt-pillar consolidation are pursued in adopter projects, not tracked in this repo.)

## Open questions

- [TECHNICAL] Field-type → Drizzle-column-type mapping table (needed for complete TS codegen coverage).
- [TECHNICAL] ObjectManagerDB further modernization. FR-003 Plan 4 (2026-05-27) closed the three engine-debt anti-patterns. The Spring Boot 3 starter + OMDB autoconfiguration + virtual-thread audit shipped 2026-05-30 (`metaobjects-spring-boot-starter`). **jOOQ migration is a closed non-goal**: jOOQ's OSS edition excludes Oracle/SQL Server/DB2 (commercial license required), which would paywall OMDB's commercial-DB drivers in a public OSS project, and jOOQ generates code *from* a schema — the inverse of MetaObjects' metadata-is-the-spine model.
- [TECHNICAL] Payload `origin.*` resolution in `codegen-spring` (Day-1 deferral — see `server/java/codegen-spring/src/main/java/com/metaobjects/generator/spring/KNOWN_GAPS.md`). Kotlin's `KotlinPayloadGenerator` is the cross-port reference.
- [TECHNICAL] WARN envelope-shape assertion on cross-port `expected-warnings.json` (closed 2026-05-27 — runners now assert envelope shape on warnings; legacy string-list path retired).

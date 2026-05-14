# Polyglot Monorepo + Open/Commercial Split — Design (Project H1)

**Date:** 2026-05-14
**Status:** Draft
**Scope:** Establish a polyglot monorepo for the MetaObjects standard, migrate the TS implementation out of `metaforge/`, separate AI-collab code into `forge/`, scaffold directories for upcoming Java / Python / C# implementations and shared conformance fixtures.

**Builds on:** Projects D, E, F, G (complete TS reference implementation).

## Context

After Projects D–G, the TS implementation is reference-quality: filter syntax, projections, currency, full Cleanup pass with `metaobjects/` directory convention, `BaseEntity` extends pattern, `@autoSet` timestamps, package split between Node and browser, polyglot-aligned file organization. downstream-consumer is the canonical TS consumer; both repos pass their tests + builds cleanly.

An existing Java implementation (metaobjects-core v6) pre-dates the TS reference's introduction of `layout`, `source`, `origin`, `currency`, `@autoSet`, and other patterns. The decision has been made to rebuild Java from the TS reference rather than migrate v6.

Project H1 is the first sub-project of the broader H roadmap, which will deliver:
- a polyglot monorepo for the standard (H1 — this project)
- shared cross-language conformance fixtures (H2)
- a Java implementation (H3, H4)
- migrations of real consumers onto the new shape (H5, H8, H9)
- npm publishing for the public TS surface (H7)

H1 sets up the structure where all H2–H10 work lands. It does not implement any of H2–H10; it scaffolds the directories with README pointers and establishes the open / future-capabilities split.

## Goal

Ship two new repos that replace `metaforge/`:

1. **`metaobjects/`** (Apache 2.0, polyglot) — the standard's home. Contains TS implementation today; scaffolds Java/Python/C# directories for future ports; conformance fixtures directory; spec docs.

2. **`forge/`** (separate repo, license to be finalized) — the AI-collab product. Currently contains the agent-docs generator (carved out of metaforge's CLI lib); will house future MCP server, Claude Code hooks installer, `forge ingest`, `forge audit`, `forge serve`, `forge capture` commands. Future commercial capabilities are out of this project's scope.

`metaforge/` is archived after migration. The `forge` binary is renamed to `meta` for the open standard's CLI; the `forge` brand is reserved for the separate product.

### Open / future-capabilities split

The clean split (no `forge` references in the open standard):

| Goes to `metaobjects/` (open) | Goes to `forge/` (separate) |
|---|---|
| Metadata loader, registry, typed views | agent-docs generator (creates `.meta/CLAUDE.md` content) |
| Codegen engines (TS, future Java) | Future MCP server |
| Migration tooling | Future `forge install-hooks` Claude Code installer |
| TS server runtime + browser runtime | Future `forge ingest` (extractor-driven AI authoring) |
| SDK (memory, paths, workspace) | Future `forge audit`, `forge serve`, `forge capture` |
| CLI binary `meta` with commands: `init`, `gen`, `migrate` | Future capabilities (out of public scope) |

Downstream apps install BOTH `@metaobjects/*` (the standard, from npm) AND optionally `@forge/*` (AI-collab features). The two ecosystems are independently versioned.

## Non-goals

- **Java port**: deferred to H3.
- **Conformance fixtures**: directory scaffolded in H1 with README; actual fixture extraction is H2.
- **npm publishing**: deferred to H7 (will happen once Java is in place so first stable release reflects polyglot reality).
- **Codegen target refactor**: deferred to H4.
- **Any consumer migration**: deferred to H5/H8/H9. downstream-consumer gets path/dep updates as part of H1 but no functional changes.
- **Future commercial capabilities in forge**: out of H roadmap scope entirely.
- **GitHub org / website / npm org setup**: organizational infrastructure listed as open questions; not gating H1's code work.

## Architecture

### `metaobjects/` directory layout

```
metaobjects/
├── spec/
│   ├── README.md                      # standard's elevator pitch
│   ├── roadmap.md                     # H1-H10 status tracker
│   ├── metamodel.md                   # 8-type vocabulary, attrs, semantics
│   ├── wire-format.md                 # JSON shape, package resolution, overlays
│   ├── conformance-tests.md           # stub; populated in H2
│   └── design-docs/                   # historical specs/plans (frozen with header notes)
│       ├── 2026-05-12-pluggable-generators-design.md
│       ├── 2026-05-13-tanstack-codegen-design.md
│       ├── 2026-05-13-server-alignment-design.md
│       ├── 2026-05-13-projections-design.md
│       ├── 2026-05-13-currency-design.md
│       ├── 2026-05-13-cleanup-design.md
│       └── (corresponding plan files)
├── fixtures/
│   └── conformance/
│       └── README.md                  # "fixtures land here in H2"
├── typescript/
│   ├── packages/
│   │   ├── metadata/                  # @metaobjects/metadata
│   │   ├── codegen-ts/                # @metaobjects/codegen-ts
│   │   ├── codegen-ts-tanstack/       # @metaobjects/codegen-ts-tanstack
│   │   ├── runtime-ts/                # @metaobjects/runtime-ts
│   │   ├── runtime-ts-client/         # @metaobjects/runtime-ts-client
│   │   ├── migrate-ts/                # @metaobjects/migrate-ts
│   │   ├── sdk/                       # @metaobjects/sdk (renamed from @metaforge/sdk)
│   │   └── cli/                       # @metaobjects/cli (renamed from @metaforge/cli; binary: `meta`)
│   ├── package.json                   # pnpm workspace root
│   ├── pnpm-workspace.yaml
│   ├── biome.json
│   ├── tsconfig.base.json
│   └── README.md                      # TS-specific docs
├── java/
│   └── README.md                      # "Java implementation lands in H3"
├── python/
│   └── README.md                      # future
├── csharp/
│   └── README.md                      # future
├── CLAUDE.md                          # umbrella context for the standard (copied from metaforge/docs/public-mirror/CLAUDE.md)
├── README.md                          # what is metaobjects? who's it for?
├── LICENSE                            # Apache 2.0
└── .gitignore
```

### `forge/` directory layout

```
forge/
├── packages/
│   ├── cli/                           # @forge/cli — extends @metaobjects/cli with AI commands (mcp, ingest, install-hooks, audit, serve, capture)
│   └── agent-docs/                    # @forge/agent-docs — generates .meta/CLAUDE.md content (carved out of metaforge's CLI lib)
├── enterprise/                        # placeholder for future capabilities (not populated in H1)
│   └── README.md
├── CLAUDE.md                          # forge-specific AI-collab context
├── README.md
├── LICENSE                            # to be finalized
└── package.json                       # pnpm workspace root
```

H1 ships the agent-docs package (since it exists in metaforge already) plus a stub structure for the future CLI extensions. The MCP server, `forge ingest`, etc., are NOT built in H1 — they're future work documented in `forge/CLAUDE.md`.

### CLAUDE.md split

`metaobjects/CLAUDE.md` is the public umbrella context for external contributors. It is **not** a copy of `metaforge/CLAUDE.md` — the metaforge command center remains private. Instead, `metaobjects/CLAUDE.md` is copied from `metaforge/docs/public-mirror/CLAUDE.md`, which contains only public-safe technical content.

See `metaobjects/CLAUDE.md` for the full contributor context. `forge/CLAUDE.md` is written fresh at H1 execution (forge-specific AI-collab context, separate from the standard's context).

### Why a separate forge repo (not a directory in metaobjects/)

- **License independence**: metaobjects/ is Apache 2.0. forge's license is to be finalized and may differ. Separate repos = separate license trees, no conflict.
- **Audience clarity**: contributors to the open standard work in metaobjects/. Users of the AI-collab product work with forge/. Issue trackers, PRs, communities don't mix.
- **Brand discipline**: `forge` is the product brand. Reserving it for one repo prevents the search-engine + GitHub confusion that comes from sharing the name across standard + product codebases.
- **Future flexibility**: forge can adopt a different versioning / release cadence / governance model without affecting the standard.

### File migration table

| Today (in `metaforge/`) | Tomorrow |
|---|---|
| `packages/metaobjects-metadata/` | `metaobjects/typescript/packages/metadata/` |
| `packages/codegen-ts/` | `metaobjects/typescript/packages/codegen-ts/` |
| `packages/codegen-ts-tanstack/` | `metaobjects/typescript/packages/codegen-ts-tanstack/` |
| `packages/runtime-ts/` | `metaobjects/typescript/packages/runtime-ts/` |
| `packages/runtime-ts-client/` | `metaobjects/typescript/packages/runtime-ts-client/` |
| `packages/migrate-ts/` | `metaobjects/typescript/packages/migrate-ts/` |
| `packages/sdk/` | `metaobjects/typescript/packages/sdk/` (renamed to `@metaobjects/sdk`) |
| `packages/cli/src/commands/{init,gen,migrate}.ts` | `metaobjects/typescript/packages/cli/src/commands/` |
| `packages/cli/src/lib/{args,config,kysely,load-forge-config,log,output,projection-migrations}.ts` | `metaobjects/typescript/packages/cli/src/lib/` |
| `packages/cli/src/lib/agent-docs.ts` | `forge/packages/agent-docs/src/index.ts` |
| `package.json` (workspace root) | `metaobjects/typescript/package.json` (pnpm workspace root) |
| `biome.json` | `metaobjects/typescript/biome.json` |
| `tsconfig.base.json` (if exists) | `metaobjects/typescript/tsconfig.base.json` |
| `bunfig.toml` | `metaobjects/typescript/bunfig.toml` |
| `docs/public-mirror/CLAUDE.md` | `metaobjects/CLAUDE.md` (public umbrella) |
| `docs/public-mirror/specs/*` | `metaobjects/spec/design-docs/` (sanitized versions) |
| `.git/` | Both new repos get fresh `.git/` |

### Renames

| Today | Tomorrow |
|---|---|
| `@metaforge/cli` package | `@metaobjects/cli` |
| `@metaforge/sdk` package | `@metaobjects/sdk` |
| Binary `forge` (in cli/bin/) | Binary `meta` |
| Config file `metaforge.config.ts` | `metaobjects.config.ts` |
| Project marker directory `.metaforge/` | `.metaobjects/` |
| `.metaforge/.gen-state/` | `.metaobjects/.gen-state/` |
| Internal `loadForgeConfig` function | `loadMetaobjectsConfig` |
| Constant `CONFIG_FILE = "metaforge.config.ts"` | `CONFIG_FILE = "metaobjects.config.ts"` |
| Constant `DEFAULT_METAFORGE_DIR = ".metaforge"` | `DEFAULT_METAOBJECTS_DIR = ".metaobjects"` |

The `DEFAULT_METADATA_DIR = "metaobjects"` constant is unchanged (that's the entity-data directory, not the tool-state directory).

### downstream-consumer implications

downstream-consumer is the only existing consumer and must be updated in lockstep with H1's atomic switch:

| File | Change |
|---|---|
| `apps/api/package.json` | `link:../../../metaforge/packages/<name>` → `link:../../../metaobjects/typescript/packages/<name>`; rename `@metaforge/cli` and `@metaforge/sdk` deps to `@metaobjects/cli` and `@metaobjects/sdk` |
| `apps/web/package.json` | Same |
| `packages/database/package.json` | Same |
| `metaforge.config.ts` | Rename → `metaobjects.config.ts` |
| `.metaforge/` directory | Rename → `.metaobjects/` |
| `.metaforge/.gen-state/` | Moves to `.metaobjects/.gen-state/` |
| `.metaforge/config.json` | Moves to `.metaobjects/config.json` |
| Root `.gitignore` entries | `.metaforge/` → `.metaobjects/` |
| Generated files | Imports already use `@metaobjects/runtime-ts-client` (post-G); no change. Regenerate after rename to update embedded `metaforge.config.ts` references in comments. |
| Any scripts in `package.json` that invoke `forge` | Invoke `meta` |
| Hand-written admin pages | No change |

After all rewrites, `pnpm install && pnpm build && pnpm dev` should produce identical functional behavior to pre-H1.

### Roadmap doc

`metaobjects/spec/roadmap.md` is created in H1. Content:

```markdown
# MetaObjects Roadmap

## Active
- **H1 — Polyglot monorepo + open/product split** (this project)

## Planned
- **H2 — Shared conformance fixtures** (1 wk)
  Extract ~40-60 fixtures from existing TS tests into `fixtures/conformance/`; TS conformance runner; format documented in `spec/conformance-tests.md`.
- **H3 — Java port (Loader + runtime)** (4-6 wk)
  Full Java Loader, typed MetaModel API, conformance test runner, runtime helpers (Spring JDBC, filter parser, `@autoSet`, currency, JSONB).
- **H4 — TS codegen Java target** (2-3 wk)
  Refactor TS codegen to pluggable targets; Java target emits Spring JDBC DAOs, Spring MVC controllers, POJOs, Bean Validation.
- **H5 — sibling-app Java backend migration** (3-4 wk)
  Author sibling-app's entity metadata; replace JPA → metaobjects-emitted Java; strip JPA annotations.
- **H6 — Forge AI commands implementation** (TBD)
  `forge mcp`, `forge install-hooks`, `forge ingest`, etc. Lives in `forge/`.
- **H7 — npm publish** (1 wk)
  First stable public release of `@metaobjects/*` packages; reflects polyglot reality (TS + Java).
- **H8 — downstream-consumer npm migration** (0.5 wk)
  Switch from `link:` deps to published npm versions.
- **H9 — sibling-app UI migration** (2-3 wk)
  sibling-app's TS frontend adopts `@metaobjects/runtime-ts-client`.
- **H10 — sibling-project migration** (3-4 wk)
  Java backend + TS frontend onto metaobjects.

## Future (sketched)
- Python port
- C# port
- Forms codegen revival (deferred from F)
- Date / case transforms
- Materialized views, federated entities, search-index sources
```

## Data flow

H1 doesn't change runtime data flow. The standard's behavior is identical pre- and post-migration. Code moves; semantics don't.

## Error handling

If any rename misses a reference, the corresponding consumer breaks at build time with a clear error: "Cannot find module @metaforge/cli" or similar. Mitigation: comprehensive grep audit pre-commit + green build verification post-commit.

## Testing

H1's correctness is verified by:
1. Pre-migration baseline: full `bun test` in metaforge passes (current state: 1612 pass, 0 fail).
2. Post-migration in metaobjects/typescript: same test count, same passes, zero failures.
3. downstream-consumer end-to-end: `pnpm build` clean; `pnpm dev` boots; all `/api/*` endpoints return 200; smoke test of one admin page in browser.
4. Grep audits:
   - No `metaforge` strings in `metaobjects/` source (excluding historical specs in `design-docs/`)
   - No `@metaforge/` package references anywhere in `metaobjects/typescript/`
   - No `forge.config.ts` string in `metaobjects/` source
   - No `.metaforge/` directory references in `metaobjects/` source
5. Forge repo builds cleanly with just the agent-docs package (`bun run --filter '@forge/agent-docs' build`).

No new tests added in H1 — it's a structural migration, not new functionality.

## Documentation

- `metaobjects/README.md`: standard's intro, what's in this repo, how to get started
- `metaobjects/CLAUDE.md`: copied from `metaforge/docs/public-mirror/CLAUDE.md` (public-safe contributor context)
- `metaobjects/spec/README.md`: spec docs intro
- `metaobjects/spec/roadmap.md`: H1-H10 tracker
- `metaobjects/spec/metamodel.md`: 8-type vocabulary (stub; to be populated from CLAUDE.md content in a future pass)
- `metaobjects/spec/wire-format.md`: JSON shape (stub initially)
- `metaobjects/spec/conformance-tests.md`: stub for H2
- `metaobjects/spec/design-docs/`: copied from `metaforge/docs/public-mirror/specs/`
- `metaobjects/typescript/README.md`: TS-specific docs
- `metaobjects/java/README.md`, `metaobjects/python/README.md`, `metaobjects/csharp/README.md`: stubs pointing at the roadmap
- `forge/README.md`: forge product intro
- `forge/CLAUDE.md`: forge-specific AI-collab context (written fresh at H1)

## Migration mechanics

The migration is an atomic switch — not incremental:

1. **Preparation phase** (no consumer impact):
   - Create `metaobjects/` and `forge/` repos (locally or on GitHub).
   - Copy directory tree from metaforge into the new structure.
   - Apply all renames (file content, paths, package.json names, config file names).
   - Run all builds + tests in the new structure. Verify clean.

2. **Atomic switch phase** (consumer briefly broken):
   - Update downstream-consumer deps + paths + config rename + directory rename.
   - Run `pnpm install`, `pnpm build`, smoke test.
   - Commit downstream-consumer's updates.

3. **Cleanup phase**:
   - Archive `metaforge/` repo.
   - Update any external documentation (metaobjects.com, README references) to point at the new repo locations.

Estimated lights-out window: 1-2 days for the atomic switch; preparation phase can take 3-5 days without affecting consumers.

## Decisions (resolved during brainstorm; recorded here)

- **Polyglot monorepo for the standard** (not per-language repos with shared spec): the Arrow/Avro model, justified by tightly-coupled wire format + shared fixtures.
- **Open / product split via separate repos**: forge in its own repo, not a subdirectory of metaobjects/.
- **`meta` binary, `metaobjects.config.ts` config**: the standard's CLI tooling gets a non-forge name.
- **Existing TS implementation migrates wholesale** (no incremental split): the cleanup is mechanical; nothing about it benefits from incremental rollout.
- **Java port is its own follow-on project** (H3): H1 only scaffolds the directory.
- **`metaforge/` archived after migration**: no dual-maintenance. The standard's home moves cleanly.

## Open questions

These are organizational/infrastructure concerns, not gating code work:

- **GitHub orgs**: which org owns each repo? Choice not blocking code work.
- **npm org**: `@metaobjects` org claim status — H7 makes this decision concrete.
- **Website strategy**: metaobjects.com (the standard) + a forge product site — content decisions, not gating.
- **Git history extraction**: use `git filter-repo` per package to preserve history (~half day cost) vs. accept clean-start history with "imported from metaforge" commits.

## What comes after Project H1

The roadmap doc in `metaobjects/spec/roadmap.md` is the canonical tracker. Summary:

- **H2** — Shared conformance fixtures (1 wk)
- **H3** — Java port: Loader + typed MetaModel + runtime helpers (4-6 wk)
- **H4** — TS codegen Java target: refactor for pluggable targets, emit Java (2-3 wk)
- **H5** — sibling-app Java backend migration (3-4 wk)
- **H6** — Forge AI commands implementation (TBD)
- **H7** — npm publish (1 wk)
- **H8** — downstream-consumer npm migration (0.5 wk)
- **H9** — sibling-app UI migration (2-3 wk)
- **H10** — sibling-project migration (3-4 wk)

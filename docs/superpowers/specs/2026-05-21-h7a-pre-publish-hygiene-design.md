# H7a — Pre-publish hygiene (decouple + metadata + version unification)

**Date:** 2026-05-21
**Status:** Design (ready for implementation plan)
**Project:** First sub-project of H7 (npm publishing for the public TS surface). H7 decomposes into three sequential chunks: **H7a (this doc)** = pre-publish hygiene with zero npm interaction; H7b = changesets adoption + release CI; H7c = first 0.5.0-rc → 0.5.0 publish.

## Background

The metaobjects repo has not yet shipped any TypeScript package to npm. The current workspace builds via `bun install` + `link:` paths in downstream consumers (downstream-consumer). To make a coordinated first npm release (planned at 0.5.0, marking the post-polyglot-split milestone), the workspace needs preparation work that doesn't touch npm itself: decoupling a publish-blocking dependency, unifying heterogeneous package versions, filling in standard pkg.json metadata, and fixing stale CI paths.

This work is grouped into H7a so it can ship and be verified without committing to the publish event. H7b (changesets adoption) and H7c (first publish) follow.

## Goal

After H7a ships:

1. `@metaobjects/cli` no longer depends on `@metaobjects/forge`. The agent-docs source (markdown body + content-hash helpers) lives in `@metaobjects/sdk/agent-docs` (sub-path export). `@metaobjects/forge` becomes unreferenced inside the repo and stays unpublished, awaiting H1's eventual carve-out to a separate repo.
2. All 11 publish-candidate packages report `version: "0.5.0"`. Heterogeneous versions (0.1.0 through 0.4.0) collapse into a single line.
3. Every publish-candidate `package.json` carries the standard set of npm-publish metadata (`license`, `repository.directory`, `homepage`, `bugs`, `keywords`, `publishConfig.access`, tightened `files`).
4. The four packages currently missing READMEs (`metadata`, `codegen-ts-react`, `codegen-ts-tanstack`, `sdk`) have them.
5. The CI conformance workflow ([.github/workflows/conformance.yml](../../../.github/workflows/conformance.yml)) uses post-FR-002 paths (`server/typescript/...`) instead of the stale `typescript/...` paths that broke this morning.
6. `bun run --filter '*' build` succeeds across the workspace, producing `dist/` for every package — verified but no publish.

## Non-goals (deferred to H7b)

- Installing changesets.
- Writing `.github/workflows/release.yml`.
- Adding `NPM_TOKEN` to GitHub repository secrets.

## Non-goals (deferred to H7c)

- Claiming the `@metaobjects` scope on npm.
- Enabling 2FA on the publishing account.
- The actual publish (0.5.0-rc.1 → `next`, then 0.5.0 → `latest`).
- Per-consumer (downstream-consumer) migration to npm-installed versions.

## Non-goals (out of all of H7)

- Publishing `@metaobjects/forge`. Forge stays unpublished. When forge's H1 carve-out happens later (separate repo), forge ships on its own timeline.
- Publishing `@metaobjects/conformance`. Internal test package; not for consumers.
- Per-package `LICENSE` files. The root [LICENSE](../../../LICENSE) (Apache 2.0) plus `"license": "Apache-2.0"` (SPDX identifier) in each pkg.json is sufficient for npm and is the modern convention.
- Renaming any package.
- Changing the package layout decided in FR-002 Phase 2.

## Publish-candidate packages

Eleven packages get published when H7c fires:

| Package | Location | Role |
|---|---|---|
| `@metaobjects/metadata` | `server/typescript/packages/metadata` | Metamodel loader, types, constants |
| `@metaobjects/codegen-ts` | `server/typescript/packages/codegen-ts` | Framework-neutral codegen engine |
| `@metaobjects/codegen-ts-react` | `server/typescript/packages/codegen-ts-react` | React form-file generator |
| `@metaobjects/codegen-ts-tanstack` | `server/typescript/packages/codegen-ts-tanstack` | TanStack hooks + grid codegen |
| `@metaobjects/runtime-ts` | `server/typescript/packages/runtime-ts` | Node-side runtime (Kysely, Drizzle, Fastify helpers) |
| `@metaobjects/migrate-ts` | `server/typescript/packages/migrate-ts` | Migration tooling |
| `@metaobjects/sdk` | `server/typescript/packages/sdk` | Programmatic SDK (memory, paths, agent-docs after H7a) |
| `@metaobjects/cli` | `server/typescript/packages/cli` | The `meta` CLI binary |
| `@metaobjects/runtime-web` | `client/web/packages/runtime-web` | Pure browser core |
| `@metaobjects/react` | `client/web/packages/react` | React runtime |
| `@metaobjects/tanstack` | `client/web/packages/tanstack` | TanStack runtime |

`@metaobjects/forge` and `@metaobjects/conformance` are deliberately not in this list.

## Design

### 1. Decouple `@metaobjects/cli` from `@metaobjects/forge` via SDK relocation

**Why SDK, not CLI.** The conventional answer for init-scaffolding content (Prisma, ESLint, Drizzle-kit pattern) is the CLI package. That convention applies when SDK is purely runtime. MetaObjects' SDK isn't — `sdk/src/forge-types.ts` already exists and its module comment explicitly says it's the source of truth for "codegen prompts, MCP exposers" alongside CLI usage. The SDK is the open shared programmatic surface for content that multiple consumers (CLI today; MCP server, programmatic tools, the metaobjects.dev website tomorrow) need. Agent-docs content fits that pattern: it is not CLI-specific config-template scaffolding; it is canonical reference content.

**Sub-path export keeps the doc body opt-in.** The agent-docs body is ~500 lines of markdown (~50KB string). Loading it in the SDK's default `.` entry would bloat consumers who only want `loadConfig` or `resolveMetaRoot`. A `./agent-docs` sub-path quarantines it.

**Concrete moves:**

```
FROM: server/typescript/packages/forge/src/agent-docs/index.ts (592 lines)
TO:   server/typescript/packages/sdk/src/agent-docs/
        ├── body.ts             — AGENT_DOCS_BODY string constant
        ├── content-hash.ts     — computeContentHash, withContentHash,
        │                         extractContentHash, isUnmodified
        └── index.ts            — re-exports both
```

The single 592-line forge file holds the markdown body plus the content-hash helpers plus some inline example exports (`Subscriber`, `defineConfig`, `SubscribeForm` — these are demo content inside the body, not part of the public API). The relocation splits the doc body and hash helpers into two files for readability but preserves the same external surface (`AGENT_DOCS_BODY`, `withContentHash`, `isUnmodified`, plus the lesser-used `computeContentHash` and `extractContentHash`).

`sdk/package.json` gains the sub-path export entry mirroring the pattern in `forge/package.json` today:

```jsonc
"exports": {
  ".":          { "bun": "./src/index.ts",            "types": "./src/index.ts",            "default": "./dist/index.js" },
  "./agent-docs": { "bun": "./src/agent-docs/index.ts", "types": "./src/agent-docs/index.ts", "default": "./dist/agent-docs/index.js" }
}
```

`@metaobjects/cli/src/commands/init.ts` swaps its single import:

```ts
// before:
import { AGENT_DOCS_BODY, withContentHash, isUnmodified } from "@metaobjects/forge/agent-docs";
// after:
import { AGENT_DOCS_BODY, withContentHash, isUnmodified } from "@metaobjects/sdk/agent-docs";
```

`@metaobjects/cli/package.json` drops `"@metaobjects/forge": "workspace:*"` from `dependencies`.

`@metaobjects/forge` becomes unreferenced. The package stays in the repo and stays unpublished, in line with H1's design intent that forge ultimately lives in a separate repo. Forge's own `forge/src/agent-docs/index.ts` is **deleted** (the content has moved); `forge/src/index.ts` either becomes empty or the package gets a top-level deprecation note pointing at `@metaobjects/sdk/agent-docs`.

### 2. Unify versions to 0.5.0

| Package | Current | New |
|---|---|---|
| `@metaobjects/metadata` | 0.2.4 | 0.5.0 |
| `@metaobjects/codegen-ts` | 0.1.0 | 0.5.0 |
| `@metaobjects/codegen-ts-react` | 0.4.0 | 0.5.0 |
| `@metaobjects/codegen-ts-tanstack` | 0.1.0 | 0.5.0 |
| `@metaobjects/runtime-ts` | 0.1.0 | 0.5.0 |
| `@metaobjects/migrate-ts` | 0.1.0 | 0.5.0 |
| `@metaobjects/sdk` | 0.2.0 | 0.5.0 |
| `@metaobjects/cli` | 0.2.0 | 0.5.0 |
| `@metaobjects/runtime-web` | 0.4.0 | 0.5.0 |
| `@metaobjects/react` | 0.4.0 | 0.5.0 |
| `@metaobjects/tanstack` | 0.4.0 | 0.5.0 |

`server/typescript/package.json` (the workspace root) also bumps to 0.5.0 to match.

`@metaobjects/forge` stays at 0.1.0 (not touched, not published).
`@metaobjects/conformance` is an internal package; its version is not part of this unification.

### 3. Per-package metadata

Every publish-candidate `package.json` carries this exact set of fields (added if missing, normalized if present):

```jsonc
{
  "name":        "@metaobjects/<pkg>",
  "version":     "0.5.0",
  "description": "<one-line>",                      // present on most; fill in missing
  "license":     "Apache-2.0",                      // SPDX identifier
  "author":      "Doug Mealing <doug@dougmealing.com>",
  "repository":  {
    "type":      "git",
    "url":       "https://github.com/metaobjectsdev/metaobjects.git",
    "directory": "<relative path from repo root>"
  },
  "homepage":    "https://metaobjects.dev",
  "bugs":        { "url": "https://github.com/metaobjectsdev/metaobjects/issues" },
  "keywords":    ["metaobjects", "metadata", /* pkg-specific keywords */],
  "type":        "module",
  "main":        "./dist/index.js",                 // existing in most
  "types":       "./src/index.ts",                  // existing
  "exports":     { /* existing per-package, unchanged */ },
  "files":       ["dist", "src", "README.md"],
  "publishConfig": { "access": "public" },          // required for scoped pkgs
  "scripts":     { /* existing */ },
  "dependencies": { /* existing */ },
  "peerDependencies": { /* existing */ },
  "devDependencies":  { /* existing */ }
}
```

Per-package keyword examples (final list assembled during implementation):

- `metadata`: `metaobjects, metadata, schema, loader, typescript`
- `codegen-ts`: `metaobjects, codegen, drizzle, zod, fastify, typescript`
- `codegen-ts-react`: `metaobjects, codegen, react, forms, react-hook-form`
- `codegen-ts-tanstack`: `metaobjects, codegen, tanstack, react-query, react-table`
- `runtime-ts`: `metaobjects, runtime, fastify, drizzle, kysely`
- `runtime-web`: `metaobjects, runtime, browser, currency, filter`
- `react`: `metaobjects, react, react-hook-form, forms, currency-input`
- `tanstack`: `metaobjects, tanstack, react-query, react-table, entity-grid`
- `migrate-ts`: `metaobjects, migrate, postgres, sqlite, schema-diff`
- `sdk`: `metaobjects, sdk, agent-docs, workspace`
- `cli`: `metaobjects, cli, scaffold, codegen, drift-detection`

**Preserve existing structure.** The `@metaobjects/cli` `package.json` already has `publishConfig.bin` rewriting `bin/meta.ts` → `dist/bin/meta.js` for the binary path post-build. Keep that. Also keep all existing `peerDependencies` blocks unchanged.

**`files` field tightening.** The current convention in this repo is `["dist", "src", "README.md"]` for runtime packages and `["dist", "src"]` for some others. Standardize on `["dist", "src", "README.md"]` everywhere (drops nothing currently shipped; adds README to packages that haven't been). Reject anything outside that — never ship `test/`, `tsconfig*.json`, or `*.tsbuildinfo`.

### 4. Missing READMEs

Write a 30-50 line README for each of: `metadata`, `codegen-ts-react`, `codegen-ts-tanstack`, `sdk`.

Each follows this template:

```markdown
# @metaobjects/<pkg>

<One-paragraph description: what this package is, who consumes it, why it exists.>

## Install

\`\`\`bash
pnpm add @metaobjects/<pkg>
\`\`\`

## Usage

<Minimal working example: 5-15 lines of code.>

## Pairs with

<For codegen packages: link to the matching runtime package.
For runtime packages: link to the matching codegen package.
For SDK/metadata: link to the spec.>

## Links

- [Spec](https://github.com/metaobjectsdev/metaobjects/tree/main/spec)
- [Roadmap](https://github.com/metaobjectsdev/metaobjects/blob/main/spec/roadmap.md)

## License

Apache 2.0 — see the [LICENSE](../../../../../LICENSE) at the repo root.
```

Existing READMEs (`codegen-ts`, `runtime-ts`, `migrate-ts`, `cli`, `runtime-web`, `react`, `tanstack`) get a quick consistency pass — verify they have install + usage + links sections. Don't rewrite if already adequate.

### 5. Fix CI conformance workflow

[.github/workflows/conformance.yml](../../../.github/workflows/conformance.yml) currently has four references to the pre-FR-002 path:

- `cd typescript && bun install` (in 3 jobs)
- `cd typescript/packages/conformance && bun bin/conformance.ts lint ...` (in fixture-lint)
- `cd typescript/packages/metadata && bun test test/conformance.test.ts` (in conformance)

Update every `typescript/` → `server/typescript/`. Verify by triggering the workflow (push to the H7a feature branch).

### 6. Verification

H7a is complete when **all** of these pass on the feature branch:

- `cd server/typescript && bun install` — clean.
- `cd server/typescript && bun test` + per-client-web-pkg `bun test` = baseline `2105 pass / 0 fail` preserved.
- `bun run --filter '*' build` succeeds. Every package produces `dist/` with `.js` + `.d.ts` files.
- `bun run --filter '*' typecheck` clean.
- No `@metaobjects/runtime-ts-client` references anywhere (carry-over check from FR-002 Phase 2).
- No `@metaobjects/forge` references in any publish-candidate package's `dependencies` or source code.
- CI conformance workflow runs green on the feature branch.
- Every publish-candidate `package.json` has all required fields per Section 3.
- Every publish-candidate package has a README.

## Phasing within H7a

Suggested commit grouping (one PR, but logical commits in this order):

1. **Decouple commit.** Move agent-docs source from forge to sdk; update CLI import; remove forge dep from CLI. Test + verify.
2. **Versions commit.** Bump all 11 packages + workspace root to 0.5.0.
3. **Per-package metadata commit.** Add `repository`, `homepage`, `bugs`, `keywords`, `publishConfig`, `author`, `license` to every publish-candidate. Tighten `files`.
4. **READMEs commit.** Write the four missing READMEs; consistency-pass the existing ones.
5. **CI fix commit.** Update conformance.yml paths.
6. **Verification commit (if any tweaks needed).** Full test + typecheck + build pass.

If a step's verification fails, fix it before continuing.

## Open questions

- **`@metaobjects` scope availability on npm.** Operational prereq for H7c, not blocking H7a. Should be confirmed during H7a so we know early if the scope is taken (in which case `@metaobjects-dev` or another scope is needed). Run `npm view @metaobjects/metadata` and `npm org ls metaobjects` early.
- **Author field.** Current proposal: `"Doug Mealing <doug@dougmealing.com>"`. If you'd rather use `"metaobjectsdev <hello@metaobjects.dev>"` or similar org-style, swap before publish.
- **`homepage = https://metaobjects.dev`.** Assumes that domain points somewhere (or will by H7c). If the domain isn't live, fall back to `https://github.com/metaobjectsdev/metaobjects`.
- **forge/src/index.ts contents post-decouple.** Three options: (a) leave file with whatever empty/placeholder content remains, (b) delete the file (forge becomes a directory with no `src/index.ts`), (c) replace with a deprecation comment pointing at SDK. Implementation can pick during PR.

## Out of scope (revisited)

This spec does NOT cover:

- The H7b changesets adoption (separate spec).
- The H7c first publish (separate spec).
- downstream-consumer migration from `link:` to npm-installed versions (downstream consumer concern, addressed when H7c ships).
- Java / Python / C# packages. TS-only.

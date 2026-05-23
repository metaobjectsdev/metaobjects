# Hoist the TypeScript workspace root to the repository root

**Date:** 2026-05-22
**Status:** Design (ready for implementation plan)
**Project:** Prerequisite fix for H7c (first npm publish). Discovered during H7c publish-readiness dry-runs: 8 of 11 packages publish cleanly, but the 3 `client/web` packages cannot, because of how the workspace is rooted. This doc fixes the workspace topology so all 11 publish uniformly. No npm interaction.

## Background

The bun workspace root is currently [server/typescript/package.json](../../../server/typescript/package.json) (`@metaobjectsdev/monorepo`, private). Its `workspaces` field globs `packages/*` **and** the out-of-root `../../client/web/packages/*`, reaching across into a sibling deployment-target tree to pull the browser packages into the same workspace.

This works for `bun install`, build, and test — bun happily links out-of-root members. It breaks at **publish**. `bun publish` (and `bun pm pack`) resolve a package's `workspace:*` dependencies to a concrete version by walking **up** from the package directory to find the workspace root. From `server/typescript/packages/*` the root is a direct ancestor, so resolution succeeds and `workspace:*` → `0.5.0`. From `client/web/packages/*` the root (`server/typescript/`) is a *sibling*, never an ancestor, so resolution fails with:

```
error: Failed to resolve workspace version for "@metaobjectsdev/metadata" in `dependencies`.
Run `bun install` and try again.
```

This blocks `runtime-web`, `react`, and `tanstack` (each depends on another `@metaobjectsdev/*` package via `workspace:*`). The 8 server-side packages are unaffected.

Research confirms the `../../`-out-of-root glob is the non-idiomatic root cause: bun's docs and the wider ecosystem (pnpm, yarn, npm) all assume workspace members live **under** the root. Bun's `workspace:*` → version replacement on publish is documented and works — it only fails here because the client members can't locate their root. pnpm has the same "members under the root" requirement, so a package-manager swap would not fix this.

## Goal

Make the workspace root an **ancestor of every JS/TS member** by relocating the workspace declaration to the repository root. After this ships:

1. A `/package.json` at the repo root is the bun workspace root, globbing `server/typescript/packages/*` and `client/web/packages/*`. Java/Python/C# live outside the JS workspace (not globbed).
2. `bun publish --dry-run` succeeds for **all 11** publish-candidate packages, with the 3 client packages resolving `workspace:*` → `0.5.0` exactly as the server packages already do.
3. No package directory moves. No dependency declaration changes (`workspace:*` stays everywhere and now resolves uniformly).
4. The existing dev workflow is preserved: one `bun install`, `cd server/typescript && bun test` stays fast and keeps its test preload, client tests run per-package.

## Non-goals

- No dependency-declaration edits. The `workspace:*` specifiers stay; we fix *where the workspace is rooted*, not how deps are declared. (The earlier "pin client deps to `0.5.0`" band-aid is explicitly rejected.)
- No package relocations. The `server/`/`client/` deployment-target layout is unchanged.
- No second workspace for `client/web` (the rejected Approach B).
- No changesets adoption or release CI — that remains H7b.
- No actual publish — that remains H7c.

## Design

### 1. New `/package.json` (repo root) — the workspace root

Relocated from `server/typescript/package.json`, with globs pointed at the two JS package trees and the `clean`/`test` scripts adjusted for the new cwd:

```jsonc
{
  "name": "@metaobjectsdev/monorepo",
  "version": "0.5.0",
  "private": true,
  "description": "MetaObjects — cross-language metadata standard. Repo-root JS/TS workspace.",
  "type": "module",
  "workspaces": ["server/typescript/packages/*", "client/web/packages/*"],
  "scripts": {
    "build": "bun run --filter '*' build",
    "typecheck": "bun run --filter '*' typecheck",
    "test": "cd server/typescript && bun test",
    "clean": "rm -rf server/typescript/packages/*/dist server/typescript/packages/*/*.tsbuildinfo client/web/packages/*/dist client/web/packages/*/*.tsbuildinfo"
  },
  "devDependencies": { "typescript": "^5.6.0" },
  "engines": { "bun": ">=1.3.0", "node": ">=22.0.0" },
  "packageManager": "bun@1.3.8"
}
```

`build` and `typecheck` use `--filter '*'`, which covers all workspace members regardless of tree, run from the root. `test` delegates with `cd server/typescript && bun test` to preserve the bunfig test preload (see §3) and to avoid a bare root `bun test` walking the polyglot tree for test-file discovery.

### 2. Delete `server/typescript/package.json`

Its sole role was being the workspace root; that moves to the repo root. It must be **deleted**, not merely stripped of `workspaces` — leaving a same-named (`@metaobjectsdev/monorepo`) package.json with a `workspaces` field inside the new workspace would create a nested-workspace conflict.

### 3. Leave `bunfig.toml` in place

[server/typescript/bunfig.toml](../../../server/typescript/bunfig.toml) holds a `[test] preload` of `./packages/runtime-ts/test/setup.ts`. bun loads `bunfig.toml` from the current working directory, so the canonical `cd server/typescript && bun test` continues to pick it up unchanged. This is the reason the root `test` script delegates via `cd` rather than running bare at the root. No bunfig move, no preload-path edit.

### 4. Lockfile

Delete the committed `server/typescript/bun.lock`; regenerate `/bun.lock` at the repo root via `bun install`; commit the new root lockfile. `node_modules` relocates to `/node_modules` automatically (already covered by the `.gitignore` `node_modules/` rule; verify and add an explicit root entry if needed).

### 5. CI — [.github/workflows/conformance.yml](../../../.github/workflows/conformance.yml)

The three `cd server/typescript && bun install` steps become `bun install` (run at the repo-root checkout cwd). The downstream `cd server/typescript/packages/<x> && bun <cmd>` steps are unchanged — those package directories did not move.

### 6. CLAUDE.md

Update two areas:
- The "Running tests" section: workspace root is now the repo root; `bun install` runs at root; run `bun test` scoped (`cd server/typescript && bun test`, client per-package) — never bare at the repo root (it would walk `java/`, `python/`, `csharp/`, `fixtures/` for test discovery).
- Any statement that "the Bun workspace root is `server/typescript/`" → repo root, globbing `server/typescript/packages/*` + `client/web/packages/*`; Java/Python/C# are outside the JS workspace.

## What does NOT change (and why it's safe)

- **`repository.directory`** fields in every package.json — already correct repo-relative paths; packages don't move.
- **Client `tsconfig` `extends: ../../../../server/typescript/tsconfig.base.json`** — relative path between unchanged directories; still resolves.
- **`workspace:*` dependency specifiers** — unchanged everywhere; now resolvable for client packages because the root is an ancestor.
- **Commit hooks** (`.githooks/pre-commit`) — path-agnostic structural checks; unaffected.

## Acceptance criteria

1. `bun install` at the repo root → clean install; a single `/bun.lock` and `/node_modules`; no `server/typescript/bun.lock`.
2. `cd server/typescript && bun test` → **2123 pass / 0 fail** (5 skip).
3. Client tests → `runtime-web` 30, `react` 12, `tanstack` 29 — **0 fail**.
4. `bun run --filter '*' typecheck` from root → all members exit 0.
5. `bun run --filter '*' build` from root → all members exit 0, `dist/` produced.
6. **`bun publish --dry-run` for all 11 publish-candidates → all succeed.** A `bun pm pack` of a client package (e.g. `react`) shows its `@metaobjectsdev/*` deps as `0.5.0`, not `workspace:*`. ← primary success signal.
7. CI conformance workflow green on the change branch.

## Risks & mitigations

- **Dependency hoisting differences.** Moving to a root `node_modules` re-hoists; a package relying on a `server/typescript`-local resolution quirk could surface. *Mitigation:* full test + typecheck + build run (criteria 2–5) catches it.
- **Nested-workspace confusion** if `server/typescript/package.json` lingers. *Mitigation:* delete it (§2); verify `bun install` reports the expected member count.
- **Reverses a documented decision.** CLAUDE.md previously said "no repo-root workspace." *Mitigation:* the documented slowness stems from running bun at the root *without* a workspace; a root workspace plus scoped `bun test` (criteria via §1/§6) keeps runs fast. CLAUDE.md is updated (§6) so the rationale is recorded, not contradicted.

# Hoist TS Workspace Root to Repo Root — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Execute **inline on `main`** (shared `bun install`/lockfile state precludes parallel subagents).

**Goal:** Relocate the bun workspace declaration from `server/typescript/package.json` to a new `/package.json` at the repo root, so the workspace root is an ancestor of all 11 JS/TS members and `workspace:*` resolves uniformly at publish time — unblocking the 3 `client/web` packages.

**Architecture:** Pure workspace-topology change. No package directories move; no dependency specifiers change. The `workspaces` globs become `server/typescript/packages/*` + `client/web/packages/*`; lockfile + `node_modules` relocate to the root. Verification is "existing suite stays green + all 11 `bun publish --dry-run` succeed," not new failing tests.

**Tech Stack:** Bun 1.3.8 workspaces, TypeScript 5.6, GitHub Actions.

**Spec:** [docs/superpowers/specs/2026-05-22-hoist-ts-workspace-root-design.md](../specs/2026-05-22-hoist-ts-workspace-root-design.md)

---

## File Structure (changes)

**Created:**
- `/package.json` — repo-root bun workspace root (relocated from `server/typescript/package.json`)
- `/bun.lock` — regenerated at root by `bun install`

**Deleted:**
- `server/typescript/package.json` — workspace-root role moves up
- `server/typescript/bun.lock` — stale; replaced by root lockfile
- `server/typescript/node_modules/` — re-hoisted to `/node_modules` (gitignored, not tracked)

**Modified:**
- `.github/workflows/conformance.yml` — 3× `cd server/typescript && bun install` → `bun install`
- `CLAUDE.md` — workspace-root + test-running guidance

**Unchanged (verified safe):** all `packages/*/package.json` (incl. `workspace:*` deps and `repository.directory`), client `tsconfig` `extends`, `server/typescript/bunfig.toml`, `server/typescript/tsconfig.base.json`, `.githooks/`.

---

## Pre-flight

- [ ] **Confirm clean baseline on main.**

Run:
```
cd <repo-root> && git rev-parse --abbrev-ref HEAD && git status --short
```
Expected: `main`, and clean (no output after the branch name).

- [ ] **Record current test count for comparison.**

Run:
```
cd <repo-root>/server/typescript && bun test 2>&1 | tail -3
```
Expected: `Ran 2123 tests ... 0 fail` (5 skip). Note the number.

---

## Task 1: Relocate the workspace root

**Files:**
- Create: `/package.json`
- Delete: `server/typescript/package.json`, `server/typescript/bun.lock`, `server/typescript/node_modules/`
- Regenerate: `/bun.lock`, `/node_modules/`

- [ ] **Step 1: Create `/package.json` at the repo root.**

Create `<repo-root>/package.json` with exactly:

```json
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

- [ ] **Step 2: Delete the old workspace root + stale lockfile + node_modules.**

Run:
```
cd <repo-root>
git rm server/typescript/package.json server/typescript/bun.lock
rm -rf server/typescript/node_modules
```
Expected: git stages both deletions; node_modules removed. (Deleting `server/typescript/package.json` before install avoids a nested-workspace conflict with the new root.)

- [ ] **Step 3: Install at the root to regenerate the lockfile + node_modules.**

Run:
```
cd <repo-root> && bun install 2>&1 | tail -5
```
Expected: clean install; reports the workspace members (11 publish-candidates + `forge` + `conformance` = 13). A `/bun.lock` and `/node_modules` now exist. If bun reports "Failed to resolve" or finds 0 workspaces, STOP — the `workspaces` globs in Step 1 are wrong.

- [ ] **Step 4: Confirm topology — root lockfile present, server one gone, members linked.**

Run:
```
cd <repo-root>
test -f bun.lock && echo "ok: /bun.lock" || echo "MISSING /bun.lock"
test -f server/typescript/bun.lock && echo "STALE server lockfile still here" || echo "ok: server lockfile gone"
ls node_modules/@metaobjectsdev/ | sort
```
Expected: `ok: /bun.lock`, `ok: server lockfile gone`, and the `@metaobjectsdev/` symlinks include `metadata`, `runtime-web`, `react`, `tanstack`, `cli`, etc.

- [ ] **Step 5: Smoke-test workspace resolution for a client package (the whole point).**

Run:
```
cd <repo-root>/client/web/packages/react && bun pm pack --dry-run 2>&1 | tail -3
```
Expected: packs successfully (no "Failed to resolve workspace version"). If it still fails, STOP and re-check the globs.

- [ ] **Step 6: Commit.**

```
cd <repo-root>
git add package.json bun.lock
git commit -m "refactor(workspace): hoist bun workspace root to repo root"
```

---

## Task 2: Verify the full suite stays green

**Files:** none (verification gate).

- [ ] **Step 1: Server tests (from server tree, preserving the bunfig preload).**

Run:
```
cd <repo-root>/server/typescript && bun test 2>&1 | tail -3
```
Expected: `Ran 2123 tests ... 0 fail` (matches the pre-flight count).

- [ ] **Step 2: Client tests.**

Run:
```
cd <repo-root>
for p in client/web/packages/runtime-web client/web/packages/react client/web/packages/tanstack; do echo "--- $p ---"; (cd "$p" && bun test 2>&1 | tail -2); done
```
Expected: runtime-web 30, react 12, tanstack 29 — each `0 fail`.

- [ ] **Step 3: Typecheck all members from root.**

Run:
```
cd <repo-root> && bun run --filter '*' typecheck >/dev/null 2>&1 && echo "ALL TYPECHECK EXIT 0" || echo "TYPECHECK FAILED"
```
Expected: `ALL TYPECHECK EXIT 0`.

- [ ] **Step 4: Build all members from root.**

Run:
```
cd <repo-root> && bun run --filter '*' build 2>&1 | grep -iE "exited with code [^0]|error" | head; echo "build done"
```
Expected: no non-zero exit / error lines before `build done`.

(No commit — this task only gates. If anything fails here, fix before proceeding.)

---

## Task 3: Publish dry-run acceptance (primary success signal)

**Files:** none (verification gate).

- [ ] **Step 1: Dry-run all 11 publish-candidates in dependency order.**

Run:
```
cd <repo-root>
pkgs=(
  server/typescript/packages/metadata
  server/typescript/packages/codegen-ts
  server/typescript/packages/runtime-ts
  server/typescript/packages/migrate-ts
  server/typescript/packages/sdk
  client/web/packages/runtime-web
  server/typescript/packages/codegen-ts-react
  server/typescript/packages/codegen-ts-tanstack
  client/web/packages/react
  client/web/packages/tanstack
  server/typescript/packages/cli
)
fail=0
for p in "${pkgs[@]}"; do
  out=$(cd "$p" && bun publish --dry-run 2>&1); code=$?
  nv=$(cd "$p" && bun -e 'const j=require("./package.json"); console.log(j.name+"@"+j.version)')
  [ $code -ne 0 ] && { fail=1; echo "FAIL  $nv"; echo "$out" | tail -3; } || echo "ok    $nv"
done
[ $fail -eq 0 ] && echo "ALL 11 DRY-RUNS OK" || echo "SOME FAILED"
```
Expected: 11 `ok` lines and `ALL 11 DRY-RUNS OK` — including the 3 client packages that previously failed.

- [ ] **Step 2: Confirm a client package's deps resolve to 0.5.0 in the tarball.**

Run:
```
cd <repo-root>
TMP=$(mktemp -d); (cd client/web/packages/tanstack && bun pm pack --destination "$TMP" >/dev/null 2>&1)
tar -xzf "$TMP"/*.tgz -C "$TMP"
bun -e 'console.log(JSON.stringify(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).dependencies,null,2))' "$TMP/package/package.json"
rm -rf "$TMP"
```
Expected: `@metaobjectsdev/runtime-web` and `@metaobjectsdev/react` both show `"0.5.0"` (not `"workspace:*"`).

---

## Task 4: Update CI workflow

**Files:**
- Modify: `.github/workflows/conformance.yml`

- [ ] **Step 1: Repoint the three install steps to the repo root.**

In `.github/workflows/conformance.yml`, change each of the three occurrences of:
```
      - run: cd server/typescript && bun install
```
to:
```
      - run: bun install
```
Leave the `cd server/typescript/packages/<x> && bun ...` steps unchanged (those packages did not move).

- [ ] **Step 2: Verify no stale install paths remain.**

Run:
```
cd <repo-root> && grep -n "bun install" .github/workflows/conformance.yml
```
Expected: three `      - run: bun install` lines, none with `cd server/typescript`.

- [ ] **Step 3: Commit.**

```
cd <repo-root>
git add .github/workflows/conformance.yml
git commit -m "ci: run bun install at repo root after workspace hoist"
```

---

## Task 5: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md` ("Running tests" section + workspace-root statements)

- [ ] **Step 1: Replace the "Running tests" guidance.**

In `CLAUDE.md`, find the "Running tests" section. It currently says the Bun workspace root is `typescript/` and warns never to run from the repo root. Replace its body so it reads (keep the surrounding `## Running tests` heading and the fenced command block, adjusting as below):

> The Bun workspace root is the **repository root** (`/package.json`), globbing `server/typescript/packages/*` and `client/web/packages/*`. Java/Python/C# live outside the JS workspace. Run `bun install` once at the repo root. Run `bun test` **scoped** — `cd server/typescript && bun test` (uses `server/typescript/bunfig.toml`'s preload) for the server suite, and per-package for client/web. Never run a bare `bun test` at the repo root: it walks `java/`, `python/`, `csharp/`, and `fixtures/` for test files, turning a ~3-second run into minutes.

Update the fenced command block in that section to:
```
bun install                                        # once, at repo root
cd server/typescript && bun test                   # server suite (~3s)
cd client/web/packages/<pkg> && bun test           # a client package
bun run --filter '*' typecheck                     # whole workspace, from root
```

- [ ] **Step 2: Scan for any other "workspace root is server/typescript" claims.**

Run:
```
cd <repo-root> && grep -niE "workspace root is|never from the repo|cd typescript" CLAUDE.md
```
Fix any remaining statement that still names `server/typescript`/`typescript/` as the workspace root to reflect the repo root. (If none remain, continue.)

- [ ] **Step 3: Commit.**

```
cd <repo-root>
git add CLAUDE.md
git commit -m "docs: update workspace-root + test-running guidance after hoist"
```

---

## Task 6: Final clean-state verification

**Files:** none.

- [ ] **Step 1: Confirm root node_modules is gitignored and nothing stray is staged.**

Run:
```
cd <repo-root>
git status --short
git check-ignore node_modules >/dev/null && echo "ok: node_modules ignored" || echo "WARN: node_modules NOT ignored"
```
Expected: working tree clean (all task commits done), and `ok: node_modules ignored`. If `node_modules` is not ignored, add `/node_modules/` to `.gitignore` and commit.

- [ ] **Step 2: Re-run the full 11-package dry-run once more as the final gate.**

Run the Task 3 Step 1 loop again.
Expected: `ALL 11 DRY-RUNS OK`.

- [ ] **Step 3: Report completion.** Summarize: workspace root relocated, lockfile at root, suite green (server 2123 / client 71 / typecheck 0 / build 0), all 11 dry-runs pass, CI + CLAUDE.md updated. Note that the actual `bun publish` (H7c) remains gated on the user's go.

---

## Self-Review Notes

This is a topology change, not feature code, so verification is "existing suite stays green + all 11 dry-runs pass" rather than a red-green TDD cycle (mirrors the H7a plan). Spec coverage: §1 root package.json → Task 1; §2 delete old root → Task 1 Step 2; §3 bunfig untouched → not a task (intentional no-op, asserted in File Structure); §4 lockfile → Task 1; §5 CI → Task 4; §6 CLAUDE.md → Task 5; acceptance criteria 1–6 → Tasks 1–3 + 6; criterion 7 (CI green) → verified after push (out of this inline run; the workflow change is committed in Task 4). The `bunfig.toml`-stays decision is load-bearing: it's why Task 1 does not touch it and Task 5 Step 1 documents the scoped `cd server/typescript && bun test`.

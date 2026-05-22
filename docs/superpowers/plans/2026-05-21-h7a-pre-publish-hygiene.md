# H7a — Pre-publish Hygiene Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prepare the 11 publish-candidate TypeScript packages for a coordinated npm release — decouple `@metaobjectsdev/cli` from `@metaobjectsdev/forge` (relocating agent-docs into `@metaobjectsdev/sdk/agent-docs`), unify all versions to 0.5.0, add standard npm metadata, write missing READMEs, and fix the stale conformance CI workflow. Zero npm interaction.

**Architecture:** Mostly mechanical config + docs work over existing package.json files, plus one source relocation (forge agent-docs → sdk sub-path). No new runtime behavior. Success = existing test suite stays at 2105 pass / 0 fail, `bun run --filter '*' build` succeeds, and no `@metaobjectsdev/forge` references remain in publish-candidate packages.

**Tech Stack:** Bun 1.3.8 workspaces, TypeScript 5.6, tsc for build, GitHub Actions (conformance workflow).

**Spec:** [docs/superpowers/specs/2026-05-21-h7a-pre-publish-hygiene-design.md](../specs/2026-05-21-h7a-pre-publish-hygiene-design.md)

---

## File Structure (changes by task)

**Created:**
- `server/typescript/packages/sdk/src/agent-docs/body.ts` — AGENT_DOCS_BODY constant
- `server/typescript/packages/sdk/src/agent-docs/content-hash.ts` — 4 hash helpers
- `server/typescript/packages/sdk/src/agent-docs/index.ts` — re-exports
- `server/typescript/packages/metadata/README.md`
- `server/typescript/packages/codegen-ts-react/README.md`
- `server/typescript/packages/codegen-ts-tanstack/README.md`
- `server/typescript/packages/sdk/README.md`

**Modified:**
- `server/typescript/packages/sdk/package.json` — add `./agent-docs` export + npm metadata + version
- `server/typescript/packages/cli/src/commands/init.ts` — repoint import
- `server/typescript/packages/cli/package.json` — drop forge dep + npm metadata + version
- 11 publish-candidate `package.json` files — version 0.5.0 + metadata
- `server/typescript/package.json` — version 0.5.0
- `.github/workflows/conformance.yml` — fix paths

**Deleted:**
- `server/typescript/packages/forge/src/agent-docs/index.ts` — content moved to sdk
- (forge keeps existing; `forge/src/index.ts` updated to not re-export the deleted file)

---

## Pre-flight

- [ ] **Baseline:**

```
cd <repo-root>/server/typescript && bun install && bun test 2>&1 | tail -3
```
Expected: `2105 pass / 5 skip / 0 fail` (server side; the client/web packages add 71 more across their own dirs).

- [ ] **Branch:**

```
cd <repo-root> && git checkout -b feat/h7a-pre-publish-hygiene
```

---

## Task 1: Relocate agent-docs into SDK

**Files:**
- Create: `server/typescript/packages/sdk/src/agent-docs/body.ts`
- Create: `server/typescript/packages/sdk/src/agent-docs/content-hash.ts`
- Create: `server/typescript/packages/sdk/src/agent-docs/index.ts`
- Modify: `server/typescript/packages/sdk/package.json` (exports map)

- [ ] **Step 1: Create the content-hash module.**

Create `server/typescript/packages/sdk/src/agent-docs/content-hash.ts` with exactly the four functions from `forge/src/agent-docs/index.ts` lines 570-592 plus the crypto import:

```ts
import { createHash } from "node:crypto";

export function computeContentHash(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

/** Returns the body with a content-hash HTML comment prepended. */
export function withContentHash(body: string): string {
  const hash = computeContentHash(body);
  return `<!-- metaobjects-content-hash: ${hash} -->\n${body}`;
}

/** Extract the embedded hash, or undefined if not present. */
export function extractContentHash(fileBody: string): string | undefined {
  const match = /<!-- metaobjects-content-hash: ([a-f0-9]{64}) -->/.exec(fileBody);
  return match?.[1];
}

/** True iff the file body's hash matches its own content (i.e. unmodified). */
export function isUnmodified(fileBody: string): boolean {
  const embedded = extractContentHash(fileBody);
  if (embedded === undefined) return false;
  const withoutHash = fileBody.replace(/^<!-- metaobjects-content-hash: [a-f0-9]{64} -->\n/, "");
  return computeContentHash(withoutHash) === embedded;
}
```

- [ ] **Step 2: Create the body module by extracting the constant.**

The `AGENT_DOCS_BODY` constant is `forge/src/agent-docs/index.ts` lines 8-568 (a single template literal). Move it verbatim — do NOT edit the markdown content in this task (content updates, including any "Meta Forge" → "MetaObjects" rebrand, are a separate concern). Use a shell extraction to avoid hand-copying 560 lines:

```
cd <repo-root>
mkdir -p server/typescript/packages/sdk/src/agent-docs
# Extract lines 8-568 (the AGENT_DOCS_BODY export) into body.ts
sed -n '8,568p' server/typescript/packages/forge/src/agent-docs/index.ts \
  > server/typescript/packages/sdk/src/agent-docs/body.ts
```

Then prepend a one-line module comment by opening `body.ts` and adding above line 1:

```ts
// Agent reference docs body. Scaffolded into .metaobjects/AGENTS.md and CLAUDE.md by `meta init`.
```

Verify the file starts with `export const AGENT_DOCS_BODY = \`` and ends with the closing `` `; ``.

- [ ] **Step 3: Create the barrel.**

Create `server/typescript/packages/sdk/src/agent-docs/index.ts`:

```ts
// Public surface for @metaobjectsdev/sdk/agent-docs.
export { AGENT_DOCS_BODY } from "./body.js";
export {
  computeContentHash,
  withContentHash,
  extractContentHash,
  isUnmodified,
} from "./content-hash.js";
```

- [ ] **Step 4: Add the sub-path export to sdk/package.json.**

Open `server/typescript/packages/sdk/package.json`. Find the `exports` map and add the `./agent-docs` entry (preserve the existing `.` entry exactly):

```jsonc
"exports": {
  ".": {
    "bun": "./src/index.ts",
    "types": "./src/index.ts",
    "default": "./dist/index.js"
  },
  "./agent-docs": {
    "bun": "./src/agent-docs/index.ts",
    "types": "./src/agent-docs/index.ts",
    "default": "./dist/agent-docs/index.js"
  }
}
```

- [ ] **Step 5: Typecheck the sdk package.**

```
cd <repo-root>/server/typescript/packages/sdk && bun run typecheck
```
Expected: exit 0. If `createHash` import errors, confirm `@types/node` or `bun-types` is in sdk devDeps (it should be — bun-types covers node).

- [ ] **Step 6: Commit.**

```
cd <repo-root>
git add server/typescript/packages/sdk/
git commit -m "feat(sdk): add @metaobjectsdev/sdk/agent-docs (relocated from forge)"
```

---

## Task 2: Repoint CLI, drop forge dep, clean up forge

**Files:**
- Modify: `server/typescript/packages/cli/src/commands/init.ts:7`
- Modify: `server/typescript/packages/cli/package.json` (remove forge dep)
- Delete: `server/typescript/packages/forge/src/agent-docs/index.ts`
- Modify: `server/typescript/packages/forge/src/index.ts`

- [ ] **Step 1: Repoint the CLI import.**

In `server/typescript/packages/cli/src/commands/init.ts`, line 7, change:

```ts
import { AGENT_DOCS_BODY, withContentHash, isUnmodified } from "@metaobjectsdev/forge/agent-docs";
```
to:
```ts
import { AGENT_DOCS_BODY, withContentHash, isUnmodified } from "@metaobjectsdev/sdk/agent-docs";
```

- [ ] **Step 2: Remove the forge dependency from cli/package.json.**

In `server/typescript/packages/cli/package.json`, delete the line:
```json
"@metaobjectsdev/forge": "workspace:*",
```
from `dependencies`. (Confirm `@metaobjectsdev/sdk` is already a dependency — it is.)

- [ ] **Step 3: Delete the relocated forge source + update forge barrel.**

```
cd <repo-root>
git rm server/typescript/packages/forge/src/agent-docs/index.ts
```

Then replace `server/typescript/packages/forge/src/index.ts` content with:

```ts
// @metaobjectsdev/forge — AI-collaboration capabilities (unpublished, repo-internal).
//
// The agent-docs generator moved to @metaobjectsdev/sdk/agent-docs (FR/H7a). This
// package is retained for the future MCP server, Claude Code hooks installer,
// and `forge ingest`/`audit`/`serve`/`capture` commands, and will carve out to
// a separate repo per the H1 polyglot design. It is NOT published to npm.
export {};
```

Also remove the now-broken `./agent-docs` export from `forge/package.json`'s `exports` map (leave only the `.` entry pointing at the empty index).

- [ ] **Step 4: Reinstall + run the CLI's init-docs test.**

```
cd <repo-root>/server/typescript
bun install
bun test packages/cli/test/unit/init-refresh-docs.test.ts 2>&1 | tail -5
```
Expected: PASS. This test scaffolds `.metaobjects/CLAUDE.md` and asserts content — it exercises the relocated agent-docs end to end.

- [ ] **Step 5: Full test run.**

```
bun test 2>&1 | tail -3
```
Expected: `2105 pass / 5 skip / 0 fail`.

- [ ] **Step 6: Verify no forge references remain in cli.**

```
cd <repo-root>
grep -rn "@metaobjectsdev/forge" server/typescript/packages/cli/ 2>/dev/null | grep -v node_modules | grep -v dist
```
Expected: empty.

- [ ] **Step 7: Commit.**

```
git add server/typescript/packages/cli/ server/typescript/packages/forge/
git commit -m "refactor(cli): consume agent-docs from @metaobjectsdev/sdk, drop forge dep"
```

---

## Task 3: Unify versions to 0.5.0

**Files:**
- Modify: `version` field in 11 publish-candidate package.json files + `server/typescript/package.json`

- [ ] **Step 1: Bump every publish-candidate + workspace root to 0.5.0.**

Edit the `"version"` field to `"0.5.0"` in each of:

```
server/typescript/package.json                              (0.4.0 → 0.5.0)
server/typescript/packages/metadata/package.json            (0.2.4 → 0.5.0)
server/typescript/packages/codegen-ts/package.json          (0.1.0 → 0.5.0)
server/typescript/packages/codegen-ts-react/package.json    (0.4.0 → 0.5.0)
server/typescript/packages/codegen-ts-tanstack/package.json (0.1.0 → 0.5.0)
server/typescript/packages/runtime-ts/package.json          (0.1.0 → 0.5.0)
server/typescript/packages/migrate-ts/package.json          (0.1.0 → 0.5.0)
server/typescript/packages/sdk/package.json                 (0.2.0 → 0.5.0)
server/typescript/packages/cli/package.json                 (0.2.0 → 0.5.0)
client/web/packages/runtime-web/package.json                (0.4.0 → 0.5.0)
client/web/packages/react/package.json                      (0.4.0 → 0.5.0)
client/web/packages/tanstack/package.json                   (0.4.0 → 0.5.0)
```

Do NOT touch `server/typescript/packages/forge/package.json` (stays 0.1.0, unpublished) or `server/typescript/packages/conformance/package.json` (internal).

- [ ] **Step 2: Reinstall (updates workspace version refs in lockfile).**

```
cd <repo-root>/server/typescript && bun install 2>&1 | tail -3
```
Expected: clean. `workspace:*` deps don't pin a version, so no dependency edits are needed — they resolve to 0.5.0 automatically.

- [ ] **Step 3: Test.**

```
bun test 2>&1 | tail -3
```
Expected: `2105 pass / 0 fail`.

- [ ] **Step 4: Commit.**

```
cd <repo-root>
git add -A
git commit -m "chore(release): unify all publish-candidate packages to 0.5.0"
```

---

## Task 4: Per-package npm metadata

**Files:**
- Modify: 11 publish-candidate package.json files

For each of the 11 packages, ensure these fields are present and correct. Add if missing; normalize if present. **Preserve all existing fields** (`type`, `main`, `types`, `exports`, `scripts`, `dependencies`, `peerDependencies`, `peerDependenciesMeta`, `devDependencies`, and `cli`'s `bin` + `publishConfig.bin`).

Common values (identical across all 11):
```jsonc
"license": "Apache-2.0",
"author": "Doug Mealing <doug@dougmealing.com>",
"homepage": "https://metaobjects.dev",
"bugs": { "url": "https://github.com/metaobjectsdev/metaobjects/issues" },
"files": ["dist", "src", "README.md"],
"publishConfig": { "access": "public" }
```

Per-package `repository` (note the `directory` differs) and `keywords`:

- [ ] **Step 1: `@metaobjectsdev/metadata`** — add to `server/typescript/packages/metadata/package.json`:
```jsonc
"repository": { "type": "git", "url": "https://github.com/metaobjectsdev/metaobjects.git", "directory": "server/typescript/packages/metadata" },
"keywords": ["metaobjects", "metadata", "schema", "loader", "typescript"]
```
plus the common values above.

- [ ] **Step 2: `@metaobjectsdev/codegen-ts`** — `directory: "server/typescript/packages/codegen-ts"`, `keywords: ["metaobjects", "codegen", "drizzle", "zod", "fastify", "typescript"]` + common. **For `cli` only** there is a `publishConfig.bin`; codegen-ts has no bin — `publishConfig` is just `{ "access": "public" }`.

- [ ] **Step 3: `@metaobjectsdev/codegen-ts-react`** — `directory: "server/typescript/packages/codegen-ts-react"`, `keywords: ["metaobjects", "codegen", "react", "forms", "react-hook-form"]` + common.

- [ ] **Step 4: `@metaobjectsdev/codegen-ts-tanstack`** — `directory: "server/typescript/packages/codegen-ts-tanstack"`, `keywords: ["metaobjects", "codegen", "tanstack", "react-query", "react-table"]` + common.

- [ ] **Step 5: `@metaobjectsdev/runtime-ts`** — `directory: "server/typescript/packages/runtime-ts"`, `keywords: ["metaobjects", "runtime", "fastify", "drizzle", "kysely"]` + common.

- [ ] **Step 6: `@metaobjectsdev/migrate-ts`** — `directory: "server/typescript/packages/migrate-ts"`, `keywords: ["metaobjects", "migrate", "postgres", "sqlite", "schema-diff"]` + common.

- [ ] **Step 7: `@metaobjectsdev/sdk`** — `directory: "server/typescript/packages/sdk"`, `keywords: ["metaobjects", "sdk", "agent-docs", "workspace"]` + common.

- [ ] **Step 8: `@metaobjectsdev/cli`** — `directory: "server/typescript/packages/cli"`, `keywords: ["metaobjects", "cli", "scaffold", "codegen", "drift-detection"]` + common. **Preserve the existing `publishConfig.bin`** by merging: `"publishConfig": { "access": "public", "bin": { "meta": "./dist/bin/meta.js" } }`.

- [ ] **Step 9: `@metaobjectsdev/runtime-web`** — `directory: "client/web/packages/runtime-web"`, `keywords: ["metaobjects", "runtime", "browser", "currency", "filter"]` + common.

- [ ] **Step 10: `@metaobjectsdev/react`** — `directory: "client/web/packages/react"`, `keywords: ["metaobjects", "react", "react-hook-form", "forms", "currency-input"]` + common.

- [ ] **Step 11: `@metaobjectsdev/tanstack`** — `directory: "client/web/packages/tanstack"`, `keywords: ["metaobjects", "tanstack", "react-query", "react-table", "entity-grid"]` + common.

- [ ] **Step 12: Validate every package.json parses.**

```
cd <repo-root>
for f in server/typescript/packages/{metadata,codegen-ts,codegen-ts-react,codegen-ts-tanstack,runtime-ts,migrate-ts,sdk,cli}/package.json client/web/packages/{runtime-web,react,tanstack}/package.json; do
  bun -e "JSON.parse(require('fs').readFileSync('$f','utf8')); console.log('ok: $f')" || echo "PARSE FAIL: $f"
done
```
Expected: 11 `ok:` lines, no PARSE FAIL.

- [ ] **Step 13: Reinstall + test.**

```
cd server/typescript && bun install 2>&1 | tail -3 && bun test 2>&1 | tail -3
```
Expected: clean install, `2105 pass / 0 fail`.

- [ ] **Step 14: Commit.**

```
cd <repo-root>
git add -A
git commit -m "chore(release): add npm publish metadata to all publish-candidate packages"
```

---

## Task 5: Write the four missing READMEs

**Files:**
- Create: `server/typescript/packages/metadata/README.md`
- Create: `server/typescript/packages/codegen-ts-react/README.md`
- Create: `server/typescript/packages/codegen-ts-tanstack/README.md`
- Create: `server/typescript/packages/sdk/README.md`

- [ ] **Step 1: `metadata/README.md`:**

```markdown
# @metaobjectsdev/metadata

The metamodel loader, typed views, and constants for the MetaObjects standard. This is the foundation package every other `@metaobjectsdev/*` package builds on — it parses `metaobjects/*.json` files into a typed object model, resolves `extends` and overlay merging, and exposes the 11-type vocabulary as named constants.

## Install

\`\`\`bash
pnpm add @metaobjectsdev/metadata
\`\`\`

## Usage

\`\`\`ts
import { MetaDataLoader, InMemorySource } from "@metaobjectsdev/metadata";

const json = `{ "metadata.root": { "package": "demo", "children": [] } }`;
const result = await new MetaDataLoader().load([new InMemorySource(json)]);
\`\`\`

(The public loader API is `MetaDataLoader` + `InMemorySource` — verified against `src/index.ts`. A `MetaDataLoader` instance is single-use; construct a new one per load.)

## Links

- [Spec](https://github.com/metaobjectsdev/metaobjects/tree/main/spec)
- [Metamodel reference](https://github.com/metaobjectsdev/metaobjects/blob/main/spec/metamodel.md)

## License

Apache 2.0 — see [LICENSE](../../../../LICENSE) at the repo root.
```

- [ ] **Step 2: `codegen-ts-react/README.md`:**

```markdown
# @metaobjectsdev/codegen-ts-react

React codegen for MetaObjects. Provides the `formFile()` generator, which emits a per-entity `<Entity>.form.tsx` using `react-hook-form` and the `useEntityForm` / `<CurrencyInput>` helpers from `@metaobjectsdev/react`.

## Install

\`\`\`bash
pnpm add -D @metaobjectsdev/codegen-ts-react
\`\`\`

## Usage

In your `metaobjects.config.ts`:

\`\`\`ts
import { defineConfig } from "@metaobjectsdev/cli";
import { formFile } from "@metaobjectsdev/codegen-ts-react";

export default defineConfig({
  generators: [formFile()],
});
\`\`\`

## Pairs with

- Runtime: [`@metaobjectsdev/react`](../../../../client/web/packages/react) — the generated forms import from here.

## Links

- [Spec](https://github.com/metaobjectsdev/metaobjects/tree/main/spec)

## License

Apache 2.0 — see [LICENSE](../../../../LICENSE) at the repo root.
```

- [ ] **Step 3: `codegen-ts-tanstack/README.md`:**

```markdown
# @metaobjectsdev/codegen-ts-tanstack

TanStack codegen for MetaObjects. Provides `tanstackQuery()` (per-entity `<Entity>.hooks.ts` — 5 React Query hooks), `tanstackGrid()` (`<Entity>.columns.tsx` for `@tanstack/react-table`), and `tanstackGridHook()`.

## Install

\`\`\`bash
pnpm add -D @metaobjectsdev/codegen-ts-tanstack
\`\`\`

## Usage

In your `metaobjects.config.ts`:

\`\`\`ts
import { defineConfig } from "@metaobjectsdev/cli";
import { tanstackQuery, tanstackGrid } from "@metaobjectsdev/codegen-ts-tanstack";

export default defineConfig({
  generators: [tanstackQuery(), tanstackGrid()],
});
\`\`\`

## Pairs with

- Runtime: [`@metaobjectsdev/tanstack`](../../../../client/web/packages/tanstack) — generated hooks and columns import from here.

## Links

- [Spec](https://github.com/metaobjectsdev/metaobjects/tree/main/spec)

## License

Apache 2.0 — see [LICENSE](../../../../LICENSE) at the repo root.
```

- [ ] **Step 4: `sdk/README.md`:**

```markdown
# @metaobjectsdev/sdk

Programmatic SDK for MetaObjects: workspace memory records, path resolution, project config loading, and the agent-docs reference content. Consumed by the `meta` CLI and by AI-collaboration tooling (MCP exposers, codegen prompts).

## Install

\`\`\`bash
pnpm add @metaobjectsdev/sdk
\`\`\`

## Usage

\`\`\`ts
import { resolveMetaRoot, loadConfig } from "@metaobjectsdev/sdk";

const metaRoot = await resolveMetaRoot(process.cwd());
const config = await loadConfig(metaRoot);
\`\`\`

The canonical agent reference docs (scaffolded by \`meta init\`) are available via a sub-path:

\`\`\`ts
import { AGENT_DOCS_BODY, withContentHash } from "@metaobjectsdev/sdk/agent-docs";
\`\`\`

## Links

- [Spec](https://github.com/metaobjectsdev/metaobjects/tree/main/spec)

## License

Apache 2.0 — see [LICENSE](../../../../LICENSE) at the repo root.
```

- [ ] **Step 5: Consistency-pass existing READMEs.**

Open each of `codegen-ts/README.md`, `runtime-ts/README.md`, `migrate-ts/README.md`, `cli/README.md`, `runtime-web/README.md`, `react/README.md`, `tanstack/README.md`. Verify each has: a one-line description, an Install section, and a Links/License pointer. If any is missing all three, add them. **Do not rewrite adequate READMEs.**

- [ ] **Step 6: Commit.**

```
cd <repo-root>
git add -A
git commit -m "docs(packages): add READMEs for metadata, codegen-ts-react, codegen-ts-tanstack, sdk"
```

---

## Task 6: Fix the conformance CI workflow

**Files:**
- Modify: `.github/workflows/conformance.yml`

- [ ] **Step 1: Update all stale paths.**

In `.github/workflows/conformance.yml`, replace every occurrence of the pre-FR-002 path prefix:

```
cd typescript            → cd server/typescript
cd typescript/packages/  → cd server/typescript/packages/
```

There are four references: three `cd typescript && bun install` (one per job) and one each for `packages/conformance` (fixture-lint job) and `packages/metadata` (conformance job). Verify with:

```
cd <repo-root>
grep -n "cd typescript" .github/workflows/conformance.yml
```
Expected after edit: empty (no bare `cd typescript`; all are `cd server/typescript`).

- [ ] **Step 2: Commit.**

```
git add .github/workflows/conformance.yml
git commit -m "ci: fix conformance workflow paths after FR-002 server/ move"
```

---

## Task 7: Final verification

- [ ] **Step 1: Clean install + full build.**

```
cd <repo-root>/server/typescript
rm -rf node_modules && bun install
bun run --filter '*' build 2>&1 | tail -20
```
Expected: every package builds; no errors. Each publish-candidate produces a `dist/` with `.js` + `.d.ts`.

- [ ] **Step 2: Verify dist outputs exist for publish-candidates.**

```
cd <repo-root>
for p in server/typescript/packages/{metadata,codegen-ts,codegen-ts-react,codegen-ts-tanstack,runtime-ts,migrate-ts,sdk,cli} client/web/packages/{runtime-web,react,tanstack}; do
  test -f "$p/dist/index.js" && echo "ok: $p/dist/index.js" || echo "MISSING dist: $p"
done
```
Expected: 11 `ok:` lines. (cli's entry is `dist/src/index.js` — adjust the check for cli, or confirm cli's `main` path resolves.)

- [ ] **Step 3: Full test + typecheck.**

```
cd server/typescript && bun test 2>&1 | tail -3 && bun run --filter '*' typecheck 2>&1 | tail -5
```
Expected: `2105 pass / 0 fail`, typecheck clean.

- [ ] **Step 4: Client/web tests.**

```
for p in <repo-root>/client/web/packages/{runtime-web,react,tanstack}; do echo "=== $p ==="; (cd "$p" && bun test 2>&1 | tail -3); done
```
Expected: runtime-web 30, react 12, tanstack 29 — all 0 fail.

- [ ] **Step 5: Assert no forge references in publish-candidates.**

```
cd <repo-root>
grep -rn "@metaobjectsdev/forge" \
  server/typescript/packages/{metadata,codegen-ts,codegen-ts-react,codegen-ts-tanstack,runtime-ts,migrate-ts,sdk,cli}/ \
  client/web/packages/ 2>/dev/null | grep -v node_modules | grep -v dist
```
Expected: empty.

- [ ] **Step 6: Assert version unification.**

```
for p in server/typescript/package.json server/typescript/packages/{metadata,codegen-ts,codegen-ts-react,codegen-ts-tanstack,runtime-ts,migrate-ts,sdk,cli}/package.json client/web/packages/{runtime-web,react,tanstack}/package.json; do
  grep -m1 '"version"' "$p" | grep -q '0.5.0' && echo "ok: $p" || echo "WRONG VERSION: $p"
done
```
Expected: 12 `ok:` lines.

- [ ] **Step 7: npm scope availability check (operational, non-blocking).**

```
npm view @metaobjectsdev/metadata version 2>&1 | head -3
```
Expected: a 404 / "not found" (scope is unclaimed/available) OR an existing version (someone has it — flag to the user immediately, this changes H7c). Record the result.

- [ ] **Step 8: Push the branch.**

```
cd <repo-root>
git push -u origin feat/h7a-pre-publish-hygiene
```
Confirm the conformance CI workflow runs green on the pushed branch (check `gh run list --branch feat/h7a-pre-publish-hygiene`).

- [ ] **Step 9: Report completion.** Summarize: versions unified, forge decoupled, metadata + READMEs added, CI fixed, npm scope status. Do NOT merge — hand back to the user.

---

## Self-Review Notes

This is mechanical config + docs work, not feature code, so verification is "existing suite stays green + build succeeds" rather than new failing-test-first cycles. The one behavioral change (agent-docs relocation) is covered by the existing `cli/test/unit/init-refresh-docs.test.ts`, which exercises the relocated path end-to-end (Task 2 Step 4).

If `bun run --filter '*' build` surfaces a package that wasn't building before (some packages may only have `typecheck` scripts, not `build`), note it — the publish in H7c requires a real `dist/`, so any package missing a working `build` script is a gap to fix here. Check each publish-candidate has a `"build"` script before relying on Step 1; `codegen-ts` and `cli` use `tsc -p .`, others use `tsc -p tsconfig.json`.

README export names were verified against each package's `src/index.ts` while writing this plan: metadata uses `MetaDataLoader` + `InMemorySource` (not a `loadMetadata` fn); sdk exports `resolveMetaRoot` + `loadConfig`; the codegen examples (`formFile`, `tanstackQuery`, `tanstackGrid`) match the package barrels confirmed during FR-002 Phase 2. The examples in Task 5 are ready to ship as written.

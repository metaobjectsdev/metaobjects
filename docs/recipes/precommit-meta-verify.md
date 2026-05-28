# Pre-commit `meta verify`

Run `meta verify` locally before each commit so metadata-vs-code drift is caught
on your laptop in seconds, not on CI in minutes. Pairs with
[`metaobjectsdev/meta-verify-action`](https://github.com/metaobjectsdev/meta-verify-action)
on the CI side — same command, same exit codes, same drift report.

> **Why bother if CI already catches it?** Pre-commit catches drift before the
> push, which means: no failed-CI noise on PRs, no `fix typo`-style follow-up
> commits to undo bad codegen, and a ~30s feedback loop instead of a ~2-minute
> CI round-trip. The CI gate is still the source of truth — pre-commit is just
> a faster first line of defense.

## TL;DR

```bash
# Whatever hook manager you use, the command is:
npx --no-install meta verify

# Or with a custom templates directory (when templates don't live under ./prompts):
npx --no-install meta verify --prompts data/templates
```

Exit 0 = clean. Non-zero = drift. The drift report goes to stdout — same shape
as the CI action's PR comment.

## Choose your hook manager

The MetaObjects framework is hook-manager-agnostic. Three common setups:

| Manager | Best for | Setup time |
|---|---|---|
| [husky](#husky) | JS/TS projects already using Node tooling | 2 min |
| [lefthook](#lefthook) | Polyglot repos, faster than husky, parallel hooks | 5 min |
| [plain `.git/hooks`](#plain-shell-hook) | Zero dependencies, no install step | 1 min (per dev) |

### husky

Most common choice for a TS-only project. Requires the `husky` dev dependency
and a one-time `prepare` script.

```bash
npm install --save-dev husky
npx husky init
```

Then add to `.husky/pre-commit`:

```bash
#!/usr/bin/env sh
. "$(dirname -- "$0")/_/husky.sh"

npx --no-install meta verify
```

Make it executable: `chmod +x .husky/pre-commit`. Commit the file. Every
contributor who runs `npm install` afterwards gets the hook automatically.

### lefthook

Faster than husky (Go binary, no Node startup) and supports parallel hooks.
Worth the extra config in a busy repo.

```bash
npm install --save-dev lefthook
npx lefthook install
```

`lefthook.yml`:

```yaml
pre-commit:
  parallel: true
  commands:
    meta-verify:
      run: npx --no-install meta verify
```

For a project with a non-default templates directory:

```yaml
pre-commit:
  parallel: true
  commands:
    meta-verify:
      run: npx --no-install meta verify --prompts data/templates
```

### Plain shell hook

Zero dependencies. Each contributor installs once after cloning. Not portable
across machines via the repo — but useful as a fallback or for a project that
doesn't want a hook-manager dep.

Create `.git/hooks/pre-commit`:

```bash
#!/usr/bin/env bash
set -e
exec npx --no-install meta verify
```

Make it executable: `chmod +x .git/hooks/pre-commit`. Done.

To share across the team without a hook-manager, commit the script to
`.githooks/pre-commit` and have contributors run once:

```bash
git config core.hooksPath .githooks
```

## What the hook catches

Same contract as `meta verify` everywhere — metadata declarations vs.

- **Generated code** in your `src/**/generated/` output. Edit a field name in
  the YAML, forget to `meta gen`, the hook fails.
- **Live database schema** (if `DATABASE_URL` is set). Add a column to the
  YAML, forget to write the migration, the hook fails.
- **Prompt templates** (`template.prompt`) vs. the `@payloadRef`-bound
  `object.value`. Reference `{{undefinedField}}`, the hook fails.
- **Output parsers** (`template.output`) vs. their target payload shapes.

## Fixing drift when the hook fires

```
$ git commit -m "feat: add a field to FooPayload"

ERR_VAR_NOT_ON_PAYLOAD  templates/foo-user.mustache:8
  {{#items.length}}  →  `items.length` not on FooPayload field tree
```

Fix path:

1. Run your project's regen command (`npm run gen:db`, `meta gen`, etc.)
2. Stage the regenerated files (`git add src/**/generated/`)
3. Re-run the commit. If the regen produced clean output, the hook passes.

If the failure is a template referencing a field that genuinely doesn't exist
on the payload — that's a real bug. Fix the template (or add the field to the
payload's metadata YAML), regen, re-commit.

## Performance

`meta verify` reads metadata + generated source + (optional) DB schema. On a
typical project (≤50 entities, ≤30 templates) it runs in well under a second.
It will not slow down `git commit` perceptibly.

If you do find it slow, two knobs:

- **Skip the DB check** — leave `DATABASE_URL` unset locally. The hook still
  catches code/template drift, which is 95% of what bites you.
- **Scope to staged paths** — `meta verify` is whole-project by design (drift
  in one file can be caused by a change in another), but if you have a very
  large repo you can pre-filter via `git diff --cached --name-only` and skip
  the hook entirely when no metadata or generated file is staged. This is an
  escape hatch — most projects won't need it.

## Skipping the hook

Standard git escape hatches work:

```bash
git commit --no-verify -m "wip: temporarily skip the gate"
```

Use sparingly. If you find yourself skipping it routinely, the hook is wrong
— file an issue.

## See also

- [`metaobjectsdev/meta-verify-action`](https://github.com/metaobjectsdev/meta-verify-action) — the CI counterpart
- [`@metaobjectsdev/cli`](https://www.npmjs.com/package/@metaobjectsdev/cli) — the underlying `meta verify` command
- [Drift contract feature doc](../features/) — what counts as drift and why

# Check an API change against the last release

Find out in CI whether a change to the model breaks consumers of your API, before they do. Emit the
OpenAPI document at your last release tag and at `HEAD`, then let
[oasdiff](https://github.com/oasdiff/oasdiff) compare them. No MetaObjects flag is involved: the
generator writes a standard document, and oasdiff reads it like any other.

You need the [`openapi` generator](../features/contract-emitters.md) in your config, and oasdiff on
the machine or through its image, `tufin/oasdiff`.

## The check

```bash
#!/usr/bin/env bash
# scripts/check-api-compat.sh
set -euo pipefail

DOCUMENT=generated/openapi.json          # your outDir, plus openapi.json
LAST_TAG=$(git describe --tags --abbrev=0)

BASE=$(mktemp -d)
trap 'git worktree remove --force "$BASE"' EXIT
git worktree add --detach "$BASE" "$LAST_TAG"

( cd "$BASE" && npm ci && npx meta gen --generators openapi )
npx meta gen --generators openapi

oasdiff breaking "$BASE/$DOCUMENT" "$DOCUMENT" --fail-on WARN
```

`meta gen --generators openapi` runs only that entry of your config. Both sides are generated, not
read from git, so the comparison holds even if someone committed a stale file. If you commit the
document and trust `meta verify --codegen` to keep it current, the worktree is unnecessary:

```bash
git show "$LAST_TAG:$DOCUMENT" > "$BASE/openapi.json"
oasdiff breaking "$BASE/openapi.json" "$DOCUMENT" --fail-on WARN
```

If the last tag predates the generator, the first form fails at that tag. Use the second form once
the document is committed, starting from the first tag that holds it.

## Why `--fail-on WARN`

oasdiff grades a removed query parameter as a warning, because most APIs ignore a parameter they do
not know. The generated routes do not: an unknown filter or sort field answers
`400`, so a consumer that sends it breaks. `--fail-on ERR` would pass that change.

## What it reports

| Change to the model | oasdiff | Why |
|---|---|---|
| Add an optional field | passes | A read gains a key, and a write gains an optional one |
| Remove a field | fails | A consumer reading it finds nothing |
| Add a `@required` field | fails | Each existing create is now refused |
| Tighten `@maxLength` or a validator | fails | A request that was valid is now refused |
| Remove `@filterable` | fails | The `filter[...]` parameters are gone, and sending one is a 400 |
| Add a new entity | passes | New paths break nobody |

A decimal's form and a value object's null members are part of the contract too, so changing `wire`
in `.metaobjects/config.json` shows as a schema change. Fix them before you publish:
[Set the wire form](../features/contract-emitters.md#set-the-wire-form-if-you-publish-a-contract).

## In CI

```yaml
- uses: actions/checkout@v4
  with: { fetch-depth: 0 }                 # tags and history for git describe
- run: npm ci
- run: curl -fsSL https://raw.githubusercontent.com/oasdiff/oasdiff/main/install.sh | sh
- run: scripts/check-api-compat.sh
```

Pin oasdiff to a version you have tried. New releases add checks, so a build can go red on a change
that was passing before.

To accept a break on purpose, release it as one: a new major version of your API, with the tag that
moves the baseline. oasdiff also has an `--err-ignore` file for a single known change.

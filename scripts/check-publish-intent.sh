#!/usr/bin/env bash
# Publish-intent parity: every non-private workspace package must have a DECLARED
# publish intent — either it rides the lockstep version, or it is explicitly listed
# here as source-only.
#
# Why this exists. `docs/RELEASING.md` defines the lockstep set as "every non-private
# package at the previous version". `@metaobjectsdev/angular` and
# `@metaobjectsdev/codegen-ts-angular` are non-private but sit on their own `0.6.x`
# line, so they match neither branch of that rule and silently fell out of EVERY
# release — they have never been published at all. Meanwhile README.md, CLAUDE.md,
# docs/ports/{typescript-client,java,kotlin,csharp}.md and a whole
# docs/recipes/csharp-angular18.md walkthrough described them as installable, so an
# adopter following the recipe hit a 404 on the first command. Nothing could catch
# that, because "was this package ever published?" was not written down anywhere in
# the repo — it lived only in the registry.
#
# So: the intent is declared here, offline, and drift fails the build. Adding a new
# non-private package now forces one explicit decision — ship it in lockstep, or
# record it as source-only — instead of letting it fall into the gap in between.
#
# This is deliberately NOT a network check. Asking npm "is it published?" would be
# flakier, slower, and would still not tell you what SHOULD be true.
set -euo pipefail

cd "$(dirname "$0")/.."

# Packages that are non-private but deliberately NOT published. Keep the reason with
# the entry: a bare list rots into "nobody remembers why".
#
#   @metaobjectsdev/angular / codegen-ts-angular — the Angular 18 browser tier.
#   Source-only BY DECISION (ADR-0048, spec/decisions/): below the published tier's
#   bar (grid/form parity, a runner for its behavioral suite, TPH + meta-descriptor
#   codegen). The ADR carries the promotion checklist; when it is met, remove both
#   from this list, bump them to lockstep, and flip the docs it enumerates.
SOURCE_ONLY=(
  "@metaobjectsdev/angular"
  "@metaobjectsdev/codegen-ts-angular"
)

is_source_only() {
  local name="$1"
  for s in "${SOURCE_ONLY[@]}"; do [ "$s" = "$name" ] && return 0; done
  return 1
}

# The lockstep version is whatever the CLI (always published, always in the set) is at.
LOCKSTEP=$(node -p "require('./server/typescript/packages/cli/package.json').version")

fail=0
for f in server/typescript/packages/*/package.json client/web/packages/*/package.json; do
  read -r name version private < <(node -e '
    const p = require("./" + process.argv[1]);
    console.log(p.name, p.version, p.private === true ? "private" : "public");
  ' "$f")
  [ "$private" = "private" ] && continue

  if is_source_only "$name"; then
    if [ "$version" = "$LOCKSTEP" ]; then
      echo "✖ $name is listed SOURCE-ONLY but sits at the lockstep version $LOCKSTEP." >&2
      echo "  If it is now being published, remove it from SOURCE_ONLY in $0 and from" >&2
      echo "  the 'not published' notes in README.md / CLAUDE.md / docs/." >&2
      fail=1
    fi
    continue
  fi

  if [ "$version" != "$LOCKSTEP" ]; then
    echo "✖ $name is at $version but the lockstep version is $LOCKSTEP." >&2
    echo "  A non-private package off the lockstep line matches neither branch of the" >&2
    echo "  RELEASING.md publish rule, so it will be silently skipped by every release." >&2
    echo "  Decide explicitly: bump it into lockstep, mark it private, or add it to" >&2
    echo "  SOURCE_ONLY in $0 with a reason." >&2
    fail=1
  fi
done

if [ "$fail" -ne 0 ]; then
  echo "" >&2
  echo "publish-intent parity FAILED (lockstep = $LOCKSTEP)" >&2
  exit 1
fi

echo "publish-intent parity: OK (lockstep $LOCKSTEP; ${#SOURCE_ONLY[@]} declared source-only)"

#!/usr/bin/env bash
# A comment that names a test file by NAME must name a file that exists.
#
# Several load-bearing comments in this repo delegate a guarantee to a test in ANOTHER
# package — "the two are now compared by codegen-ts's `secondary-index-name-parity.test.ts`
# rather than by a claim in a comment" — which is exactly the right thing to write, because
# it replaces an assertion a reader has to trust with one they can go run.
#
# The coupling is a bare filename across a package boundary, so nothing connects the two.
# Rename or delete the test and every reference to it keeps reading as a live guarantee
# while pointing at nothing, which is strictly worse than never having made the promise:
# the comment still tells the next reader the case is covered.
#
# The check is deliberately narrow. It looks only at BACKTICKED `<name>.test.ts` mentions —
# the convention these comments already use — so ordinary prose about testing cannot trip
# it, and it resolves by BASENAME anywhere under the TS tree rather than by path, so moving
# a test between directories (which breaks no promise) does not fail it. Renaming one does.
set -euo pipefail
cd "$(dirname "$0")/.."

fail=0
# The pathspecs are SHELL globs, deliberately unquoted. Quoting them hands git a literal
# `*` pathspec, which matches nothing here and yields an empty result — and because git grep
# exits 1 on no matches, under `set -euo pipefail` that aborted the assignment and the whole
# script exited 1 having printed NOTHING. A check that fails silently and a check that passes
# are equally useless; `|| true` keeps "no references at all" a legitimate, reported outcome.
refs=$(git grep -ohE '`[a-zA-Z0-9._-]+\.test\.ts`' -- \
         server/typescript/packages/*/src server/typescript/packages/*/test 2>/dev/null \
       | tr -d '`' | sort -u || true)

count=0
while read -r f; do
  [ -z "$f" ] && continue
  count=$((count + 1))
  if [ -z "$(find server/typescript -name "$f" -print -quit)" ]; then
    fail=1
    printf '  ✖ a comment names `%s`, and no such file exists.\n' "$f" >&2
    printf '    Referenced from:\n' >&2
    git grep -n -- "$f" -- server/typescript/packages/*/src server/typescript/packages/*/test \
      | sed 's/^/      /' >&2 || true
    printf '    Restore the name, or update every reference — a comment that delegates a\n' >&2
    printf '    guarantee to a file that is gone still reads as a guarantee.\n' >&2
  fi
done <<< "$refs"

if [ "$fail" -ne 0 ]; then exit 1; fi
echo "test-file references: $count named, all resolve"

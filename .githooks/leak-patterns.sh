# Shared leak-scan patterns, sourced by .githooks/pre-commit, .githooks/identity-scan.sh and
# .githooks/leak-scan.sh so the local hooks and the hosted `leak-scan` status can never disagree
# about what a leak is.
# Names NO private project; private names come only from the untracked denylist.
#
# /Users/ is the macOS home shape. It was missing from leak-scan.sh until a rename-with-edits
# slipped past both (audit finding 12).

# Generic, non-sensitive structural patterns (safe to commit):
LEAK_PATTERNS='/home/[A-Za-z0-9._-]+/|/Users/[A-Za-z0-9._-]+/|~/Development'

# Legitimate matches to ignore. The maintainer's email. Content scans drop it from added lines;
# identity-scan.sh strips it before matching the author/committer identity, so the maintainer's
# own commits pass a denylist that names the maintainer. (The npm manifests no longer carry it,
# since 1.3.0 — author "MetaObjects contributors" — so that was its original reason.)
LEAK_ALLOW='doug@dougmealing\.com'

# Diff filter: Added, Copied, Modified and Renamed (a `git mv` plus an edit is a rename).
LEAK_DIFF_FILTER='ACMR'

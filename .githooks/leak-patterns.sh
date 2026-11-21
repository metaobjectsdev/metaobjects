# Shared leak-scan patterns, sourced by .githooks/pre-commit, .githooks/identity-scan.sh and
# .githooks/leak-scan.sh so the local hooks and the hosted `leak-scan` status can never disagree
# about what a leak is.
# Names NO private project; private names come only from the untracked denylist.
#
# /Users/ is the macOS home shape. It was missing from leak-scan.sh until a rename-with-edits
# slipped past both (audit finding 12).

# Generic, non-sensitive structural patterns (safe to commit):
LEAK_PATTERNS='/home/[A-Za-z0-9._-]+/|/Users/[A-Za-z0-9._-]+/|~/Development'

# Diff filter: Added, Copied, Modified and Renamed (a `git mv` plus an edit is a rename).
LEAK_DIFF_FILTER='ACMR'

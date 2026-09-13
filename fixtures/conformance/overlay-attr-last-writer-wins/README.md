# overlay-attr-last-writer-wins

A second file re-opens `acme::Product` with `overlay: true` and sets `@title` to a
different value. **Last writer wins, and there is NO error.**

## Why no error

`overlay: true` **licenses** the override (FR-043 Amendment 2). The `ERR_MERGE_CONFLICT`
this fixture used to expect exists to catch two files that collided *without knowing
about each other*; the flag is the author saying "I know about the other declaration and
I mean to change it". The loader already treats it specially — `overlay: true` is
find-or-throw, a plain redeclaration is create-or-find — so honouring it here makes it
mean one coherent thing rather than two.

The accident case did NOT stop being an error, it MOVED: see
[`merge-conflict-unmarked-attr-redeclaration`](../merge-conflict-unmarked-attr-redeclaration/),
which is the identical collision with neither file marked. The two are a pair and should
be read together — flipping this fixture without adding that one would have deleted the
only coverage of the case FR5c was written for.

| fixture | overlay marked? | verdict |
|---|---|---|
| this one | yes | no error — the override is licensed |
| `merge-conflict-unmarked-attr-redeclaration` | no | `ERR_MERGE_CONFLICT` |

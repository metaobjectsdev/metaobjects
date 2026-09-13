# overlay-nested-requirement

An adopter overlays a library requirement nested three deep — the `requirement.*` node
is not a root child, so addressing it means re-declaring its ancestors — and changes
`@status` while adding `@disposition` and `@notes`.

**The tree merges correctly and the load is clean: right shape, no duplicates, the
adopter's values applied, zero errors.**

This is the case FR-043 §5.5 rests on. Without it, an adopter could not disagree with a
library's requirement without ejecting the whole ledger, and the adaptation door §5.5
describes would collapse to eject-only.

## Two things it pins that are easy to get wrong

1. **Every ancestor in the chain carries `overlay: true`, not just the leaf.** Left
   plain, each ancestor is a same-shape redeclaration and emits
   `WARN_DUPLICATE_DECLARATION` — three warnings to change one leaf in a depth-4 tree.
   Marked, the load is silent. (`overlay-nested-under-plain-parent-base-later` uses the
   unmarked shape deliberately, to pin what that costs.)
2. **Changing `@status` is an OVERRIDE, and it does not error.** It used to: FR5c's
   `ERR_MERGE_CONFLICT` fired even under an explicit `overlay: true`, which made the one
   move §5.5 asks an adopter to make look like a defect. FR-043 Amendment 2 ruled the
   flag licenses the override. Adding an attribute the base never set (`@disposition`,
   `@notes` here) was always clean; now retuning one is too. See
   [`overlay-attr-last-writer-wins`](../overlay-attr-last-writer-wins/) and its unmarked
   pair.

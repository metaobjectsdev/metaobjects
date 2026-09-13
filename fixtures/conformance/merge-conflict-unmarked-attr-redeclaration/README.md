# merge-conflict-unmarked-attr-redeclaration

Two files declare the same `(type, package::name)` and set the same attribute to
different values. Neither marks itself `overlay: true`. **`ERR_MERGE_CONFLICT`.**

This is FR5c's original case: two files that collided **without knowing about each
other**. The value still merges last-writer-wins so the loader sees one canonical tree;
the error is what tells a consumer the collision happened.

## Why this fixture exists

It took over the error branch from `overlay-attr-last-writer-wins`, which used to prove
the same thing — with an overlay that DID mark itself. FR-043 Amendment 2 ruled that
`overlay: true` **licenses** the override: the flag is the author saying "I know about
the other declaration and I mean to change it", and the loader already treats it
specially (find-or-throw versus create-or-find), so honouring it here makes it mean one
thing rather than two.

Flipping that fixture alone would have deleted the only coverage of the accident case.
This fixture holds it, so the coverage MOVED rather than disappearing. The two are a
pair and should be read together:

| fixture | overlay marked? | verdict |
|---|---|---|
| `overlay-attr-last-writer-wins` | yes | no error — the override is licensed |
| `merge-conflict-unmarked-attr-redeclaration` | **no** | `ERR_MERGE_CONFLICT` |

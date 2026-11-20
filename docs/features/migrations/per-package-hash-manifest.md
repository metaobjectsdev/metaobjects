# Migration: the hash manifest is one file per package

**Applies to:** every project that commits `.metaobjects/.gen-state/.hashes.json`, in every
port. **Action required:** run `gen` once and commit the result.

## What changed

The manifest that records what `gen` wrote was one file for the whole project, so any two
branches that regenerated anything conflicted on it, even when they touched different
packages. It is now a directory, `.metaobjects/.gen-state/.hashes/`, with one file per model
package:

```
.metaobjects/.gen-state/.hashes/acme.shop.json
.metaobjects/.gen-state/.hashes/acme.crm.json
.metaobjects/.gen-state/.hashes/.root.json     # generated paths in no package
```

A package file is named by the package's `::` segments joined with `.`. A byte outside
`[A-Za-z0-9_-]` is written as `%XX`. Keys are sorted and each file ends with a newline. A
file is placed by the node the entry records, else by the model object its name starts with
(by words: `OrderLine.cs` and `order_line.py` both belong to `OrderLine`), else where it
already was, else in `.root.json`. Two branches that change generated files in different
packages now change different files, and merge without a conflict.

## What you do

1. Upgrade, then run your usual `gen` (`meta gen`, `dotnet meta gen`, `mvn
   metaobjects:generate`, `metaobjects gen` or `cargo meta gen`). It reads the old file,
   writes the package files, deletes `.hashes.json`, and adds `!.gen-state/.hashes/` to
   `.metaobjects/.gitignore` when that file ignores `.gen-state/*`.
2. Commit the new directory and the deleted file.

If your ignore rules live elsewhere (a root `.gitignore` that excludes
`.metaobjects/.gen-state/`), un-ignore `.gen-state/.hashes/` the way you un-ignored the old
file. `meta verify` names the rule that is in force.

A script that read `.hashes.json` directly should read every `*.json` in the directory and
merge them. A path appears in exactly one file, and readers find it wherever it is, so a
misplaced entry costs a merge conflict and nothing else.

A run that only verifies (`verify --codegen`) never converts the manifest; the first `gen`
does.

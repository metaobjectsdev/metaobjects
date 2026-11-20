# ADR-0064: `gen` skips rendering when the loaded model and its generators are unchanged

## Status

**Accepted** (2026-11-14), for the 1.2.x line (numbered ADR-0062 there), forward-ported to the 1.3.0 line on 2026-11-15 with this number because ADR-0062 and ADR-0063 are taken on `main`, in all five ports (TypeScript, Python, C#, Java
and Kotlin). Registers no vocabulary: `metamodelVersion` is unchanged. It changes what `gen` and
a local `verify --codegen` do when nothing changed.

## Context

No port skipped any work when nothing changed. Every run loaded the metadata, rendered every
file, formatted where the port formats, and only then compared each file with what was on disk.
A no-change `meta gen` on a small project cost the same as a first run (0.92 to 0.98 s), and a
Maven build spent about 5 s in `metaobjects:generate` on every build, changed or not.

Two defects made the no-change run worse than a first run:

- Python and C# rewrote the committed hash manifest (`.metaobjects/.gen-state/.hashes.json`)
  once per generated file, even when no file changed. TypeScript rewrote it once per written
  file. At 1,160 objects that per-file rewrite was 136 s of a 165 s TypeScript run. Java and
  Kotlin already loaded it once and saved it once, and only when something changed.
- A file whose fresh bytes equal what is on disk must never be rewritten: a rewrite moves its
  timestamp, and every build tool downstream then recompiles it.

The question this ADR answers is how to skip codegen **without generating anything**: comparing
rendered output with disk still renders every file, so it is not a skip.

## Decision

### 1. The manifest is written once per run, and only when it changed

Every port loads `.hashes.json` once at the start of a run, updates it in memory, and saves it
once at the end, only when an entry was added, changed or removed. Its bytes stay as they are
today (sorted keys, two-space indentation, trailing newline, owner fields kept), so this changes
no committed file. A run that changes nothing leaves the manifest's timestamp alone.

### 2. Identical bytes are never rewritten

A generated file whose fresh content equals what is on disk is left untouched in every port,
whatever the manifest or snapshot says: its record is confirmed in memory and it reports
`unchanged`. Its timestamp stays, so a build tool sees nothing changed.

### 3. The skip key is built from the loaded model, not from source files

A run is keyed on what its generators are built from, computed after the metadata loads and
before anything renders:

- **The model.** Each loaded root-level node (an object, a shared field, a template node) is
  hashed in its canonical *effective* form, using the port's existing canonical serializer:
  `extends` and overlays applied, attributes in fixed order, no source positions. Node hashes
  roll up into a hash per package and one for the model. So a metadata file that is reformatted,
  reordered, or split into two files without changing what loads does not change the key, and an
  edit to an abstract parent changes the key of every object that inherits from it.
- **The generators.** A generator's identity is the hash of its built code, not only the release
  version (a linked or locally built engine changes with its content), plus its templates,
  partials, helpers and options: in practice the engine package and its MetaObjects
  dependencies, the port's codegen config and every owned generator file it reaches, and the
  template roots. A generator that reads anything else declares it as an extra input; one that
  cannot declare its inputs is marked not cacheable (`cache: false` in TypeScript, the port's
  equivalent elsewhere), and a run that includes it never skips.
- **The run.** The project config (`.metaobjects/config.json`) and every flag that changes
  output: generator selection, strict mode, the baseline mode.

`gen` skips rendering when the model hash and every generator identity match the last
successful run's, and every file the manifest records still exists with the bytes that run left
on disk (the stored key records them). It still loads the metadata (that is what the key is made
of) and reads the generated files; it renders nothing and writes nothing, the manifest and the
stored key included. A generated file edited by hand after the last run therefore makes `gen`
render, so it puts the file back or merges the edit, exactly as `verify` tells the user it will;
an edit the last run already merged and kept is unchanged since, and does not. A run that names entities (`meta gen A B`, `--entities`, `-Dmeta.entities`) forces exactly those
entities: it never skips, never stores a key, and leaves the stored full-run key as it found it, so
it can neither write nor satisfy the key of a full run. The rule the key keeps: **it may be wrong only in the safe direction.** An input
it over-counts causes an extra render; an input it misses would cause a wrong skip, so anything
in doubt is counted. Timestamps are never an input.

The stored key lives in `.metaobjects/.gen-state/.fingerprint-<port>.json` (on the JVM,
one per owner module: `.fingerprint-java-<owner>.json`), which is not committed
(`.gen-state/*` is ignored except `.hashes.json`). A run deletes it before it writes
anything and stores the new one only after it succeeds with every generator cacheable, so a
failed or half-written run is never mistaken for a current one. The full run comes back with
`meta gen --force` (TypeScript), `metaobjects gen --force` (Python), `dotnet meta gen --force`
(C#) and `-Dmetaobjects.force=true` or `<force>true</force>` (Java and Kotlin).

### 4. `verify --codegen` renders in CI and before a PR

In CI (`CI` set to anything but empty, `0` or `false`) `verify --codegen` always renders and
compares everything, whatever the stored key says. Locally it may answer "no drift" without
rendering when the key matches **and** every file the manifest records still hashes to its
record; `--full` (`-Dmetaobjects.verify.full=true` on the JVM) makes it render. A file holding a
kept hand edit no longer matches its record, so `verify` renders for it and classifies it, while
`gen` skips over it.

When `verify --codegen` renders, it compares the rendered bytes with disk in memory, in every
port: no rendered temp tree is written.

### 5. One table of cases, run by every port

`fixtures/codegen-skip-conformance/cases.json` lists the changes that must make `gen` render
and those that may let it skip, with what a local `verify` may do after each. Every port runs
every case against a project of its own shape and fails on a case id it does not know.

### 6. Per-object and per-package keys come next

This is the whole-run level. The model hash is a tree (node, package, model) and the generator
identity is a set of named entries, so the next step can key one generator over one object or
one package by reusing the same nodes. Two units claiming one output path already fail the run,
and the manifest is keyed by output path, so per-unit records will not collide.

## Consequences

- A no-change `gen` costs a process start, the metadata load and hashing (the model, the
  generator inputs and the generated files), in every port: no render, no format, no write.
- A run that does render writes no file whose bytes are unchanged and writes the manifest at
  most once, so a build tool downstream sees only real changes, and a large model no longer pays
  one manifest write per file.
- TypeScript runs `git merge-file` only for a file edited by hand since it was generated, never
  for an untouched one, and deletes its two temporary inputs in a `finally`, under `$DEV_SCRATCH`
  when that is set.
- `gen` in Python no longer reports an unchanged file as written.
- A generator that reads something it did not declare could make a skip wrong. The defenses are
  the declared extras, `cache: false`, `--force`, and CI's full `verify --codegen`.
- Nothing changes for an adopter who never runs `gen` twice without a change in between.

## Amendment 1 (2026-11-20): the hash manifest is one file per package

Registers no vocabulary: `metamodelVersion` is unchanged. For 1.3.0, in every port that keeps hash
state (TypeScript, Python, C#, Java and Kotlin, and Rust in preview). This is the "per-package keys
come next" step of §6, applied to the one file every generated path is recorded in.

### Context

The committed manifest, `.metaobjects/.gen-state/.hashes.json`, is one file for the whole project. Any
two branches that regenerate any file in any package both rewrite it, so they conflict on it even
when they share no generated file, and an adopter with parallel branches cannot validate them side by
side. The file's bytes are already deterministic (sorted keys), so the conflict is not noise from
ordering: it is one file standing for many independent facts.

### Decision

**1. One manifest per model package.** The manifests live in
`.metaobjects/.gen-state/.hashes/` (on the JVM, under the module's basedir like the file they
replace), one JSON file per model package:

- A package file is named for the package: its `::`-separated segments joined with `.`, each segment
  with every byte outside `[A-Za-z0-9_-]` written as `%XX` (uppercase hex of the UTF-8 byte), then
  `.json`. `acme::shop` is `acme.shop.json`. Package segments never contain a `.`, so the name is
  unambiguous.
- A generated path that belongs to no package goes in one root manifest, `.root.json`. A leading dot
  cannot start a package name, so the root cannot collide with a package.
- A file holds exactly what the single manifest held for its paths, unchanged: one JSON object keyed
  by project-relative path, keys sorted, two-space indentation, a trailing newline, each value a
  SHA-256 hex string or an object carrying `hash` and any owner or provenance fields the port keeps
  (`generator` and `outputDir` on the JVM, `generatedBy` and `sourceNode` in TypeScript). Nothing
  about a value changes, so no reader of one entry changes.

**2. Reading is a union.** A reader merges every `*.json` file in `.hashes/`, in file-name order, with
the legacy `.hashes.json` underneath them (a key in a package file wins). An absent, unreadable or
corrupt file reads as empty, which fails closed as before, and is replaced on the next write. "The
project has a manifest" means the legacy file or at least one file in `.hashes/` exists. Which file
an entry was found in is never evidence about the path: a reader asks for a path and gets its
record from wherever it is. This is what makes placement (below) safe to get wrong: a misplaced
entry costs a merge conflict that could have been avoided and nothing else.

**3. Placement is a pure function, so it is stable.** A writer files each entry under:

1. **Its recorded `sourceNode`**, when it has one (TypeScript records it). The package is the
   `sourceNode` up to its first `.`, minus its last `::` segment (`acme::shop::Order.id` files under
   `acme::shop`). A `sourceNode` with no `::` names an object in no package: the root manifest.
2. **Else the object whose name the file's stem begins with, word by word.** The stem is the file's
   base name up to its first `.` (`gen/OrderDto.java` has the stem `OrderDto`). Both the stem and an
   object's name are split into lowercase words: at every `_` and `-`, before an uppercase letter that
   follows a lowercase letter or a digit, and before the last uppercase letter of a run that is
   followed by a lowercase letter (`HTTPServer` is `http` and `server`; `order_line` and `OrderLine`
   are both `order` and `line`; digits stay with the word before them). A loaded root-level object
   matches when its words are the first words of the stem's (`Order` matches `OrderDto`,
   `order_names` and `order-line`, not `Ordered` or `orders`). The matches with the most words win;
   when they are declared in more than one package, or in none, the file has no package.
   Otherwise the matched objects' package is the file's. Matching by words, not by exact spelling, is what lets
   a snake_case port (Python, Rust) and a PascalCase one place a file the same way.
3. **Else where the entry already is**, when the writer has no model (a tool that edits the
   manifest without loading one), and
4. **Else the root manifest.**

Every port implements 1 and 2 as one function over the loaded model and runs it for every entry on
every write, so an entry moves when its object moves package or is renamed, and does not move
otherwise. `fixtures/codegen-skip-conformance/manifests.json` holds the vectors.

**4. A write touches only the files that changed.** A writer computes every manifest's bytes and
writes a file only when they differ from what it read, deletes a package file that no longer holds
an entry, and keeps `.root.json` present (as `{}`) when no entry exists at all, so "no manifest" stays
distinguishable from "an empty one". Within a run each manifest is still written at most once, only
when something changed (§1). So two branches that regenerate files in different packages change
different files, and git merges them with nothing to resolve; only a file recorded in the root
manifest, or one path in one package, can still collide, and those are the files whose own bytes
would collide too.

**5. A legacy manifest is migrated by the next write run.** A run that finds `.hashes.json` reads
it, files every entry by §3, writes the per-package files, deletes `.hashes.json`, and counts as a
run that changed the manifest, so it happens even when no generated file changed. A read-only
command (`verify`) reads the union and migrates nothing. The migration also adds
`!.gen-state/.hashes/` after the `!.gen-state/.hashes.json` line of `.metaobjects/.gitignore` when
that file holds the `.gen-state/*` rule the scaffold writes, because without it git would ignore the
new directory; a project whose rule lives elsewhere gets the existing "manifest is git-ignored"
advisory, now naming `.hashes/`. The adopter commits the result and does nothing else. A branch that
still holds the legacy file merges as an ordinary add/delete; take the migrated side and run `gen`.

**6. Everything that read the manifest reads the union.** The write decision (overwrite, refuse,
merge), the orphan sweep, `verify --codegen`, the explorer's list of generated files and the skip
state (§3's stored-key check, which asks every recorded file whether it still hashes to its record)
go through the one reader, so a run keys on the same set of paths as before. The stored skip key
(`.fingerprint-<port>.json`) is not committed and is unchanged.

### Consequences

- Two branches that change generated files in different packages produce manifests that merge with
  no conflict. The conformance cases and each port's unit tests assert the file-level separation;
  the TypeScript suite proves the merge with git.
- An adopter's first `gen` on 1.3.0 rewrites its manifest into `.hashes/` and removes
  `.hashes.json`. Commit both changes; there is no flag and no second step.
- A file the writer cannot attribute (a barrel, an index, a docs page) is in the root manifest. Those
  files are the ones whose own contents collide when two branches touch them.
- A project that named `.hashes.json` in a script or an ignore rule must name `.hashes/`.

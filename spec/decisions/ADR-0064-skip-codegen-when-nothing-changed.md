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

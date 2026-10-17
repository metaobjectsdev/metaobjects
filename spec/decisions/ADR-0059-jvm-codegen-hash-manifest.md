# ADR-0059: Java and Kotlin codegen decide overwrites from the committed hash manifest

## Status

**Accepted** (2026-10-17), for 1.1.0 (Maven Central 8.1.0). Registers no vocabulary:
`metamodelVersion` stays `1.1`. It changes generated-file handling on the JVM only. TypeScript,
Python and C# already worked this way.

## Context

TypeScript, Python and C# record every file `gen` writes in a committed manifest,
`.metaobjects/.gen-state/.hashes.json`: a project-relative path mapped to the SHA-256 of the
content written. A file that still hashes to its record is generated output and safe to
overwrite. An edited file, or a file with no record, is refused by name.

Java and Kotlin had no manifest. `GeneratedFileWriter` decided from the `GENERATED` token in a
file's header: overwrite a file that carries it, refuse one that does not. That rule failed in
two ways:

1. **A hand edit was overwritten silently.** An edited generated file keeps its header, so the
   one case worth protecting was the one the rule could not see.
2. **A file that was no longer generated stayed forever.** With no record of what a run wrote,
   nothing could tell a stale generated file from someone's own source. The 1.1.0-rc.5 re-check
   found this gap in every port. Renaming a value object left the old file, and the drift gate
   reported it but could not say which files `gen` would delete. Every port now runs an orphan
   sweep that deletes an untouched recorded file no generator emits. The sweep needs the
   manifest as evidence, so the JVM needed one.

The earlier position, recorded in `GeneratedFileWriter`'s javadoc, was that the JVM did not
need edit detection: these ports customize through build configuration and template specs, not
by editing emitted files. That position is still true of how most JVM adopters work. But it
does not cover deletion, and deletion without evidence is not safe on any port.

## Decision

1. **The JVM keeps the same manifest as the other ports.** It is
   `<module basedir>/.metaobjects/.gen-state/.hashes.json`, with project-relative keys and
   SHA-256 hex values, sorted, pretty-printed, with a trailing newline. Two executions in one
   module share the file, and may share an output directory, so each entry the JVM writes
   also names its **owner**, what emitted it: the generator's registry id
   (`<port>:<name>`, or the class name of a generator of your own) and its output
   directory relative to the module basedir,
   `"<path>": { "hash": "<sha-256 hex>", "generator": "java:dto", "outputDir": "target/generated-sources/java" }`.
   The owner names the configuration, not the Maven execution, so `default-cli`, a renamed
   execution and the lifecycle execution with the same configuration agree on it. The
   sweep reads the module's `metaobjects:generate` executions and plugin-level
   configuration from the build model, in the main build and in every profile whether
   active or not, to know every generator/output-directory pair the module configures. A
   pair declared only in a profile that is off for this build is still configured, so its
   files are never treated as stranded. A recorded file is an orphan when no generator emitted it in this
   build and either its owner is one of this run's own generators, or its owner is
   configured in no execution of the module (a removed generator, wherever its files
   live). An entry with no owner (the plain `"<path>": "<hash>"` form other ports write)
   counts as configured nowhere only inside this run's output directories. A file another
   configured generator owns is never this run's orphan, even in a shared output
   directory. One path emitted with different content by two generator/output-directory
   pairs in the same build is an error naming both; byte-identical re-emission is one file,
   and a path the adopter hand-owns is refused for each generator, not a collision. The first build on a manifest that names no generator owner
   (an 8.1.0 pre-release recorded the execution id instead) records the owners and deletes
   nothing. Two modules have two manifests.
2. **The overwrite decision is the hash, not the marker.** For a file at a generated path:
   - absent: write it and record it;
   - same content as fresh output: unchanged, and its record is confirmed;
   - recorded, and it still hashes to its record: overwrite it and record the new content;
   - recorded but edited: refuse it by name (`handEdits: keep`, the default), or replace it
     and record the new content (`handEdits: overwrite`, one log line per file);
   - not recorded: a file that carries the `GENERATED` token is adopted (see 3); one that does
     not is refused, whatever `handEdits` says.
3. **The first run adopts.** A project upgrading from 8.0.x has no manifest, and its generated
   files carry the token. The first run takes each such file as generated output: it writes
   fresh output, records it and prints one notice to commit the manifest. It deletes nothing,
   because a file has to be recorded before the sweep may delete it. This is the old behaviour
   for those files (the token meant overwrite), so the upgrade run changes nothing an adopter
   did not already get.
4. **The marker stays, for humans and for that one moment.** Generators still emit it. It
   decides only for a file with no record, and when no manifest is configured: an embedder
   driving a generator outside `mvn metaobjects:generate`, or a file written outside the
   module basedir.
5. **The orphan sweep is the cross-port rule.** After a full run, a recorded file under the
   execution's output directories that no generator emitted is deleted when untouched and
   refused by name when edited. Under `handEdits: overwrite` an edited orphan is also deleted
   when every generator writing into its directory overwrites. `mvn metaobjects:verify` judges
   extra files on the same evidence. The rule is written once in
   `docs/features/own-your-codegen.md`, "Files that are no longer generated".
6. **A refusal stays a warning on the JVM.** The build does not fail over a refused file.
   `mvn metaobjects:generate` runs inside the reactor, and failing every build over a file the
   user chose to own punishes the person the refusal protects. The other ports exit 1.
   `mvn metaobjects:verify` is the gate that fails.
7. **Write paths that bypass `GeneratedFileWriter` stay outside the manifest.** User templates
   (`TemplateScopeGenerator`, `MustacheTemplateGenerator`), the api-docs pages and the
   `META-INF/services` registration are not recorded. So the sweep never deletes them: a file
   with no record is not ours.

## Consequences

- Renaming a generator's output directory, or moving it to a generator of another
  registry id, changes its owner: the old pair is configured nowhere, so the next build
  deletes its untouched files and regenerates them under the new owner.
- Adopters commit one new file per module, `.metaobjects/.gen-state/.hashes.json`. A clone
  without it adopts again on its first run, which is harmless, but it cannot delete a stale
  file or protect an edit until a manifest exists.
- **Editing a generated file now protects it.** On 8.0.x the next run overwrote the edit. A
  team that edited generated files and relied on regeneration to discard the edits now gets
  a refusal per file. Set `<handEdits>overwrite</handEdits>` on the generator to keep the old
  outcome on purpose.
- Deleting the `GENERATED` line still takes a file out of regeneration: it is an edit, so the
  file is refused under `keep`.
- A renamed or deleted object's generated files are removed by the next full run.
- The JVM matches the other four ports on the overwrite rule and the orphan rule. It differs
  only in item 6 (a refusal is a warning) and in having no `--generators` narrowing: an
  execution's `<generators>` list is always complete, so every run is a full run.

Migration: [jvm-codegen-hash-manifest.md](../../docs/features/migrations/jvm-codegen-hash-manifest.md).

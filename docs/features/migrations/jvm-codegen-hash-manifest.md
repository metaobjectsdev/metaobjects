# Migration: Java and Kotlin commit the codegen hash manifest

**Changed in:** Maven 8.1.0 (npm, PyPI and NuGet 1.1.0) · **Ports affected:** Java and Kotlin
**Automatic fix:** the first `mvn metaobjects:generate` run does it; you commit one file per
module. Decision record:
[ADR-0059](https://github.com/metaobjectsdev/metaobjects/blob/main/spec/decisions/ADR-0059-jvm-codegen-hash-manifest.md).

## What changed

Through 8.0.x, `mvn metaobjects:generate` decided whether it could overwrite a file from the
`GENERATED` token in the file's header. A file that carried it was overwritten, even when you
had edited it. A file that was no longer generated (a renamed value object, a deleted entity)
stayed on disk forever, because nothing recorded what a run had written.

From 8.1.0 the Java and Kotlin generators record every file they write in a committed hash
manifest, the same one TypeScript, Python and C# use:

```
<module basedir>/.metaobjects/.gen-state/.hashes.json
```

It maps each generated file's module-relative path to the SHA-256 of what was written and
to its owner: the generator that wrote it (its registry id, or the class name of a
generator of your own) and that generator's output directory within the module:

```json
{
  "target/generated-sources/java/com/acme/CustomerDto.java": {
    "hash": "3f1c…",
    "generator": "java:dto",
    "outputDir": "target/generated-sources/java"
  }
}
```

With it:

- a file that still matches its record is overwritten as before;
- **a file you edited is refused by name**, and the build logs a warning (it does not fail);
- **a file no generator emits any more is deleted** when it still matches its record, and
  refused by name when you edited it;
- a file the manifest has no record of, and that has no `GENERATED` token, is refused, as
  before.

## What to do

1. Upgrade the plugin and run `mvn metaobjects:generate` once. The first run finds no
   manifest, takes every existing file that carries the `GENERATED` token as generated output,
   writes fresh output and records it. It deletes nothing. It prints one notice:

   ```
   mvn metaobjects:generate: created the codegen hash manifest `.metaobjects/.gen-state/.hashes.json` and adopted N existing generated file(s) into it. Commit it: ...
   ```

2. Commit the manifest, in every module that runs the plugin:

   ```bash
   git add .metaobjects/.gen-state/.hashes.json
   git commit -m "chore: commit the codegen hash manifest"
   ```

   If a `.gitignore` excludes `.metaobjects/` or `.gen-state/`, re-include the one file:

   ```gitignore
   .metaobjects/.gen-state/*
   !.metaobjects/.gen-state/.hashes.json
   ```

   Exclude the directory's contents (`.gen-state/*`), not the directory itself: git does not
   look inside an excluded directory, so a negation under `.gen-state/` would never apply.

3. Run `mvn metaobjects:generate` again. A file that a renamed or deleted object used to
   produce is now removed. Review that diff.

If one module declares several `metaobjects:generate` executions, a run deletes only its own
generators' orphans and the files of generators the module no longer configures, so
executions that share an output directory never delete each other's output. The owner does
not name the Maven execution, so `mvn metaobjects:generate` (which runs as `default-cli`)
and the lifecycle execution agree on it. A file two generators emit with different content in
one build fails the goal, naming both: configure only one generator to emit it.

A clone without the manifest adopts again on its first run. That is harmless, but until a
manifest exists the run cannot delete a stale file or protect an edit.

## If you relied on regeneration discarding edits

Through 8.0.x an edit to a generated file was overwritten on the next run. Now it is refused,
and the build warns. If the generator's output is never meant to be edited, say so on its
entry, and the run replaces edits as before, naming each file:

```xml
<generator>
  <classname>com.metaobjects.generator.spring.SpringDtoGenerator</classname>
  <handEdits>overwrite</handEdits>
  <args>...</args>
</generator>
```

`keep` is the default. With `overwrite`, an edited file that no generator emits any more is
also deleted, when every generator writing into its directory sets `overwrite`.

## If you took ownership by deleting the `GENERATED` line

That still works: deleting the line is an edit, so the file no longer matches its record and
is refused.

## What does not change

- User templates (`TemplateScopeGenerator`, `MustacheTemplateGenerator`), the api-docs pages
  and the `META-INF/services` registration are not recorded. They are written on every run as
  before, and the run never deletes them.
- A refusal is still a warning on the JVM. `mvn metaobjects:verify` is the gate that fails:
  it reports a stale file, says whether `generate` deletes it, and tells you to delete an
  edited one yourself.

package com.metaobjects.generator.kotlin

import com.metaobjects.generator.util.GeneratedFileWriter
import com.squareup.kotlinpoet.FileSpec
import java.nio.file.Path

/**
 * The one way a KotlinPoet [FileSpec] reaches disk on this port.
 *
 * <p><b>Why this exists.</b> Every generator here is supposed to write through
 * [GeneratedFileWriter], so a file carrying no `GENERATED` marker is treated as
 * hand-written and left alone. The generators that hand-roll their file bodies as strings
 * did exactly that. The ones that build a [FileSpec] did not — they called
 * `FileSpec.writeTo(outRoot)`, which is an unconditional overwrite:
 * `directory.resolve(relativePath).outputStream()` opens with `Files.newOutputStream`'s
 * defaults (CREATE, TRUNCATE_EXISTING, WRITE) and never looks at what was there.
 *
 * <p>So the marker floor was real for one half of the port and absent for the other, and
 * [KotlinEntityGenerator] used BOTH — its `MetaNetJson.kt` support file was guarded while
 * `<Entity>.kt`, the file an adopter is most likely to want to own, was not. A divergence
 * inside a single generator is exactly what let the docs claim a floor the port did not
 * have.
 *
 * <p><b>The route is deliberately byte-identical to what KotlinPoet would have written.</b>
 * KotlinPoet resolves its own output path as `directory.resolve(relativePath)` and writes
 * `toString()` as UTF-8; [relativePath] is public API and `FileSpec.toString()` is defined
 * as `buildString { writeTo(this) }` — the same emitter, the same bytes. Nothing about an
 * adopter's generated output changes; only the decision of whether to write at all.
 *
 * <p>Reach for this instead of `FileSpec.writeTo(...)` in every new KotlinPoet generator.
 * The one precondition is the one [GeneratedFileWriter] states: the emitted content must
 * actually carry the marker, or the first run writes and every run after refuses. For a
 * KotlinPoet type that means an `addKdoc("GENERATED — …")` on the type it emits.
 */
object KotlinPoetFileWriter {

    /**
     * Write [fileSpec] under [outRoot] at KotlinPoet's own package-derived path, unless an
     * existing file there carries no `GENERATED` marker — in which case it is somebody's
     * own file and is left untouched (a WARN, never a build failure).
     *
     * @return [GeneratedFileWriter.Outcome.WRITTEN] or [GeneratedFileWriter.Outcome.REFUSED]
     */
    fun write(fileSpec: FileSpec, outRoot: Path): GeneratedFileWriter.Outcome =
        GeneratedFileWriter.write(outRoot.resolve(fileSpec.relativePath), fileSpec.toString())
}

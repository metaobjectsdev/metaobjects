package com.metaobjects.generator.kotlin

import com.tschuchort.compiletesting.KotlinCompilation
import com.tschuchort.compiletesting.SourceFile
import java.nio.file.Files
import java.nio.file.Path
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Eject proof (a) — every Kotlin generator `mvn metaobjects:eject` can copy out of this
 * module compiles, package-renamed, against the PUBLISHED API (this module's own compiled
 * classes plus its declared dependencies — exactly what an adopter's new `codegen/` module
 * depends on after eject). See `docs/superpowers/specs/
 * 2026-09-22-eject-in-every-port-design.md` (JVM section). Each copy compiled ALONE, and
 * what it may reference, is `EjectContractTest`'s to assert.
 *
 * Reads straight off `src/main/kotlin` (the maven-plugin module that runs the real eject
 * mojo depends on THIS module, not the reverse, so the mojo isn't reachable here) and
 * rewrites the package line the exact same way eject does: the ONE deliberate edit
 * ADR-0034 makes. `inheritClassPath = true` compiles against this module's real,
 * already-resolved dependency classpath — proving the reference compiles against the
 * PUBLISHED API, not some hand-picked subset.
 */
@OptIn(org.jetbrains.kotlin.compiler.plugin.ExperimentalCompilerApi::class)
class EjectedGeneratorsCompileTest {

    /** Every reference this module ships, read off the registry so the list cannot fall behind it. */
    private val ejectableSimpleNames = GENERATOR_REGISTRY.values.flatMap { info ->
        // The generator, and the classes eject copies with it (an emitter, a page model).
        listOfNotNull(info.ejectResourcePath).map { it.substringAfterLast('/').substringBeforeLast('.') } +
            info.ejectWith.map { it.substringAfterLast('.') }
    }.distinct()

    private val packageLine = Regex("(?m)^package\\s+[\\w.]+\\s*$")

    private fun rewritePackage(source: String, newPackage: String): String {
        val match = packageLine.find(source)
            ?: throw AssertionError("expected a package line")
        return source.replaceRange(match.range, "package $newPackage")
    }

    @Test
    fun everyEjectableGeneratorCompilesPackageRenamed() {
        val srcDir = Path.of("src/main/kotlin/com/metaobjects/generator/kotlin")
        assertTrue(Files.isDirectory(srcDir), "expected ${srcDir.toAbsolutePath()} to exist")

        // A generator may sit in a subpackage's directory (api-docs does); eject ships them all flat.
        val byName = Files.walk(srcDir).use { walk -> walk.filter { it.toString().endsWith(".kt") }.toList() }
            .associateBy { it.fileName.toString().removeSuffix(".kt") }

        val sources = ejectableSimpleNames.map { simpleName ->
            val original = byName[simpleName]
            assertTrue(original != null && Files.exists(original), "expected $simpleName.kt under $srcDir")
            original!!
            val rewritten = rewritePackage(Files.readString(original), "com.acme.owned")
            SourceFile.kotlin("$simpleName.kt", rewritten)
        }

        val result = KotlinCompilation().apply {
            this.sources = sources
            inheritClassPath = true
            messageOutputStream = System.out
        }.compile()

        assertEquals(KotlinCompilation.ExitCode.OK, result.exitCode,
            "ejected+package-renamed generators failed to compile:\n${result.messages}")
    }
}

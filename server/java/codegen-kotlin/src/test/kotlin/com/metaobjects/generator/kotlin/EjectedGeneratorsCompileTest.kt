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
 * 2026-09-22-eject-in-every-port-design.md` (JVM section) and `GeneratorRegistry.kt`'s
 * `ejectPath(...)` calls, whose class names this list mirrors.
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

    /** Every stable name codegen-kotlin ships as an ejectable reference (GeneratorRegistry.kt). */
    private val ejectableSimpleNames = listOf(
        "KotlinEntityGenerator",
        "KotlinSpringControllerGenerator",
        "KotlinRepositoryGenerator",
        "KotlinOutputParserGenerator",
        "KotlinOutputPromptGenerator",
        "KotlinRenderHelperGenerator",
        "KotlinExtractorGenerator",
        "KotlinFilterAllowlistGenerator",
        "KotlinNamesGenerator",
        "KotlinExposedTableGenerator",
        "KotlinRelationsGenerator",
        "KotlinSpringConfigGenerator",
        "KotlinStoredProcGenerator",
        "KotlinValidatorGenerator",
    )

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

        val sources = ejectableSimpleNames.map { simpleName ->
            val original = srcDir.resolve("$simpleName.kt")
            assertTrue(Files.exists(original), "expected $original to exist")
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

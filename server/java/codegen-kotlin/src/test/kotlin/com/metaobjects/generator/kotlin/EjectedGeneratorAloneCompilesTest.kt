package com.metaobjects.generator.kotlin

import com.tschuchort.compiletesting.KotlinCompilation
import com.tschuchort.compiletesting.SourceFile
import java.nio.file.Files
import java.nio.file.Path
import kotlin.test.Test
import kotlin.test.assertTrue

/**
 * Eject proof (a), one generator at a time: every ejectable Kotlin generator, copied out
 * ALONE into a foreign package, compiles against the published API.
 *
 * An adopter ejects the generator they want to change, not the whole tier. A copy that calls
 * a helper on a sibling generator resolves only while that sibling sits in the same package,
 * so [EjectedGeneratorsCompileTest], which compiles every copy together, cannot see the
 * defect. Each copy here is compiled with nothing else beside it.
 *
 * The list comes from [GENERATOR_REGISTRY], never a hand-typed one. The package line is
 * rewritten exactly as `mvn metaobjects:eject` rewrites it.
 */
@OptIn(org.jetbrains.kotlin.compiler.plugin.ExperimentalCompilerApi::class)
class EjectedGeneratorAloneCompilesTest {

    private val packageLine = Regex("(?m)^package\\s+[\\w.]+\\s*$")

    @Test
    fun everyEjectableGeneratorCompilesAlone() {
        val srcDir = Path.of("src/main/kotlin/com/metaobjects/generator/kotlin")
        val ejectable = GENERATOR_REGISTRY.values.filter { it.ejectResourcePath != null }
        assertTrue(ejectable.isNotEmpty(), "expected the registry to name ejectable generators")

        val failures = ejectable.mapNotNull { info ->
            val simpleName = info.ejectResourcePath!!.substringAfterLast('/').substringBeforeLast('.')
            val file = srcDir.resolve("$simpleName.kt")
            assertTrue(Files.exists(file), "expected $file to exist")
            val original = Files.readString(file)
            val match = packageLine.find(original) ?: throw AssertionError("$simpleName has no package line")
            val rewritten = original.replaceRange(match.range, "package com.acme.owned")

            val result = KotlinCompilation().apply {
                sources = listOf(SourceFile.kotlin("$simpleName.kt", rewritten))
                inheritClassPath = true
                messageOutputStream = System.out
            }.compile()
            if (result.exitCode == KotlinCompilation.ExitCode.OK) null
            else "${info.name} ($simpleName) does not compile alone:\n${result.messages}"
        }
        assertTrue(failures.isEmpty(), failures.joinToString("\n"))
    }
}

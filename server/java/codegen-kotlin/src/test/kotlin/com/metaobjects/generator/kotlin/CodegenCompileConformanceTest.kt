package com.metaobjects.generator.kotlin

import com.metaobjects.generator.Generator
import com.metaobjects.generator.util.GeneratedFileWriter
import com.metaobjects.metadata.ktx.loadDirectory
import com.tschuchort.compiletesting.KotlinCompilation
import com.tschuchort.compiletesting.SourceFile
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths
import kotlin.io.path.isRegularFile
import kotlin.io.path.readText
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * CODEGEN-COMPILE CONFORMANCE (Kotlin lane).
 *
 * Generate from the SHARED cross-port corpus —
 * `fixtures/persistence-conformance/canonical/meta.fitness.json` — and compile every
 * emitted file with the real Kotlin compiler. Zero errors or the lane is red.
 *
 * WHY THIS EXISTS. Four defects shipped in 1.0.4 that every existing gate was blind to,
 * because each one produced output that PARSES and GENERATES cleanly and only fails when
 * somebody builds it:
 *
 *  - a view over an int-backed enum imported a codec drizzle does not export (TS);
 *  - a renamed projection field selected a column that does not exist (TS);
 *  - a DbContext named FK config through `nameof` on a member that is not there (C#);
 *  - an extract mapper did not compile for most scalar subtypes (Java).
 *
 * `mvn metaobjects:generate` exits 0 in all four cases. The metamodel, render,
 * persistence, api-contract and registry corpora all stay green — they gate BEHAVIOR, and
 * none of them asks whether the emitted code builds. The adopter's build is the first
 * thing that does, which makes the adopter the gate. This closes that.
 *
 * WHY THIS IS NOT THE EXISTING COMPILE TESTS. A dozen tests in this package compile
 * generated Kotlin, and each runs one generator (or a tight pair) over a small
 * hand-authored fixture built to corner a specific emit. The closest thing to a fan-out
 * gate, `TphFullSuiteCompilesTest`, lives in `integration-tests-kotlin` and runs the full
 * suite over ONE TPH fixture. And `KotlinCodegenMatchesReferenceTest` does load this
 * corpus — but runs one generator over it and matches the output as TEXT, which is
 * exactly the shape of assertion that passes on a file that cannot compile. Full corpus,
 * full tier, real compiler is the combination that did not exist.
 *
 * WHAT IT EXCLUDES: [KotlinSpringControllerGenerator] and [KotlinSpringConfigGenerator],
 * whose output imports Spring — which this module deliberately does not depend on at any
 * scope. Every peer port draws the same line for the same reason (TS omits routesFile, C#
 * omits RoutesGenerator, Java omits SpringControllerGenerator), so the boundary is a
 * cross-port rule rather than a local concession. The generated Kotlin controller is
 * compiled and booted over MockMvc in `integration-tests-kotlin`, which has Spring and the
 * newer kctfork compiler on its test classpath.
 *
 * The prompt-tier generators (output-parser / output-prompt / render-helper / extractor)
 * are absent because they key off `template.*` nodes and this corpus declares none —
 * including them would emit nothing and read as coverage that is not there.
 *
 * The peer lanes are the same test in each port. If one port drops out, that port keeps
 * precisely the bug class this exists to catch — so a skip here is never "just this lane".
 */
@OptIn(org.jetbrains.kotlin.compiler.plugin.ExperimentalCompilerApi::class)
class CodegenCompileConformanceTest {

    /** Walk up from cwd to the shared corpus, regardless of which module Maven ran from. */
    private fun findCorpusRoot(): Path {
        var cur: Path? = Paths.get("").toAbsolutePath()
        while (cur != null) {
            val candidate = cur.resolve("fixtures/persistence-conformance")
            if (Files.isDirectory(candidate)) return candidate
            cur = cur.parent
        }
        throw IllegalStateException(
            "Could not locate fixtures/persistence-conformance from ${Paths.get("").toAbsolutePath()}")
    }

    /**
     * Generate one selection into one output dir and compile the whole tree as a single
     * module. Compiling the fan-out TOGETHER is the point: emitting each generator into its
     * own sandbox would re-create the single-generator blind spot this exists to close,
     * because the cross-artifact references would never be resolved.
     *
     * The run is opened through [GeneratedFileWriter.beginRun] — the same scope the Maven
     * mojo opens around a real build — so a selection in which two generators claim one
     * output path fails here instead of resolving by generator order.
     */
    private fun generateAndCompile(
        label: String,
        generators: List<Pair<String, Generator>>,
        minFiles: Int,
        expectedFiles: List<String> = emptyList(),
    ) {
        val canonical = findCorpusRoot().resolve("canonical")
        val outDir = Files.createTempDirectory("codegen-compile-$label-")
        try {
            val loader = loadDirectory("fitness-$label", canonical)

            // Each Kotlin generator decides its own applicability INSIDE execute(loader) —
            // its own subtype / abstract / TPH / source-presence guard chain — so unlike the
            // TS lane there is no runner-level `matches` to compose here. Driving them the
            // way the build drives them is what keeps this measuring the emit, not the harness.
            GeneratedFileWriter.beginRun().use { run ->
                for ((name, gen) in generators) {
                    run.attributeTo(name)
                    // packageName is required by KotlinValidatorGenerator, which emits a
                    // package-level startup-validator stub regardless of entity count, and
                    // inert for the rest. The corpus declares its objects under `fitness`.
                    gen.setArgs(mapOf(
                        "outputDir" to outDir.toString(),
                        "packageName" to "fitness",
                        // The render-helper and output-prompt generators run a BUILD-TIME
                        // drift gate, so they need the on-disk mustache the corpus's
                        // @textRef points at; inert for every other generator here.
                        "templateRoot" to canonical.resolve("prompts").toString(),
                    ))
                    gen.execute(loader)
                }
            }

            // Collect the PATHS first: the emitted file names are asserted below, and
            // reading them back off SourceFile loses the element type through the Java
            // stream's toList().
            val emittedPaths: List<java.nio.file.Path> = Files.walk(outDir)
                .filter { it.isRegularFile() && it.toString().endsWith(".kt") }
                .toList()
            val emittedNames: Set<String> = emittedPaths.map { it.fileName.toString() }.toSet()
            val sources = emittedPaths.map { SourceFile.kotlin(it.fileName.toString(), it.readText()) }

            // The floor is PER SELECTION. It used to be a flat `> 16`, calibrated for the
            // entity fan-out — a template-only selection cannot reach that, so the count
            // was a floor for one selection and a trap for the next.
            assertTrue(sources.size >= minFiles,
                "$label: expected at least $minFiles file(s) from this selection, saw ${sources.size}")
            // A compile gate passes trivially on an empty emit, so name what this
            // selection must have produced.
            for (expected in expectedFiles) {
                assertTrue(expected in emittedNames,
                    "$label: expected $expected in the emitted tree; saw $emittedNames")
            }

            val result = KotlinCompilation().apply {
                this.sources = sources
                inheritClassPath = true   // brings Exposed + kotlinx.serialization off the test classpath
                messageOutputStream = System.out
            }.compile()

            assertEquals(KotlinCompilation.ExitCode.OK, result.exitCode,
                "$label: `mvn metaobjects:generate` over the shared fitness corpus emitted " +
                    "${sources.size} file(s) that do not compile:\n${result.messages}")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    @Test
    fun `the Kotlin model and persistence tier compiles`() {
        generateAndCompile("model", listOf(
            "KotlinEntityGenerator" to KotlinEntityGenerator(),
            "KotlinExposedTableGenerator" to KotlinExposedTableGenerator(),
            "KotlinNamesGenerator" to KotlinNamesGenerator(),
            "KotlinRelationsGenerator" to KotlinRelationsGenerator(),
            "KotlinFilterAllowlistGenerator" to KotlinFilterAllowlistGenerator(),
            "KotlinValidatorGenerator" to KotlinValidatorGenerator(),
        ), minFiles = 17)
    }

    /**
     * The TEMPLATE tier, compiled as one program with the value objects it references.
     *
     * This selection did not exist until 2026-09-22: the corpus declared no `template.*`
     * node, so the tier ADR-0056 rewrote sat outside the one gate that asks whether
     * emitted code BUILDS. `KotlinEntityGenerator` is in the selection because ADR-0056
     * made the template tier reference each value object's OWN type rather than a
     * template-named copy — the tier does not compile without it, and a selection that
     * left it out would prove nothing about the reference.
     */
    @Test
    fun `the Kotlin template tier compiles`() {
        generateAndCompile("template", listOf(
            "KotlinEntityGenerator" to KotlinEntityGenerator(),
            "KotlinRenderHelperGenerator" to KotlinRenderHelperGenerator(),
            "KotlinOutputPromptGenerator" to KotlinOutputPromptGenerator(),
            "KotlinOutputParserGenerator" to KotlinOutputParserGenerator(),
            "KotlinExtractorGenerator" to KotlinExtractorGenerator(),
        ), minFiles = 6, expectedFiles = listOf(
            "CoachNoteRenderHelper.kt", "CoachNoteResponseFormat.kt",
            "CoachNoteParser.kt", "CoachNoteExtractor.kt",
            "ProgramBrief.kt", "ProgramVerdict.kt", "WeekLabel.kt",
        ))
    }
}

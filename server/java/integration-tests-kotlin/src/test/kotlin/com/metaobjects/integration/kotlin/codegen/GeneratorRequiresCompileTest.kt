package com.metaobjects.integration.kotlin.codegen

import com.metaobjects.generator.Generator
import com.metaobjects.generator.kotlin.GENERATOR_REGISTRY
import com.metaobjects.integration.kotlin.ScenarioLoader
import com.metaobjects.loader.MetaDataLoader
import com.tschuchort.compiletesting.KotlinCompilation
import com.tschuchort.compiletesting.SourceFile
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths
import kotlin.io.path.isRegularFile
import kotlin.io.path.readText
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue

/**
 * The Kotlin `requires` and the skill's pom example, proven by compiling what they generate over
 * the shared fitness corpus. (The Java side, and the goal's refusal, are in the maven-plugin's
 * `GeneratorRequiresCompileTest`; this module is where Exposed and Spring are on the classpath.)
 *
 * The only `pom.xml` example the Kotlin skill shipped listed the entity, Exposed table and
 * controller generators. Its output did not compile on a real model: the controller names the
 * filter allowlists and the `<relation>Query` helpers, which nothing in that list wrote, and
 * `mvn metaobjects:generate` exited 0.
 */
@OptIn(org.jetbrains.kotlin.compiler.plugin.ExperimentalCompilerApi::class)
class GeneratorRequiresCompileTest {

    private val canonical: Path = ScenarioLoader.findCorpusRoot().resolve("canonical")
    private val loader: MetaDataLoader = MetaDataLoader.fromDirectory("requires-compile-kotlin", canonical)

    private fun closure(name: String): List<String> {
        val out = LinkedHashSet<String>()
        val todo = ArrayDeque(listOf(name))
        while (todo.isNotEmpty()) {
            val n = todo.removeFirst()
            if (out.add(n)) todo.addAll(GENERATOR_REGISTRY.getValue(n).requires)
        }
        return out.toList()
    }

    private fun compileErrors(root: Path): String {
        val sources = Files.walk(root).use { s ->
            s.filter { it.isRegularFile() && it.toString().endsWith(".kt") }.toList()
        }.map { SourceFile.kotlin(root.relativize(it).toString().replace('/', '_'), it.readText()) }
        assertTrue(sources.isNotEmpty(), "nothing generated under $root")
        val result = KotlinCompilation().apply {
            this.sources = sources
            inheritClassPath = true
            messageOutputStream = System.out
        }.compile()
        return if (result.exitCode == KotlinCompilation.ExitCode.OK) "" else result.messages
    }

    private fun generate(entries: List<Pair<Generator, Map<String, String>>>): Unit =
        entries.forEach { (gen, args) -> gen.setArgs(args); gen.execute(loader) }

    /** The Kotlin generators whose output is Kotlin the project compiles. `spring-config` is not
     *  here: its `@Configuration` imports Spring Boot, which this module does not carry; its one
     *  requirement, `validator`, is. */
    private val compiled = listOf(
        "entity", "exposed-table", "relations", "filter-allowlist", "routes", "repository",
        "names", "validator", "output-parser", "output-prompt", "render-helper", "extractor",
    )

    @Test
    fun `every requires closure compiles over the fitness corpus`() {
        for (name in compiled) {
            val out = Files.createTempDirectory("kotlin-requires-$name-")
            try {
                val args = mapOf(
                    "outputDir" to out.toString(),
                    "packageName" to "fitness",
                    "templateRoot" to canonical.resolve("prompts").toString(),
                )
                generate(closure(name).map { GENERATOR_REGISTRY.getValue(it).factory() to args })
                val errors = compileErrors(out)
                assertEquals("", errors, "$name with ${closure(name)} does not compile")
            } finally {
                out.toFile().deleteRecursively()
            }
        }
    }

    @Test
    fun `the controller without the relation queries does not compile`() {
        val out = Files.createTempDirectory("kotlin-requires-norelations-")
        try {
            val args = mapOf("outputDir" to out.toString(), "packageName" to "fitness")
            generate(closure("routes").filter { it != "relations" }.map { GENERATOR_REGISTRY.getValue(it).factory() to args })
            assertNotEquals("", compileErrors(out), "the controller compiled without relations, so it does not require it")
        } finally {
            out.toFile().deleteRecursively()
        }
    }

    @Test
    fun `the kotlin skill's pom example compiles with exactly its own arguments`() {
        var dir: Path = Paths.get("").toAbsolutePath()
        while (!Files.isDirectory(dir.resolve("agent-context"))) dir = dir.parent
        val md = dir.resolve("agent-context/skills/metaobjects-codegen/references/kotlin.md").readText()
        val poms = Regex("```xml\\n(.*?)```", RegexOption.DOT_MATCHES_ALL).findAll(md)
            .map { it.groupValues[1] }
            .filter { "metaobjects-maven-plugin" in it && "<generators>" in it }
            .toList()
        assertEquals(1, poms.size, "kotlin.md must have exactly one pom example")
        val build = Files.createTempDirectory("kotlin-skill-example-")
        try {
            // Parsed by pattern, not DOM: this module's classpath carries a DOM level without
            // Node.getTextContent. The example's shape is fixed by the skill: one <classname>
            // and a flat <args> per <generator>.
            val entries = Regex("<generator>(.*?)</generator>", RegexOption.DOT_MATCHES_ALL).findAll(poms.single()).map { g ->
                val body = g.groupValues[1]
                val classname = Regex("<classname>\\s*([^<\\s]+)\\s*</classname>").find(body)!!.groupValues[1]
                val argsBody = Regex("<args>(.*?)</args>", RegexOption.DOT_MATCHES_ALL).find(body)?.groupValues?.get(1) ?: ""
                val args = Regex("<(\\w+)>([^<]*)</\\1>").findAll(argsBody).associate { a ->
                    a.groupValues[1] to a.groupValues[2].trim().replace("\${project.build.directory}", build.toString())
                }
                (Class.forName(classname).getDeclaredConstructor().newInstance() as Generator) to args
            }.toList()
            assertTrue(entries.isNotEmpty(), "kotlin.md's pom example lists no generator")
            generate(entries)
            assertEquals("", compileErrors(build), "the kotlin.md pom example generates code that does not compile")
        } finally {
            build.toFile().deleteRecursively()
        }
    }
}

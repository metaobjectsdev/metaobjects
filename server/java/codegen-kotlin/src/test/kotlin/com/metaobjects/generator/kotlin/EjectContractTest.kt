package com.metaobjects.generator.kotlin

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import com.metaobjects.generator.Generator
import com.metaobjects.generator.ProjectClassLoaderAware
import com.metaobjects.metadata.ktx.loadDirectory
import com.tschuchort.compiletesting.KotlinCompilation
import com.tschuchort.compiletesting.SourceFile
import java.io.ByteArrayInputStream
import java.io.DataInputStream
import java.io.IOException
import java.lang.reflect.Modifier
import java.nio.file.Files
import java.nio.file.Path
import java.util.jar.JarFile
import kotlin.io.path.isRegularFile
import kotlin.io.path.readText
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The eject contract, asserted for the Kotlin port (ADR-0034 Amendment 8).
 *
 * Every stock generator can be ejected, and the owned copy holds its emit. Three assertions,
 * each driven by `fixtures/generator-registry-conformance/registry.json`:
 *
 * - **Census.** Every concrete [Generator] this module ships belongs to a registry entry, and
 *   the registry exposes exactly the names the shared file gives this port.
 * - **Completeness.** Every registered generator ships eject source unless the shared file
 *   exempts it with a reason, and the reference sources the jar ships are exactly the ones
 *   the registry names (the pom's include list, read from what it produced).
 * - **Depth.** Each generator, package-renamed as `mvn metaobjects:eject` writes it and
 *   compiled ALONE, references nothing in the generator packages outside the engine surface,
 *   and emits what the packaged generator emits.
 *
 * Where the contract does not hold yet, the shared file's `pending` list says so. A pending
 * entry that passes fails here, and so does a gap that is not listed.
 *
 * The copy is read from the shipped resource, not through the mojo: `maven-plugin` depends on
 * this module, not the reverse. The one edit eject makes to a Kotlin copy is its package line.
 */
@OptIn(org.jetbrains.kotlin.compiler.plugin.ExperimentalCompilerApi::class)
class EjectContractTest {

    // ---------------------------------------------------------------------------------
    // the shared file
    // ---------------------------------------------------------------------------------

    private fun pending(assertion: String): Map<String, Set<String>> {
        val out = sortedMapOf<String, MutableSet<String>>()
        for (p in manifest.get("eject").get("pending")) {
            if (p.get("port").asText() != PORT || p.get("assertion").asText() != assertion) continue
            val outside = out.getOrPut(p.get("generator").asText()) { sortedSetOf() }
            p.get("outside")?.forEach { outside.add(it.asText()) }
        }
        return out
    }

    private fun isExempt(name: String): Boolean = manifest.get("generators").get(name).get("eject").isObject

    private fun surface(key: String): List<String> =
        manifest.get("eject").get("engineSurface").get(PORT).get(key).map { it.asText() }

    /** `**` matches any run of characters, `*` one dotted segment. */
    private fun glob(pattern: String): Regex =
        Regex(Regex("""\*\*|\*|[^*]+""").findAll(pattern).joinToString("") {
            when (it.value) { "**" -> ".*"; "*" -> "[^.]*"; else -> Regex.escape(it.value) }
        })

    /** True for a class that writes output: inside the generator packages, and not engine. */
    private fun outsideEngineSurface(className: String): Boolean =
        surface("codegenPackages").any { glob(it).matches(className) } &&
            surface("engine").none { glob(it).matches(className) }

    // ---------------------------------------------------------------------------------
    // census
    // ---------------------------------------------------------------------------------

    /** Every path this module ships under [prefix]: its classes directory, or its jar. */
    private fun shipped(prefix: String): Set<String> {
        val home = Path.of(GeneratorInfo::class.java.protectionDomain.codeSource.location.toURI())
        if (Files.isDirectory(home)) {
            val root = home.resolve(prefix)
            if (!Files.isDirectory(root)) return emptySet()
            return Files.walk(root).use { walk ->
                walk.filter { it.isRegularFile() }
                    .map { home.relativize(it).toString().replace(java.io.File.separatorChar, '/') }
                    .toList().toSortedSet()
            }
        }
        return JarFile(home.toFile()).use { jar ->
            jar.entries().asSequence().filter { !it.isDirectory && it.name.startsWith(prefix) }
                .map { it.name }.toSortedSet()
        }
    }

    @Test
    fun `census - every generator class this module ships belongs to a registry entry`() {
        val registered = GENERATOR_REGISTRY.values.map { it.factory().javaClass.name }.toSet()
        val found = shipped("com/metaobjects/")
            .filter { it.endsWith(".class") && '$' !in it }
            .map { Class.forName(it.removeSuffix(".class").replace('/', '.'), false, javaClass.classLoader) }
            .filter { Generator::class.java.isAssignableFrom(it) && !it.isInterface && !Modifier.isAbstract(it.modifiers) }
            .map { it.name }
        assertTrue(found.size >= 10, "the scan found too few generators to be believed: $found")
        val unregistered = found.filterNot { it in registered }.sorted()
        assertTrue(unregistered.isEmpty(),
            "generator classes no registry entry constructs, so no catalog, eject goal or test sees them: " +
                "$unregistered. Register each in GeneratorRegistry.kt and in $MANIFEST_PATH.")
    }

    @Test
    fun `census - the registry exposes the names the shared file gives this port`() {
        val generators = manifest.get("generators")
        val expected = generators.fieldNames().asSequence()
            .filter { name -> generators.get(name).get("ports").any { it.asText() == PORT } }.toSortedSet()
        val actual = GENERATOR_REGISTRY.keys.toSortedSet()
        assertEquals(emptySet(), actual - expected, "registered, but the shared file does not list it for kotlin")
        assertEquals(pending("census").keys.toSortedSet(), (expected - actual).toSortedSet(),
            "expected in the Kotlin registry by the shared file; a pending census entry must list each")
    }

    // ---------------------------------------------------------------------------------
    // completeness
    // ---------------------------------------------------------------------------------

    @Test
    fun `completeness - every registered generator ships eject source unless exempt`() {
        val waiting = pending("completeness").keys
        val problems = mutableListOf<String>()
        for ((name, info) in GENERATOR_REGISTRY.toSortedMap()) {
            val ejectable = info.ejectResourcePath != null
            if (isExempt(name)) {
                if (ejectable) problems += "$name: exempt in the shared file but ejectable; drop the exemption"
                continue
            }
            if (ejectable && name in waiting) problems += "$name: ejectable now; remove its pending completeness entry"
            if (!ejectable && name !in waiting) problems += "$name: no eject source, and the shared file does not exempt it"
        }
        problems += (waiting - GENERATOR_REGISTRY.keys)
            .map { "$it: pending completeness entry for a generator this port does not register" }
        assertTrue(problems.isEmpty(), problems.joinToString("\n"))
    }

    @Test
    fun `completeness - the shipped reference sources are exactly the ones the registry names`() {
        val named = GENERATOR_REGISTRY.values.mapNotNull { it.ejectResourcePath }.toSortedSet()
        assertEquals(named, shipped(EJECT_RESOURCE_ROOT))
    }

    // ---------------------------------------------------------------------------------
    // depth
    // ---------------------------------------------------------------------------------

    private fun ejectable(): Map<String, GeneratorInfo> =
        GENERATOR_REGISTRY.filterValues { it.ejectResourcePath != null }.toSortedMap()

    /**
     * Every packaged class a compiled class file names: the class names, descriptors and
     * signatures in its constant pool. A string the generator EMITS never qualifies: emitted
     * Kotlin spells packages with dots, and a constant holding whitespace is not a name.
     */
    private fun referencedClasses(classFile: ByteArray): Set<String> {
        val out = sortedSetOf<String>()
        val input = DataInputStream(ByteArrayInputStream(classFile))
        input.skipBytes(8) // magic, minor, major
        val count = input.readUnsignedShort()
        var i = 1
        while (i < count) {
            when (val tag = input.readUnsignedByte()) {
                1 -> {
                    val text = input.readUTF()
                    if ('.' !in text && text.none { it.isWhitespace() }) {
                        PACKAGED_CLASS.findAll(text).forEach { out += it.value.replace('/', '.').substringBefore('$') }
                    }
                }
                3, 4, 9, 10, 11, 12, 17, 18 -> input.skipBytes(4)
                5, 6 -> { input.skipBytes(8); i++ }
                7, 8, 16, 19, 20 -> input.skipBytes(2)
                15 -> input.skipBytes(3)
                else -> throw IOException("unknown constant pool tag $tag")
            }
            i++
        }
        return out
    }

    private fun outsideEngineSurface(result: KotlinCompilation.Result): Set<String> =
        result.outputDirectory.walkTopDown().filter { it.extension == "class" }
            .flatMap { referencedClasses(it.readBytes()) }
            .filter { outsideEngineSurface(it) }.toSortedSet()

    @Test
    fun `depth - an owned copy references only the engine surface`() {
        val waiting = pending("depth")
        val problems = mutableListOf<String>()
        for (name in ejectable().keys) {
            val actual = outsideEngineSurface(ownedCopy(name))
            val expected = waiting[name] ?: emptySet()
            if (actual == expected) continue
            problems += when {
                expected.isEmpty() ->
                    "$name: its owned copy calls emit code that stays in the package: $actual. Hand it over with " +
                        "the generator; a reference to the engine belongs in eject.engineSurface.kotlin.engine."
                actual.isEmpty() -> "$name: its owned copy is whole now; remove its pending depth entry"
                else -> "$name: pending depth entries list $expected, the owned copy references $actual"
            }
        }
        problems += (waiting.keys - ejectable().keys).map { "$it: pending depth entry for a generator that is not ejectable" }
        assertTrue(problems.isEmpty(), problems.joinToString("\n"))
    }

    @Test
    fun `depth - every engine surface entry names a real class`() {
        val stale = surface("engine").filter { '*' !in it }.filter {
            runCatching { Class.forName(it, false, javaClass.classLoader) }.isFailure
        }
        assertEquals(emptyList(), stale, "eject.engineSurface.kotlin.engine names classes that do not exist")
    }

    /** A shared model directory, and the directory its template refs resolve under. */
    private class Corpus(val label: String, model: String, templates: String? = null) {
        val model: Path = FIXTURES.resolve(model)
        val templates: Path? = templates?.let { FIXTURES.resolve(it) }
        /** Loaded once and shared by both sides. A loader's name is an identifier. */
        val loader by lazy { loadDirectory("ejectContract_" + label.replace('-', '_'), this.model) }
    }

    private fun run(generator: Generator, corpus: Corpus): Map<String, String> {
        val out = Files.createTempDirectory("eject-contract-")
        try {
            val args = mutableMapOf(
                "outputDir" to out.toString(),
                "packageName" to "acme",
                "testPackage" to "com.example.requirements",
                "witnessClass" to "com.example.Witnesses",
                "warnUncovered" to "false",
                // Required by the generators that read template text, whatever the model holds.
                "templateRoot" to (corpus.templates ?: CORPORA.first().templates).toString(),
            )
            if (generator is ProjectClassLoaderAware) generator.setProjectClassLoader(javaClass.classLoader)
            generator.setArgs(args).execute(corpus.loader)
            return Files.walk(out).use { walk ->
                walk.filter { it.isRegularFile() }.toList()
                    .associate { out.relativize(it).toString() to it.readText() }.toSortedMap()
            }
        } finally {
            out.toFile().deleteRecursively()
        }
    }

    @Test
    fun `depth - an unchanged owned copy emits what the packaged generator emits`() {
        val silent = mutableListOf<String>()
        for ((name, info) in ejectable()) {
            val owned = ownedCopy(name).classLoader.loadClass("$OWNED_PACKAGE.${simpleName(info)}")
            var emitted = 0
            for (corpus in CORPORA) {
                val where = "$name over ${corpus.label}"
                val a = run(info.factory(), corpus)
                val b = run(owned.getDeclaredConstructor().newInstance() as Generator, corpus)
                emitted += a.size
                assertEquals(a.keys, b.keys, where)
                for ((path, content) in a) assertEquals(content, b[path], "$where: $path")
            }
            // An empty emit on both sides compares equal and proves nothing.
            if (emitted == 0) silent += name
        }
        assertEquals(emptyList(), silent, "emitted nothing over the corpora, so nothing was compared")
    }

    companion object {
        private const val PORT = "kotlin"
        private const val OWNED_PACKAGE = "com.acme.owned"
        private val PACKAGED_CLASS = Regex("com/metaobjects/[A-Za-z0-9_/$]+")
        private val PACKAGE_LINE = Regex("(?m)^package\\s+[\\w.]+\\s*$")

        private val REPO_ROOT: Path = generateSequence(Path.of("").toAbsolutePath()) { it.parent }
            .first { Files.isDirectory(it.resolve("fixtures")) && Files.isDirectory(it.resolve("server")) }
        private val FIXTURES: Path = REPO_ROOT.resolve("fixtures")
        private val MANIFEST_PATH: Path = FIXTURES.resolve("generator-registry-conformance/registry.json")
        private val manifest: JsonNode by lazy { ObjectMapper().readTree(Files.readString(MANIFEST_PATH)) }

        /** Shared models that between them make every ejectable generator emit. */
        private val CORPORA = listOf(
            Corpus("fitness", "persistence-conformance/canonical", "persistence-conformance/canonical/prompts"),
            Corpus("requirements", "requirement-test-identity-conformance/worked-example/input"),
            Corpus("stored-proc", "conformance/parameter-ref-on-stored-proc/input"),
        )

        private fun simpleName(info: GeneratorInfo): String =
            info.ejectResourcePath!!.substringAfterLast('/').substringBeforeLast('.')

        private val compiled = mutableMapOf<String, KotlinCompilation.Result>()

        /** The owned copy of one generator: the shipped reference source with its package line
         *  rewritten, compiled with nothing else beside it. Compiled once per generator. */
        private fun ownedCopy(name: String): KotlinCompilation.Result = compiled.getOrPut(name) {
            val info = GENERATOR_REGISTRY.getValue(name)
            val reference = EjectContractTest::class.java.classLoader.getResourceAsStream(info.ejectResourcePath!!)
                ?.use { String(it.readAllBytes(), Charsets.UTF_8) }
                ?: throw AssertionError("$name: ${info.ejectResourcePath} is not shipped")
            val line = PACKAGE_LINE.find(reference) ?: throw AssertionError("$name has no package line")
            val result = KotlinCompilation().apply {
                sources = listOf(SourceFile.kotlin("${simpleName(info)}.kt",
                    reference.replaceRange(line.range, "package $OWNED_PACKAGE")))
                inheritClassPath = true
                messageOutputStream = java.io.OutputStream.nullOutputStream()
            }.compile()
            assertEquals(KotlinCompilation.ExitCode.OK, result.exitCode,
                "$name, ejected alone, does not compile:\n${result.messages}")
            result
        }
    }
}

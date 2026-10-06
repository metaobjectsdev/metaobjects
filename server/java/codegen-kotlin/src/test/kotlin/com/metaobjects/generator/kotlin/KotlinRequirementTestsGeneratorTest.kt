package com.metaobjects.generator.kotlin

import com.fasterxml.jackson.databind.ObjectMapper
import com.metaobjects.generator.Generator
import com.metaobjects.generator.GeneratorException
import com.metaobjects.generator.requirement.RenderedTest
import com.metaobjects.generator.requirement.RequirementTestArgs
import com.metaobjects.generator.requirement.RequirementTestRenderer
import com.metaobjects.generator.util.GeneratedFileWriter
import com.metaobjects.loader.MetaDataLoader
import com.metaobjects.metadata.ktx.loadDirectory
import com.metaobjects.requirement.RequirementTestFilter
import com.metaobjects.requirement.RequirementTestIdentities
import com.tschuchort.compiletesting.KotlinCompilation
import com.tschuchort.compiletesting.SourceFile
import org.junit.jupiter.api.Disabled
import java.io.ByteArrayOutputStream
import java.lang.reflect.InvocationTargetException
import java.nio.file.Files
import java.nio.file.Path
import java.util.TreeSet
import kotlin.io.path.isRegularFile
import kotlin.io.path.readText
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertContains
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * [KotlinRequirementTestsGenerator]: the files it writes for the identity corpus's
 * `worked-example`, that the output COMPILES and behaves (a live test with no witness fails,
 * with one it passes), that author prose cannot break it, every refusal and seam of Table I,
 * and the eject proof (a package-renamed copy emits the same bytes). The tests this
 * generator WRITES are JUnit Jupiter. Which tests exist and what each is called is the
 * identity function's job, which every JVM port shares and a corpus pins: here the emitted
 * test names are compared with that corpus's `witnessKey` values.
 */
@OptIn(org.jetbrains.kotlin.compiler.plugin.ExperimentalCompilerApi::class)
class KotlinRequirementTestsGeneratorTest {

    private val scratch = mutableListOf<Path>()

    @AfterTest
    fun cleanUp() {
        scratch.forEach { it.toFile().deleteRecursively() }
        scratch.clear()
    }

    private fun tempDir(): Path = Files.createTempDirectory("kotlin-requirement-tests-").also { scratch.add(it) }

    // ---------------------------------------------------------------- fixtures

    private fun repoRoot(): Path {
        var p: Path? = Path.of("").toAbsolutePath()
        while (p != null) {
            if (Files.isDirectory(p.resolve("fixtures")) && Files.isDirectory(p.resolve("server"))) return p
            p = p.parent
        }
        throw IllegalStateException("repo root not found")
    }

    private fun corpusCase(name: String): Path =
        repoRoot().resolve("fixtures/requirement-test-identity-conformance/$name")

    private fun workedExampleInput(): Path = corpusCase("worked-example/input")

    private fun loadDir(dir: Path): MetaDataLoader {
        val loader = loadDirectory("requirement_tests_${System.nanoTime()}", dir)
        assertTrue(loader.errors.isEmpty(), "load: ${loader.errors}")
        return loader
    }

    private fun loadYaml(yaml: String): MetaDataLoader {
        val dir = tempDir()
        Files.writeString(dir.resolve("meta.shop.yaml"), yaml)
        return loadDir(dir)
    }

    private fun requirement(
        name: String,
        level: Int,
        status: String,
        statement: String,
        counterexample: String,
        implementedBy: String?,
    ): String =
        "    - requirement.functional:\n" +
            "        name: $name\n        level: $level\n        status: $status\n" +
            "        statement: $statement\n        counterexample: $counterexample\n" +
            (if (implementedBy == null) "" else "        implementedBy: [$implementedBy]\n")

    private val orderEntity =
        "    - object.entity:\n        name: Order\n        children:\n" +
            "          - field.uuid: { name: id }\n          - field.string: { name: total }\n" +
            "          - identity.primary: { name: pk, fields: [id] }\n"

    private fun shop(vararg requirements: String): String =
        "metadata:\n  package: acme::shop\n  children:\n" + orderEntity + requirements.joinToString("")

    private fun generator(out: Path, extra: Map<String, String> = emptyMap()): KotlinRequirementTestsGenerator {
        // The worked example has an L3 requirement the default filter drops, so most tests would
        // log the uncovered warning. Only the tests that are about it switch it on.
        val args = mapOf(
            "outputDir" to out.toString(),
            "testPackage" to TEST_PACKAGE,
            "witnessClass" to WITNESS_CLASS,
            "warnUncovered" to "false",
        ) + extra
        return KotlinRequirementTestsGenerator().also { it.setArgs(args) }
    }

    private fun run(loader: MetaDataLoader, extra: Map<String, String> = emptyMap()): Path {
        val out = tempDir()
        generator(out, extra).execute(loader)
        return out
    }

    private fun read(out: Path, file: String): String = out.resolve("com/acme/req").resolve(file).readText()

    private fun files(out: Path): Set<String> = Files.walk(out).use { s ->
        s.filter { it.isRegularFile() }.map { out.relativize(it).toString().replace('\\', '/') }.toList().toSortedSet()
    }

    private fun testFunctionNames(source: String): List<String> =
        Regex("(?m)^\\s*fun (req_\\w+)\\(").findAll(source).map { it.groupValues[1] }.toList()

    // ---------------------------------------------------------------- compile and run

    private val witnessNone =
        "package com.acme\nclass Witnesses : com.acme.req.Requirements_acme_shop_Witnesses\n"

    private val witnessRecorded =
        "package com.acme\nclass Witnesses : com.acme.req.Requirements_acme_shop_Witnesses {\n" +
            "    override fun req_acme_shop_Orders_Recorded__object_entity() { }\n}\n"

    /** Compile the generated tree plus hand-written sources with the real compiler; return a loader over the classes. */
    private fun compile(generated: Path, handWritten: Map<String, String>): ClassLoader {
        val sources = mutableListOf<SourceFile>()
        Files.walk(generated).use { s ->
            s.filter { it.isRegularFile() && it.toString().endsWith(".kt") }
                .forEach { sources += SourceFile.kotlin(it.fileName.toString(), it.readText()) }
        }
        for ((fqcn, text) in handWritten) sources += SourceFile.kotlin("${fqcn.substringAfterLast('.')}.kt", text)
        val messages = ByteArrayOutputStream()
        val result = KotlinCompilation().apply {
            this.sources = sources
            inheritClassPath = true
            allWarningsAsErrors = true
            messageOutputStream = messages
        }.compile()
        assertEquals(KotlinCompilation.ExitCode.OK, result.exitCode, "generated requirement tests failed to compile:\n${result.messages}")
        return result.classLoader
    }

    /** Invoke one generated test method; returns the AssertionError it threw, or null. */
    private fun invoke(cl: ClassLoader, testClass: String, method: String): AssertionError? {
        val c = cl.loadClass("$TEST_PACKAGE.$testClass")
        val instance = c.getDeclaredConstructor().newInstance()
        val m = c.getDeclaredMethod(method)
        try {
            m.invoke(instance)
            return null
        } catch (e: InvocationTargetException) {
            val cause = e.cause
            if (cause is AssertionError) return cause
            throw e
        }
    }

    // ---------------------------------------------------------------- the worked example

    @Test
    fun `the worked example emits the witness interface and the test class in the test package`() {
        val out = run(loadDir(workedExampleInput()))
        assertEquals(
            sortedSetOf("com/acme/req/Requirements_acme_shop_Test.kt", "com/acme/req/Requirements_acme_shop_Witnesses.kt"),
            files(out),
        )
    }

    @Test
    fun `both files name the witness class in their header`() {
        val out = run(loadDir(workedExampleInput()))
        val iface = read(out, "Requirements_acme_shop_Witnesses.kt")
        val test = read(out, "Requirements_acme_shop_Test.kt")
        assertTrue(
            iface.contains(
                "// Witnesses are project-owned: implement this interface in com.acme.Witnesses" +
                    " and override the members it has witnesses for.\n",
            ),
            iface,
        )
        assertTrue(test.contains("// The witnesses are project-owned, in com.acme.Witnesses.\n"), test)
        assertTrue(iface.startsWith("// GENERATED by metaobjects (requirement-tests). DO NOT EDIT: this file is rewritten whole.\n"), iface)
    }

    @Test
    fun `tests are emitted sorted by id whatever order they are declared in`() {
        // Declared Zeta, Mid, Alpha: not in id order.
        val loader = loadYaml(
            shop(
                requirement("Zeta", 4, "live", "Z.", "Z!", "Order"),
                requirement("Mid", 4, "live", "M.", "M!", "Order"),
                requirement("Alpha", 4, "live", "A.", "A!", "Order"),
            ),
        )
        val out = run(loader)
        for (file in listOf("Requirements_acme_shop_Test.kt", "Requirements_acme_shop_Witnesses.kt")) {
            val src = read(out, file)
            val alpha = src.indexOf("// acme::shop::Alpha [object.entity]")
            val mid = src.indexOf("// acme::shop::Mid [object.entity]")
            val zeta = src.indexOf("// acme::shop::Zeta [object.entity]")
            assertTrue(alpha >= 0 && mid >= 0 && zeta >= 0, "$file: all three present")
            assertTrue(alpha < mid && mid < zeta, "$file: Alpha, Mid, Zeta in that order")
        }
    }

    @Test
    fun `the interface has a member for the live test and none for the skipped one`() {
        val iface = read(run(loadDir(workedExampleInput())), "Requirements_acme_shop_Witnesses.kt")
        assertTrue(iface.contains("    fun req_acme_shop_Orders_Recorded__object_entity() {"), iface)
        assertFalse(iface.contains("req_acme_shop_Orders_Refunded"), iface)
        assertTrue(iface.contains("package com.acme.req\n"), iface)
        assertTrue(iface.contains("interface Requirements_acme_shop_Witnesses {"), iface)
    }

    @Test
    fun `the skipped test is disabled with the Table H reason and has no body`() {
        val test = read(run(loadDir(workedExampleInput())), "Requirements_acme_shop_Test.kt")
        assertTrue(test.contains("@Disabled(\"planned - not built yet\")\n    fun req_acme_shop_Orders_Refunded() {\n    }"), test)
        assertTrue(test.contains("private val witnesses: Requirements_acme_shop_Witnesses = com.acme.Witnesses()"), test)
        assertTrue(test.contains("witnesses.req_acme_shop_Orders_Recorded__object_entity()"), test)
        // The comments above a test: id, statement, counterexample, status, claims, digest.
        assertTrue(
            test.contains(
                "    // acme::shop::Orders.Recorded [object.entity]\n" +
                    "    // An order is recorded when it is placed.\n" +
                    "    // Counterexample: A placed order has no row.\n" +
                    "    // Status: live\n" +
                    "    // Claims: Order  (object.entity)\n" +
                    "    // Digest: 2714aa3925a47959aa5e48ae39d80ed203fd4e2caa046a90aab9e04691d9881a\n",
            ),
            test,
        )
        assertTrue(test.contains("// Claims: (none)"), test)
    }

    @Test
    fun `a retired test says the capability must stay removed`() {
        val loader = loadYaml(shop(requirement("Gone", 4, "retired", "Old thing.", "Old thing returns.", null)))
        val out = run(loader)
        assertTrue(
            read(out, "Requirements_acme_shop_Test.kt")
                .contains("@Disabled(\"retired - the capability was deliberately removed; assert it stays removed\")"),
        )
        // Every test of the package is skipped, so the interface has no member at all.
        assertFalse(read(out, "Requirements_acme_shop_Witnesses.kt").contains("fun "))
    }

    @Test
    fun `the output imports only junit jupiter api and nothing from MetaObjects`() {
        val out = run(loadDir(workedExampleInput()))
        for (file in files(out)) {
            val src = out.resolve(file).readText()
            for (line in src.lines().filter { it.startsWith("import ") }) {
                assertTrue(line.startsWith("import org.junit.jupiter.api."), "$file: $line")
            }
            assertFalse(src.contains("com.metaobjects"), file)
            assertFalse(src.contains("KotlinRequirementTestsGenerator"), "$file names the generator's own class")
        }
    }

    @Test
    fun `output carries the generated marker and is byte identical on a rerun`() {
        val loader = loadDir(workedExampleInput())
        val a = run(loader)
        val b = run(loader)
        for (file in files(a)) {
            val src = a.resolve(file).readText()
            assertTrue(GeneratedFileWriter.looksGenerated(src), file)
            assertEquals(src, b.resolve(file).readText())
        }
    }

    // ---------------------------------------------------------------- the identity contract

    /** The corpus's `witnessKey` values, in the order it lists them (id order). */
    private fun corpusWitnessKeys(case: String): List<String> =
        ObjectMapper().readTree(corpusCase("$case/expected.json").toFile())["tests"].map { it["witnessKey"].asText() }

    @Test
    fun `emitted test names equal the witness keys of the identity corpus worked-example and concern-fanout`() {
        for (case in listOf("worked-example", "concern-fanout")) {
            val expected = corpusWitnessKeys(case)
            assertTrue(expected.isNotEmpty(), "$case lists no test, so this would compare nothing")
            val out = run(loadDir(corpusCase("$case/input")))
            val emitted = files(out).filter { it.endsWith("_Test.kt") }.flatMap { testFunctionNames(out.resolve(it).readText()) }
            assertEquals(expected, emitted, case)
        }
    }

    // ---------------------------------------------------------------- compile and run

    @Test
    fun `a live test with no witness fails naming the counterexample`() {
        val cl = compile(run(loadDir(workedExampleInput())), mapOf(WITNESS_CLASS to witnessNone))
        val e = invoke(cl, "Requirements_acme_shop_Test", "req_acme_shop_Orders_Recorded__object_entity")
        assertNotNull(e, "a live test must fail until a witness is written")
        assertEquals(
            "unimplemented requirement: acme::shop::Orders.Recorded [object.entity] - write com.acme.Witnesses." +
                "req_acme_shop_Orders_Recorded__object_entity() so that it fails when: A placed order has no row.",
            e.message,
        )
    }

    @Test
    fun `a live test passes when the witness class overrides it and a skipped test is disabled and runs empty`() {
        val cl = compile(run(loadDir(workedExampleInput())), mapOf(WITNESS_CLASS to witnessRecorded))
        assertNull(invoke(cl, "Requirements_acme_shop_Test", "req_acme_shop_Orders_Recorded__object_entity"))
        assertNull(invoke(cl, "Requirements_acme_shop_Test", "req_acme_shop_Orders_Refunded"))
        val refunded = cl.loadClass("$TEST_PACKAGE.Requirements_acme_shop_Test").getDeclaredMethod("req_acme_shop_Orders_Refunded")
        assertEquals("planned - not built yet", refunded.getAnnotation(Disabled::class.java).value)
        val recorded = cl.loadClass("$TEST_PACKAGE.Requirements_acme_shop_Test")
            .getDeclaredMethod("req_acme_shop_Orders_Recorded__object_entity")
        assertNull(recorded.getAnnotation(Disabled::class.java))
    }

    // ---------------------------------------------------------------- escaping

    @Test
    fun `a dollar sign in author prose is escaped and does not become a string template`() {
        // `$name` would be a template reference, `${total}` an expression, and a trailing `$` a stray.
        val statement = "\"Charge \$name and \${total} and \$\""
        val counterexample = "\"it breaks \$name \\\"here\\\" at C:\\\\tmp\\nthen \${total} \$\""
        val loader = loadYaml(shop(requirement("Recorded", 4, "live", statement, counterexample, "Order")))
        val out = run(loader)
        val cl = compile(out, mapOf(WITNESS_CLASS to witnessNone))

        val e = invoke(cl, "Requirements_acme_shop_Test", "req_acme_shop_Recorded__object_entity")
        assertNotNull(e)
        assertTrue(
            e.message!!.endsWith("so that it fails when: it breaks \$name \"here\" at C:\\tmp\nthen \${total} \$"),
            e.message,
        )
        val iface = read(out, "Requirements_acme_shop_Witnesses.kt")
        assertContains(iface, "it breaks \\\$name \\\"here\\\" at C:\\\\tmp\\nthen \\\${total} \\\$\")")
    }

    @Test
    fun `quotes backslashes newlines and comment terminators still compile and are carried`() {
        val statement = "\"say \\\"hi\\\" to C:\\\\dir\\nsecond line */ end \\\\u000a not an escape\\rlone cr\""
        val counterexample = "\"it breaks \\\"here\\\" at C:\\\\tmp\\nthen */ and \\\\u000a\""
        val loader = loadYaml(shop(requirement("Recorded", 4, "live", statement, counterexample, "Order")))
        val out = run(loader)
        val cl = compile(out, mapOf(WITNESS_CLASS to witnessNone))

        val e = invoke(cl, "Requirements_acme_shop_Test", "req_acme_shop_Recorded__object_entity")
        assertNotNull(e)
        assertTrue(e.message!!.endsWith("so that it fails when: it breaks \"here\" at C:\\tmp\nthen */ and \\u000a"), e.message)

        val test = read(out, "Requirements_acme_shop_Test.kt")
        assertTrue(test.contains("// say \"hi\" to C:\\dir\n"), test)
        assertTrue(test.contains("    // second line * / end \\u000a not an escape\n"), test)
        assertTrue(test.contains("    // lone cr\n"), test)
        assertTrue(test.contains("    // Counterexample: it breaks \"here\" at C:\\tmp\n    // then * / and \\u000a\n"), test)
    }

    @Test
    fun `carriage returns in a counterexample are escaped in the literal and split in the comment`() {
        // YAML escapes: CR LF, then a lone CR. A raw CR in a string literal would end the line.
        val counterexample = "\"first\\r\\nsecond\\rthird\""
        val loader = loadYaml(shop(requirement("Recorded", 4, "live", "S.", counterexample, "Order")))
        val out = run(loader)

        val iface = read(out, "Requirements_acme_shop_Witnesses.kt")
        val test = read(out, "Requirements_acme_shop_Test.kt")
        assertFalse(iface.indexOf('\r') >= 0 || test.indexOf('\r') >= 0, "no raw CR reaches either file")
        assertTrue(iface.contains("so that it fails when: first\\r\\nsecond\\rthird\")"), iface)
        assertTrue(test.contains("    // Counterexample: first\n    // second\n    // third\n"), test)

        val cl = compile(out, mapOf(WITNESS_CLASS to witnessNone))
        val e = invoke(cl, "Requirements_acme_shop_Test", "req_acme_shop_Recorded__object_entity")
        assertNotNull(e)
        assertTrue(e.message!!.endsWith("so that it fails when: first\r\nsecond\rthird"), e.message)
    }

    // ---------------------------------------------------------------- refusals

    @Test
    fun `two requirements with one witness key are refused naming both and the code`() {
        // A name cannot hold a dot, so Orders.Recorded is a requirement nested under Orders.
        val loader = loadYaml(
            shop(
                requirement("Orders", 3, "live", "P.", "Q.", null) +
                    "        children:\n          - requirement.functional:\n" +
                    "              name: Recorded\n              level: 4\n              status: live\n" +
                    "              statement: A.\n              counterexample: B.\n              implementedBy: [Order]\n",
                requirement("Orders_Recorded", 4, "live", "C.", "D.", "Order"),
            ),
        )
        val e = assertFailsWith<GeneratorException> { run(loader) }
        assertContains(e.message!!, "ERR_REQUIREMENT_WITNESS_KEY_COLLISION")
        assertContains(e.message!!, "acme::shop::Orders.Recorded [object.entity]")
        assertContains(e.message!!, "acme::shop::Orders_Recorded [object.entity]")
    }

    @Test
    fun `an unknown grain is refused with a clear error whatever the model holds`() {
        for (loader in listOf(loadDir(workedExampleInput()), loadYaml(shop()))) {
            val e = assertFailsWith<GeneratorException> { run(loader, mapOf("grain" to "hybrid")) }
            assertContains(e.message!!, "unknown requirement-test grain \"hybrid\"")
            assertContains(e.message!!, "\"concern\" or \"member\"")
        }
    }

    @Test
    fun `a missing witness class or test package is a clear error and writes nothing`() {
        val loader = loadDir(workedExampleInput())
        for (missing in listOf("witnessClass", "testPackage")) {
            val out = tempDir()
            val args = mutableMapOf("outputDir" to out.toString(), "testPackage" to TEST_PACKAGE, "witnessClass" to WITNESS_CLASS)
            args.remove(missing)
            val bare = KotlinRequirementTestsGenerator().also { it.setArgs(args) }
            val e = assertFailsWith<GeneratorException> { bare.execute(loader) }
            assertContains(e.message!!, "'$missing'")
            assertEquals(emptySet(), files(out), "nothing is written when it refuses")
        }
    }

    @Test
    fun `a test package or witness class that is not a Kotlin name is refused rather than spliced into source`() {
        val loader = loadDir(workedExampleInput())
        assertFailsWith<GeneratorException> { run(loader, mapOf("witnessClass" to "com.acme.W(); System.exit(1")) }
        assertFailsWith<GeneratorException> { run(loader, mapOf("testPackage" to "com.acme\nimport x")) }
    }

    @Test
    fun `warnUncovered must be true or false`() {
        val loader = loadDir(workedExampleInput())
        val e = assertFailsWith<GeneratorException> { run(loader, mapOf("warnUncovered" to "flase")) }
        assertContains(e.message!!, "warnUncovered")
    }

    // ---------------------------------------------------------------- grain, filter, renderer

    @Test
    fun `member grain writes one test per resolving reference`() {
        val loader = loadYaml(shop(requirement("Recorded", 4, "live", "S.", "C.", "Order, acme::shop::Order.total")))
        val test = read(run(loader, mapOf("grain" to "member")), "Requirements_acme_shop_Test.kt")
        assertContains(test, "fun req_acme_shop_Recorded__Order()")
        assertContains(test, "fun req_acme_shop_Recorded__acme_shop_Order_total()")
        assertFalse(test.contains("object_entity"), test)
    }

    /** A filter that keeps everything, found by name. Public with a public constructor, as a project's would be. */
    class KeepEverything : RequirementTestFilter {
        override fun include(view: RequirementTestIdentities.View): Boolean = true
    }

    @Test
    fun `a filter class keeps an L3 requirement the default drops and it renders with unit star`() {
        val loader = loadDir(workedExampleInput())
        assertFalse(read(run(loader), "Requirements_acme_shop_Test.kt").contains("req_acme_shop_Orders()"))
        val test = read(run(loader, mapOf("filter" to KeepEverything::class.java.name)), "Requirements_acme_shop_Test.kt")
        assertContains(test, "// acme::shop::Orders [*]")
        assertContains(test, "fun req_acme_shop_Orders()")
    }

    @Test
    fun `a filter class that cannot be loaded is a clear error`() {
        val loader = loadDir(workedExampleInput())
        val e = assertFailsWith<GeneratorException> { run(loader, mapOf("filter" to "com.nowhere.NoSuchFilter")) }
        assertContains(e.message!!, "'filter'")
        assertContains(e.message!!, "com.nowhere.NoSuchFilter")
        assertContains(e.message!!, "not on the project's classpath")
        val notAFilter = assertFailsWith<GeneratorException> { run(loader, mapOf("filter" to "java.lang.String")) }
        assertContains(notAFilter.message!!, "does not implement")
    }

    /** A filter that exists and cannot be used: its static initialiser throws. */
    class ExplodingFilter : RequirementTestFilter {
        override fun include(view: RequirementTestIdentities.View): Boolean = true

        companion object {
            init {
                if (System.nanoTime() != 0L) throw IllegalStateException("boom from the static initialiser")
            }
        }
    }

    @Test
    fun `a filter that is found but fails to link is not reported as missing`() {
        val loader = loadDir(workedExampleInput())
        val e = assertFailsWith<GeneratorException> { run(loader, mapOf("filter" to ExplodingFilter::class.java.name)) }
        assertContains(e.message!!, ExplodingFilter::class.java.name)
        assertContains(e.message!!, "was found but could not be loaded")
        assertFalse(e.message!!.contains("not on the project's classpath"), e.message)
        assertIs<LinkageError>(e.cause, "the error is the cause: ${e.cause}")
        assertIs<IllegalStateException>(e.cause!!.cause)
    }

    /** Records what it is given and replaces the Recorded test. */
    class RecordingRenderer : RequirementTestRenderer {
        override fun render(args: RequirementTestArgs): RenderedTest? {
            SEEN += args
            if (args.identity().path() != "Orders.Recorded") return null
            return RenderedTest(
                listOf("org.junit.jupiter.api.Assertions"),
                "@Test\nfun ${args.identity().witnessKey()}() {\n    Assertions.assertTrue(true, \"digest ${args.identity().digest()}\")\n}",
            )
        }

        companion object {
            val SEEN = mutableListOf<RequirementTestArgs>()
        }
    }

    @Test
    fun `a renderer class replaces one test and receives the digest while the others keep the default`() {
        RecordingRenderer.SEEN.clear()
        val out = run(loadDir(workedExampleInput()), mapOf("renderer" to RecordingRenderer::class.java.name))
        val test = read(out, "Requirements_acme_shop_Test.kt")
        assertContains(test, "import org.junit.jupiter.api.Assertions\n")
        assertContains(test, "    Assertions.assertTrue(true, \"digest 2714aa3925a47959aa5e48ae39d80ed203fd4e2caa046a90aab9e04691d9881a\")")
        assertFalse(test.contains("witnesses.req_acme_shop_Orders_Recorded__object_entity()"), "the replaced test lost its default body")
        assertContains(test, "@Disabled(\"planned - not built yet\")")

        assertEquals(2, RecordingRenderer.SEEN.size)
        val recorded = RecordingRenderer.SEEN.first { it.identity().path() == "Orders.Recorded" }
        assertEquals("An order is recorded when it is placed.", recorded.statement())
        assertEquals("A placed order has no row.", recorded.counterexample())
        assertEquals("Order", recorded.targets()[0].ref())
        assertEquals("object.entity", recorded.targets()[0].concern())
        assertEquals("2714aa3925a47959aa5e48ae39d80ed203fd4e2caa046a90aab9e04691d9881a", recorded.identity().digest())
    }

    // ---------------------------------------------------------------- the uncovered warning

    @Test
    fun `excluded requirements produce one capped warning and warnUncovered false silences it`() {
        val reqs = (1..7).map { requirement("Area$it", 3, "live", "S.", "C.", null) } +
            requirement("Recorded", 4, "live", "S.", "C.", "Order")
        val loader = loadYaml(shop(*reqs.toTypedArray()))

        val gen = generator(tempDir(), mapOf("warnUncovered" to "true"))
        gen.execute(loader)
        // Table A: diagnostics name the PATH, never the package-qualified address, so the same
        // model gives the same names in every port.
        assertEquals(
            listOf(
                "7 requirement(s) matched no filter and get no test. If that is deliberate, set " +
                    "warnUncovered=false to silence this. Uncovered: Area1, Area2, Area3, Area4, Area5, and 2 more.",
            ),
            gen.warnings(),
        )

        val quiet = generator(tempDir(), mapOf("warnUncovered" to "false"))
        quiet.execute(loader)
        assertEquals(emptyList(), quiet.warnings())
    }

    @Test
    fun `five or fewer excluded requirements are all named and there is no and-more tail`() {
        val reqs = (1..2).map { requirement("Area$it", 3, "live", "S.", "C.", null) } +
            requirement("Recorded", 4, "live", "S.", "C.", "Order")
        val gen = generator(tempDir(), mapOf("warnUncovered" to "true"))
        gen.execute(loadYaml(shop(*reqs.toTypedArray())))
        assertEquals(
            listOf(
                "2 requirement(s) matched no filter and get no test. If that is deliberate, set " +
                    "warnUncovered=false to silence this. Uncovered: Area1, Area2.",
            ),
            gen.warnings(),
        )
    }

    // ---------------------------------------------------------------- nothing declared, nothing changes

    @Test
    fun `a model with no requirement writes nothing and warns nothing even without the required args`() {
        val out = tempDir()
        val gen = KotlinRequirementTestsGenerator().also { it.setArgs(mapOf("outputDir" to out.toString())) }
        gen.execute(loadYaml(shop()))
        assertEquals(emptySet(), files(out))
        assertEquals(emptyList(), gen.warnings())
    }

    // ---------------------------------------------------------------- stale files

    @Test
    fun `stale file - gen never removes the files of a package that lost its last requirement and verify reports them stale in repo`() {
        val billing = "metadata:\n  package: acme::billing\n  children:\n" +
            "    - object.entity:\n        name: Invoice\n        children:\n" +
            "          - field.uuid: { name: id }\n          - identity.primary: { name: pk, fields: [id] }\n" +
            requirement("Billed", 4, "live", "S.", "C.", "Invoice")
        val dir = tempDir()
        Files.writeString(dir.resolve("meta.billing.yaml"), billing)
        Files.writeString(dir.resolve("meta.shop.yaml"), shop(requirement("Recorded", 4, "live", "S.", "C.", "Order")))

        val out = tempDir()
        generator(out).execute(loadDir(dir))
        val both = sortedSetOf(
            "com/acme/req/Requirements_acme_billing_Test.kt", "com/acme/req/Requirements_acme_billing_Witnesses.kt",
            "com/acme/req/Requirements_acme_shop_Test.kt", "com/acme/req/Requirements_acme_shop_Witnesses.kt",
        )
        assertEquals(both, files(out))

        // The billing package loses its requirement.
        Files.writeString(dir.resolve("meta.billing.yaml"), billing.substring(0, billing.indexOf("    - requirement.functional")))
        generator(out).execute(loadDir(dir))

        // What gen does, as for every JVM generator: it does not delete. The files stay, and
        // `mvn metaobjects:verify` then reports each as [stale-in-repo] (its codegen-drift goal,
        // exercised in the maven-plugin module).
        assertEquals(both, files(out))
    }

    // ---------------------------------------------------------------- project class loader

    @Test
    fun `a filter only the project class loader can see is found once the loader is injected`() {
        // Compiled into a loader that is on no ambient class path: the packaged generator's own
        // loader cannot see it, exactly as the plugin's cannot see a project class.
        val result = KotlinCompilation().apply {
            sources = listOf(
                SourceFile.kotlin(
                    "ProjectOnlyFilter.kt",
                    "package com.acme\nclass ProjectOnlyFilter : com.metaobjects.requirement.RequirementTestFilter {\n" +
                        "    override fun include(view: com.metaobjects.requirement.RequirementTestIdentities.View): Boolean = true\n}\n",
                ),
            )
            inheritClassPath = true
        }.compile()
        assertEquals(KotlinCompilation.ExitCode.OK, result.exitCode, result.messages)

        val loader = loadDir(workedExampleInput())
        val args = mapOf("filter" to "com.acme.ProjectOnlyFilter")
        val e = assertFailsWith<GeneratorException> { run(loader, args) }
        assertContains(e.message!!, "com.acme.ProjectOnlyFilter")

        val out = tempDir()
        val gen = generator(out, args)
        gen.setProjectClassLoader(result.classLoader)
        gen.execute(loader)
        assertContains(read(out, "Requirements_acme_shop_Test.kt"), "// acme::shop::Orders [*]")
    }

    // ---------------------------------------------------------------- eject

    private val packageLine = Regex("(?m)^package\\s+[\\w.]+\\s*$")

    @Test
    fun `a package-renamed copy of the generator emits the same bytes as the packaged one`() {
        // The copy is exactly what `mvn metaobjects:eject` writes: this one source file with its
        // package line replaced. The args are NOT the defaults (member grain, another test
        // package), so a copy that read a default instead of its arg, or that carried the
        // generator's own package or class name into its output, would differ.
        val original = Path.of("src/main/kotlin/com/metaobjects/generator/kotlin/KotlinRequirementTestsGenerator.kt")
        val source = original.readText()
        val match = assertNotNull(packageLine.find(source), "expected a package line")
        val rewritten = source.replaceRange(match.range, "package com.acme.owned")
        assertTrue(rewritten.contains("package com.acme.owned"))

        val result = KotlinCompilation().apply {
            sources = listOf(SourceFile.kotlin("KotlinRequirementTestsGenerator.kt", rewritten))
            inheritClassPath = true
            messageOutputStream = ByteArrayOutputStream()
        }.compile()
        assertEquals(KotlinCompilation.ExitCode.OK, result.exitCode, result.messages)
        val owned = result.classLoader.loadClass("com.acme.owned.KotlinRequirementTestsGenerator")
            .getDeclaredConstructor().newInstance() as Generator

        val args = mapOf(
            "testPackage" to "com.example.requirements",
            "witnessClass" to "com.example.Witnesses",
            "grain" to "member",
            "warnUncovered" to "false",
        )
        val loader = loadDir(workedExampleInput())
        val packagedOut = tempDir()
        KotlinRequirementTestsGenerator().also { it.setArgs(args + ("outputDir" to packagedOut.toString())) }.execute(loader)
        val ownedOut = tempDir()
        owned.setArgs(args + ("outputDir" to ownedOut.toString())).execute(loader)

        val expectedFiles = sortedSetOf(
            "com/example/requirements/Requirements_acme_shop_Test.kt",
            "com/example/requirements/Requirements_acme_shop_Witnesses.kt",
        )
        assertEquals(expectedFiles, files(packagedOut))
        assertEquals(expectedFiles, files(ownedOut), "same set of generated files")
        for (rel in expectedFiles) {
            val text = packagedOut.resolve(rel).readText()
            assertEquals(text, ownedOut.resolve(rel).readText(), "content differs for $rel")
            assertFalse(text.contains("com.acme.owned") || text.contains("KotlinRequirementTestsGenerator"), "$rel names the generator")
        }
        // member grain, not the default: the unit is the reference as authored.
        assertContains(ownedOut.resolve("com/example/requirements/Requirements_acme_shop_Test.kt").readText(), "req_acme_shop_Orders_Recorded__Order()")
    }

    @Test
    fun `requirement-tests is registered and ejectable`() {
        val info = GENERATOR_REGISTRY.getValue("requirement-tests")
        assertEquals("META-INF/metaobjects/reference/kotlin/KotlinRequirementTestsGenerator.kt", info.ejectResourcePath)
        assertIs<KotlinRequirementTestsGenerator>(info.factory())
        assertEquals(GeneratorLayer.CAPABILITY, info.layer)
    }

    private companion object {
        const val TEST_PACKAGE = "com.acme.req"
        const val WITNESS_CLASS = "com.acme.Witnesses"
    }
}

package com.metaobjects.generator.kotlin

import com.fasterxml.jackson.databind.ObjectMapper
import com.metaobjects.generator.GeneratorBase
import com.metaobjects.loader.MetaDataLoader
import com.metaobjects.metadata.ktx.loadString
import com.tschuchort.compiletesting.KotlinCompilation
import com.tschuchort.compiletesting.SourceFile
import java.nio.file.Files
import java.nio.file.Path
import kotlin.io.path.isRegularFile
import kotlin.io.path.readText
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Upgrade proof for an OWNED generator: a Kotlin generator an adopter ejected BEFORE the
 * helper signatures gained a `ProvidedEnumConfig` parameter still compiles, unchanged, against
 * this module, and still generates.
 *
 * [EjectedGeneratorsCompileTest] cannot show this: it compiles the CURRENT sources, which are
 * edited in the same commit as the helpers they call. An adopter's copy is not.
 *
 * The frozen copies live in `src/test/resources/ejected-at-base/<Name>.kt.txt` (the `.txt`
 * suffix keeps the build from compiling them as test sources). Each is the verbatim output of
 * `git show <commit>:<path>` for the commit the provided-enum-config change was built on, with
 * nothing added, so it is exactly what `mvn metaobjects:eject` wrote into an adopter's repo at
 * that point. They cover every ejectable generator whose source that change touched; the rest
 * are byte-identical to the current sources [EjectedGeneratorsCompileTest] compiles.
 *
 * Refresh them ONLY when a release note tells adopters to re-eject: until then, a copy that
 * stops compiling here is an adopter's build that stops compiling on upgrade.
 *
 * Refreshed once, in 1.3.0: KotlinPoet left the build, and the entity, Exposed table, Spring
 * controller and relations generators named its types (`ClassName`, `TypeName`) through the
 * helpers they call, so a copy ejected before then cannot compile against this module. The
 * 1.3.0 release note tells adopters who own one of those four to re-eject it, and those four
 * copies, with the classes eject copies beside them (`ejectWith`), are now what
 * `mvn metaobjects:eject` writes at 1.3.0. The output-parser and render-helper copies never
 * named a KotlinPoet type and are still the originals.
 */
@OptIn(org.jetbrains.kotlin.compiler.plugin.ExperimentalCompilerApi::class)
class EjectedAtBaseGeneratorsCompatTest {

    private companion object {
        const val OWNED_PACKAGE = "com.acme.owned"
        const val PROVIDED_NAMESPACE = "com.acme.ext"

        val frozenSimpleNames = listOf(
            "KotlinEntityGenerator",
            "KotlinExposedTableGenerator",
            "KotlinSpringControllerGenerator",
            "KotlinRelationsGenerator",
            "KotlinOutputParserGenerator",
            "KotlinRenderHelperGenerator",
            // Copied with the four generators refreshed in 1.3.0 (their `ejectWith` classes), as
            // `mvn metaobjects:eject` writes them beside the generator in the owned package.
            "KotlinEnumEmitter",
            "KotlinDecimalWireEmitter",
            "KotlinCrossFieldRules",
            "KotlinDurationWireEmitter",
            "KotlinValidationIssuesEmitter",
            "KotlinUnknownBodyKeysEmitter",
        )

        val packageLine = Regex("(?m)^package\\s+[\\w.]+\\s*$")

        /** The frozen copies, package-renamed exactly as eject does, compiled once for the class. */
        val compiledFrozen: KotlinCompilation.Result by lazy {
            val dir = Path.of("src/test/resources/ejected-at-base")
            val sources = frozenSimpleNames.map { simpleName ->
                val frozen = dir.resolve("$simpleName.kt.txt")
                assertTrue(Files.exists(frozen), "expected ${frozen.toAbsolutePath()} to exist")
                val source = Files.readString(frozen)
                val match = packageLine.find(source) ?: throw AssertionError("expected a package line in $frozen")
                SourceFile.kotlin("$simpleName.kt", source.replaceRange(match.range, "package $OWNED_PACKAGE"))
            }
            KotlinCompilation().apply {
                this.sources = sources
                inheritClassPath = true
                messageOutputStream = System.out
            }.compile()
        }
    }

    private fun fixtureDir(): Path =
        Path.of(System.getProperty("user.dir")).resolve("../../..").normalize()
            .resolve("fixtures/codegen-conformance/shared-provided-enum")

    private fun loadFixture(): MetaDataLoader =
        loadString("ejectedAtBaseCompat", Files.readString(fixtureDir().resolve("input/meta.json")))

    /** Run the frozen copy of [simpleName] on the shared fixture, as an adopter's build would. */
    private fun generate(simpleName: String, args: Map<String, String>): Path {
        assertEquals(KotlinCompilation.ExitCode.OK, compiledFrozen.exitCode, compiledFrozen.messages)
        val generator = compiledFrozen.classLoader.loadClass("$OWNED_PACKAGE.$simpleName")
            .getDeclaredConstructor().newInstance() as GeneratorBase
        val out = Files.createTempDirectory("kgen-ejected-at-base-")
        generator.setArgs(args + ("outputDir" to out.toString()))
        generator.execute(loadFixture())
        return out
    }

    private fun sourcesUnder(dir: Path): List<Path> =
        Files.walk(dir).use { walk -> walk.filter { it.isRegularFile() }.sorted().toList() }

    private fun compileGenerated(generated: List<Path>, vararg standIns: SourceFile): KotlinCompilation.Result {
        val result = KotlinCompilation().apply {
            sources = generated.mapIndexed { i, path -> SourceFile.kotlin("g${i}_${path.fileName}", path.readText()) } +
                standIns
            inheritClassPath = true
            messageOutputStream = System.out
        }.compile()
        assertEquals(KotlinCompilation.ExitCode.OK, result.exitCode, result.messages)
        return result
    }

    private fun providedCurrencyIn(pkg: String): SourceFile =
        SourceFile.kotlin("Currency_${pkg.replace('.', '_')}.kt", "package $pkg\n\nenum class Currency { USD, EUR, GBP }\n")

    @Test
    fun `every generator ejected before the provided-enum config still compiles unchanged`() {
        assertEquals(KotlinCompilation.ExitCode.OK, compiledFrozen.exitCode,
            "a generator ejected before this change no longer compiles against this module:\n${compiledFrozen.messages}")
    }

    /**
     * The oracle is the cross-port decision table `expected-enum-types.json`: which shared
     * declaration every enum field of the fixture resolves to. An owned entity generator gets
     * that answer through the helpers it calls, so a multi-hop field with no redeclaration is
     * typed by the shared enum without the adopter touching the copy. A copy still on the
     * one-hop rule would type `Task.importance` by a per-object `TaskImportance`.
     */
    @Test
    fun `the entity generator ejected at base types every field by the decision table`() {
        val out = generate("KotlinEntityGenerator", mapOf("providedEnumNamespace" to PROVIDED_NAMESPACE))
        try {
            val classes = compileGenerated(sourcesUnder(out), providedCurrencyIn(PROVIDED_NAMESPACE)).classLoader
            val table = ObjectMapper().readTree(Files.readString(fixtureDir().resolve("expected-enum-types.json")))
            val sharedClassNames = setOf("acme.shop.Priority", "acme.shop.Money", "$PROVIDED_NAMESPACE.Currency")
            var sharedFields = 0
            for ((key, expected) in table.get("fields").fields()) {
                val (ownerFqn, field) = key.split(".").let { it[0] to it[1] }
                val ownerClass = classes.loadClass(ownerFqn.replace("::", "."))
                val actual = ownerClass.getMethod("get" + field.replaceFirstChar { it.uppercase() }).returnType.name
                val shared = expected.get("shared")
                if (shared.isNull) {
                    assertFalse(actual in sharedClassNames, "$key is an inline enum; was typed $actual")
                    continue
                }
                val declarationShort = shared.asText().substringAfterLast("::")
                val expectedClass =
                    if (expected.get("provided").asBoolean()) "$PROVIDED_NAMESPACE.$declarationShort"
                    else "acme.shop.$declarationShort"
                assertEquals(expectedClass, actual, "$key must be typed by the shared declaration ${shared.asText()}")
                sharedFields++
            }
            assertTrue(sharedFields > 0, "the decision table named no shared field")
            assertFalse(Files.exists(out.resolve("acme/shop/Currency.kt")), "a @provided enum must not be generated")
        } finally {
            out.toFile().deleteRecursively()
        }
    }

    /**
     * A table generator ejected at 1.3.0 reads the same provided-enum config as the entity
     * generator, so its columns are typed by the class the entity property uses: a `@provided`
     * enum by the configured namespace's class, a shared one by its declaration. The output
     * compiling against those classes, and the column types naming them, is the proof.
     *
     * (The copy this replaced predated that config and took no provided-enum args; it named
     * KotlinPoet types, so it was refreshed in 1.3.0 with the rest — see the class doc.)
     */
    @Test
    fun `the Exposed table generator ejected at base still generates for a provided enum`() {
        val args = mapOf("providedEnumNamespace" to PROVIDED_NAMESPACE)
        val entityOut = generate("KotlinEntityGenerator", args)
        val tableOut = generate("KotlinExposedTableGenerator", args)
        try {
            val classes = compileGenerated(
                sourcesUnder(entityOut) + sourcesUnder(tableOut),
                providedCurrencyIn(PROVIDED_NAMESPACE),
            ).classLoader
            for ((tableClass, column) in listOf("acme.shop.TicketTable" to "getCurrency", "acme.shop.RefundTable" to "getTender")) {
                val columnType = classes.loadClass(tableClass).getMethod(column).genericReturnType.typeName
                assertTrue("$PROVIDED_NAMESPACE.Currency" in columnType,
                    "$tableClass.$column must be a column of the provided $PROVIDED_NAMESPACE.Currency; was $columnType")
            }
            val importance = classes.loadClass("acme.shop.TaskTable").getMethod("getImportance").genericReturnType.typeName
            assertTrue("acme.shop.Priority" in importance,
                "TaskTable.importance (two hops) must be a column of the shared Priority; was $importance")
        } finally {
            entityOut.toFile().deleteRecursively()
            tableOut.toFile().deleteRecursively()
        }
    }
}

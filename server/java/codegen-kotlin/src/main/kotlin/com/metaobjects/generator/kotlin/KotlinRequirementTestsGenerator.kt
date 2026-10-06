package com.metaobjects.generator.kotlin

import com.metaobjects.generator.FileEmittingGenerator
import com.metaobjects.generator.FileEmittingGenerator.EmittedFile
import com.metaobjects.generator.GeneratorException
import com.metaobjects.generator.ProjectClassLoaderAware
import com.metaobjects.generator.requirement.RequirementTestArgs
import com.metaobjects.generator.requirement.RequirementTestRenderer
import com.metaobjects.loader.MetaDataLoader
import com.metaobjects.requirement.MetaRequirement
import com.metaobjects.requirement.RequirementTestFilter
import com.metaobjects.requirement.RequirementTestIdentities
import com.metaobjects.requirement.RequirementTestIdentities.Grain
import com.metaobjects.requirement.RequirementTestIdentities.Identity
import com.metaobjects.requirement.RequirementTestIdentities.Target
import org.slf4j.LoggerFactory
import java.lang.reflect.InvocationTargetException
import java.util.TreeMap
import java.util.TreeSet

/**
 * One JUnit Jupiter test per declared requirement, written in Kotlin, calling a project-owned
 * witness (ADR-0057). The Kotlin sibling of the JVM `JUnitRequirementTestsGenerator`.
 *
 * For each metamodel package that holds a tested requirement this writes two files into
 * `testPackage`, rewritten whole on every run: `Requirements_<pkgKey>_Witnesses.kt` (an
 * interface with one default member per NON-skipped test, which fails with
 * `unimplemented requirement: ...`) and `Requirements_<pkgKey>_Test.kt` (one `@Test` per
 * requirement, calling the member on the project's `witnessClass`). The project owns the
 * witnesses: it writes a class implementing every generated witness interface and overrides
 * the members it has witnesses for. A requirement that becomes live adds a failing member, a
 * red test and no compile break; one that is retired or deleted removes the member, so a
 * stale override stops compiling.
 *
 * Which tests exist, what each is called, whether it is skipped and its digest come from
 * [RequirementTestIdentities], which every language port shares and a conformance corpus
 * pins. This class decides only how they are WRITTEN. It is a reference helper
 * (ADR-0034 Amendment 3): `mvn metaobjects:eject` copies this one file into your project,
 * and the default rendering is in it, so an owned copy changes the output freely.
 *
 * Args: `outputDir`, `testPackage` and `witnessClass` (the last two required once the model
 * holds a requirement), `grain` (`concern`, the default, or `member`), `filter` (a
 * [RequirementTestFilter] class name that REPLACES the default of functional requirements at
 * level 4 or above), `renderer` (a [RequirementTestRenderer] class name; for this generator
 * the source it returns is Kotlin and its imports are Kotlin import names), and
 * `warnUncovered` (`true` by default: name the requirements the filter excluded).
 *
 * The generated tests are JUnit Jupiter; the project's test classpath needs
 * `org.junit.jupiter:junit-jupiter-api`. They import nothing from MetaObjects.
 */
open class KotlinRequirementTestsGenerator : FileEmittingGenerator(), ProjectClassLoaderAware {

    private var projectClassLoader: ClassLoader? = null
    private val warningLog = mutableListOf<String>()

    override fun setProjectClassLoader(projectClassLoader: ClassLoader) {
        this.projectClassLoader = projectClassLoader
    }

    /** What the last run warned about (each message was also logged). */
    fun warnings(): List<String> = warningLog.toList()

    /** One test to write: its identity and the data its rendering is built from. */
    private class Planned(val identity: Identity, val args: RequirementTestArgs)

    override fun generate(loader: MetaDataLoader): List<EmittedFile> {
        warningLog.clear()
        // The optional args are checked first, so a typo is refused whatever the model holds.
        val grain = grain()
        val filter = loadOptional(ARG_FILTER, RequirementTestFilter::class.java)
        val renderer = loadOptional(ARG_RENDERER, RequirementTestRenderer::class.java)
        val warnUncovered = warnUncovered()

        val walked = RequirementTestIdentities.walk(loader.root)
        // No requirement, no change: nothing is written and nothing is said.
        if (walked.isEmpty()) return emptyList()

        val testPackage = requiredName(ARG_TEST_PACKAGE)
        val witnessClass = requiredName(ARG_WITNESS_CLASS)

        val planned = mutableListOf<Planned>()
        val uncovered = mutableListOf<String>()
        for (w in walked) {
            val keep = filter?.include(w.view()) ?: RequirementTestIdentities.defaultFilter(w.view())
            if (!keep) {
                // The PATH, not the qualified address: diagnostics name paths, in every port.
                uncovered += w.view().path()
                continue
            }
            for ((unit, targets) in RequirementTestIdentities.units(w, grain)) {
                val identity = RequirementTestIdentities.identity(w, unit)
                planned += Planned(identity, argsFor(w.node(), identity, targets))
            }
        }
        planned.sortBy { it.identity.id() }
        refuseCollisions(planned)
        warnUncovered(uncovered, warnUncovered)

        // One pair of files per package key. Two packages that mangle alike share a pair: their
        // tests keep distinct keys, which the collision check above has just proven.
        val byPackage = TreeMap<String, MutableList<Planned>>()
        for (p in planned) byPackage.getOrPut(packageKey(p.identity.pkg())) { mutableListOf() } += p

        val dir = testPackage.replace('.', '/') + "/"
        val files = mutableListOf<EmittedFile>()
        for ((key, tests) in byPackage) {
            val witnesses = "Requirements_${key}_Witnesses"
            val test = "Requirements_${key}_Test"
            files += EmittedFile("$dir$witnesses.kt", witnessInterface(testPackage, witnesses, witnessClass, tests))
            files += EmittedFile("$dir$test.kt", testClass(testPackage, test, witnesses, witnessClass, tests, renderer))
        }
        return files
    }

    // ------------------------------------------------------------------
    // args
    // ------------------------------------------------------------------

    private fun grain(): Grain {
        if (!hasArg(ARG_GRAIN)) return Grain.CONCERN
        try {
            return Grain.parse(getArg(ARG_GRAIN))
        } catch (e: IllegalArgumentException) {
            throw GeneratorException("requirement-tests: arg '$ARG_GRAIN': ${e.message}", e)
        }
    }

    private fun warnUncovered(): Boolean {
        val raw = getArg(ARG_WARN_UNCOVERED, "true")
        if (raw.equals("true", ignoreCase = true)) return true
        if (raw.equals("false", ignoreCase = true)) return false
        throw GeneratorException("requirement-tests: arg '$ARG_WARN_UNCOVERED' must be true or false, not '$raw'")
    }

    /** A required arg that is spliced into generated source, so it must be a dotted Kotlin name. */
    private fun requiredName(arg: String): String {
        val value = getArg(arg)
        if (value.isNullOrBlank()) {
            throw GeneratorException(
                "requirement-tests: set '$arg' with <args><$arg>...</$arg></args>" +
                    (if (arg == ARG_WITNESS_CLASS) " (the fully-qualified name of the project class that implements the generated witness interfaces)" else "") +
                    (if (arg == ARG_TEST_PACKAGE) " (the package the generated tests are written into)" else ""),
            )
        }
        val name = value.trim()
        if (!KOTLIN_NAME.matches(name)) {
            throw GeneratorException("requirement-tests: arg '$arg' must be a dotted Kotlin name (letters, digits and underscores), not '$value'")
        }
        return name
    }

    /**
     * Instantiate the class an optional arg names, or `null` when the arg is absent. The
     * project's class loader is tried first because a packaged generator's own loader cannot
     * see the project's classes, then the context loader, then this class's own.
     */
    private fun <T> loadOptional(arg: String, type: Class<T>): T? {
        val className = getArg(arg)?.trim()
        if (className.isNullOrEmpty()) return null

        val loaders = listOfNotNull(
            projectClassLoader,
            Thread.currentThread().contextClassLoader,
            javaClass.classLoader,
        ).distinct()
        var found: Class<*>? = null
        for (l in loaders) {
            try {
                found = Class.forName(className, true, l)
                break
            } catch (ignored: ClassNotFoundException) {
                // not in this loader: try the next
            } catch (e: LinkageError) {
                // The class IS here and cannot be used (built for a newer JDK, a missing
                // dependency, an initialiser that threw): saying it is missing would send the
                // reader looking for the wrong problem, and the next loader would hide it.
                throw GeneratorException(
                    "requirement-tests: arg '$arg' names '$className', which was found but could not be loaded: $e",
                    null, null, e, emptyMap(),
                )
            }
        }
        if (found == null) {
            throw GeneratorException(
                "requirement-tests: arg '$arg' names '$className', which is not on the project's classpath. " +
                    "Name a public class implementing ${type.simpleName} from a module the build compiles before this goal runs.",
            )
        }
        if (!type.isAssignableFrom(found)) {
            throw GeneratorException("requirement-tests: arg '$arg' names '$className', which does not implement ${type.name}")
        }
        try {
            return type.cast(found.getDeclaredConstructor().newInstance())
        } catch (e: InvocationTargetException) {
            // The class HAS the constructor, and it ran and threw. The wrapper's own message is
            // empty, so name what was thrown: "needs a constructor" would point at the wrong problem.
            val thrown = e.cause ?: e
            throw GeneratorException(
                "requirement-tests: arg '$arg' names '$className', and its constructor threw: $thrown",
                null, null, thrown, emptyMap(),
            )
        } catch (e: ReflectiveOperationException) {
            throw GeneratorException("requirement-tests: arg '$arg' names '$className', which needs a public no-argument constructor: $e", e)
        }
    }

    // ------------------------------------------------------------------
    // planning
    // ------------------------------------------------------------------

    private fun argsFor(node: MetaRequirement, identity: Identity, targets: List<Target>): RequirementTestArgs =
        RequirementTestArgs(
            identity, node.statement.orEmpty(), node.counterexample.orEmpty(),
            targets.map { RequirementTestArgs.Claim(it.ref(), it.concern()) },
            node.disposition, node.trackedBy,
        )

    /** `root` for the empty package, otherwise the package with each run of non-ASCII-alphanumerics as one underscore. */
    private fun packageKey(pkg: String): String = if (pkg.isEmpty()) "root" else pkg.replace(Regex("[^A-Za-z0-9]+"), "_")

    /** Two tests with one witness key cannot be told apart by a witness: refuse, naming both. */
    private fun refuseCollisions(planned: List<Planned>) {
        val keyById = planned.associate { it.identity.id() to it.identity.witnessKey() }
        val pairs = RequirementTestIdentities.witnessKeyCollisions(planned.map { it.identity })
        if (pairs.isEmpty()) return
        val sb = StringBuilder(ERR_WITNESS_KEY_COLLISION)
            .append(": two requirement tests map to one witness key, so one witness could not serve both. ")
            .append("Rename one so the names differ in more than punctuation:")
        for (pair in pairs) {
            sb.append("\n  '").append(pair[0]).append("' and '").append(pair[1])
                .append("' (witness key ").append(keyById[pair[0]]).append(')')
        }
        throw GeneratorException(sb.toString())
    }

    private fun warnUncovered(uncovered: List<String>, enabled: Boolean) {
        if (!enabled || uncovered.isEmpty()) return
        val shown = uncovered.take(MAX_NAMED_UNCOVERED).joinToString(", ")
        val more = if (uncovered.size > MAX_NAMED_UNCOVERED) ", and ${uncovered.size - MAX_NAMED_UNCOVERED} more" else ""
        val message = "${uncovered.size} requirement(s) matched no filter and get no test. " +
            "If that is deliberate, set $ARG_WARN_UNCOVERED=false to silence this. Uncovered: $shown$more."
        warningLog += message
        LOG.warn(message)
    }

    // ------------------------------------------------------------------
    // rendering: the default rendering lives here, in this one file, so an eject takes it too
    // ------------------------------------------------------------------

    private fun witnessInterface(testPackage: String, name: String, witnessClass: String, tests: List<Planned>): String {
        val sb = StringBuilder(GENERATED_HEADER)
            .append("// Witnesses are project-owned: implement this interface in ").append(commentText(witnessClass))
            .append(" and override the members it has witnesses for.\n")
            .append("package ").append(sourceName(testPackage)).append("\n\n")
            .append("interface ").append(name).append(" {\n")
        for (p in tests) {
            val id = p.identity
            if (id.skip() != null) continue // a skipped test claims nothing works yet: no member
            sb.append('\n').append(indent(testComments(p.args))).append('\n')
                .append("    fun ").append(id.witnessKey()).append("() {\n")
                .append("        throw AssertionError(\"")
                .append(
                    stringLiteral(
                        "unimplemented requirement: ${id.id()} - write $witnessClass.${id.witnessKey()}() " +
                            "so that it fails when: ${p.args.counterexample()}",
                    ),
                )
                .append("\")\n    }\n")
        }
        return sb.append("}\n").toString()
    }

    private fun testClass(
        testPackage: String,
        name: String,
        witnesses: String,
        witnessClass: String,
        tests: List<Planned>,
        renderer: RequirementTestRenderer?,
    ): String {
        val imports = TreeSet<String>()
        imports += "org.junit.jupiter.api.Test"
        val body = StringBuilder()
        for (p in tests) {
            val rendered = renderer?.render(p.args)
            val source: String
            if (rendered != null) {
                imports += rendered.imports()
                source = rendered.source()
            } else {
                source = defaultTest(p)
                if (p.identity.skip() != null) imports += "org.junit.jupiter.api.Disabled"
            }
            body.append('\n').append(indent(source.trimEnd())).append('\n')
        }
        val sb = StringBuilder(GENERATED_HEADER)
            .append("// The witnesses are project-owned, in ").append(commentText(witnessClass)).append(".\n")
            .append("package ").append(sourceName(testPackage)).append("\n\n")
        for (i in imports) sb.append("import ").append(i).append('\n')
        return sb.append("\nclass ").append(name).append(" {\n\n")
            .append("    private val witnesses: ").append(witnesses).append(" = ").append(sourceName(witnessClass)).append("()\n")
            .append(body).append("}\n").toString()
    }

    /** The default rendering of one test: its comments, then a `@Test` calling the witness. */
    private fun defaultTest(p: Planned): String {
        val id = p.identity
        val sb = StringBuilder(testComments(p.args)).append("\n@Test\n")
        if (id.skip() == null) {
            sb.append("fun ").append(id.witnessKey()).append("() {\n    witnesses.").append(id.witnessKey()).append("()\n}")
        } else {
            sb.append("@Disabled(\"").append(stringLiteral(skipReason(id.skip()))).append("\")\n")
                .append("fun ").append(id.witnessKey()).append("() {\n}")
        }
        return sb.toString()
    }

    private fun skipReason(skip: String): String = when (skip) {
        MetaRequirement.STATUS_PLANNED -> SKIP_PLANNED
        MetaRequirement.STATUS_RETIRED -> SKIP_RETIRED
        else -> "$skip - skipped"
    }

    /** The comment block above a test: id, statement, counterexample, status, claims, digest. */
    private fun testComments(a: RequirementTestArgs): String {
        val id = a.identity()
        val claims = a.targets().joinToString(", ") { "${it.ref()}  (${it.concern()})" }
        return commentLines(id.id()) + "\n" +
            commentLines(a.statement()) + "\n" +
            commentLines("Counterexample: " + a.counterexample()) + "\n" +
            commentLines("Status: " + (id.status() ?: "(none)")) + "\n" +
            commentLines("Claims: " + claims.ifEmpty { "(none)" }) + "\n" +
            commentLines("Digest: " + id.digest())
    }

    // ------------------------------------------------------------------
    // escaping: author prose lands in string literals and comments, and must not break either
    // ------------------------------------------------------------------

    /**
     * A dotted name as it is written in Kotlin source: a segment that is a hard keyword (`in`,
     * `is` and `as` are real country-code prefixes in a reversed domain) is wrapped in
     * backticks, since `package in.co.acme` does not parse. The file's directory and every
     * comment and message keep the plain name.
     */
    private fun sourceName(dotted: String): String =
        dotted.split('.').joinToString(".") { if (it in HARD_KEYWORDS) "`$it`" else it }

    private fun indent(block: String): String {
        val sb = StringBuilder()
        for (line in block.split("\n")) {
            if (sb.isNotEmpty()) sb.append('\n')
            if (line.isNotEmpty()) sb.append("    ").append(line)
        }
        return sb.toString()
    }

    /**
     * One `//` marker per line. A carriage return ends a Kotlin line as a line feed does, so
     * both split; the comment terminator is broken as `* /` by contract.
     */
    private fun commentLines(text: String): String =
        text.split(Regex("\r\n|\r|\n")).joinToString("\n") { "// " + commentText(it) }

    private fun commentText(line: String): String = line.replace("*/", "* /")

    /**
     * The text of a double-quoted string literal. Every control character is escaped, so no
     * value can end the literal, and so is `$`, which would otherwise start a string template.
     */
    private fun stringLiteral(s: String): String {
        val sb = StringBuilder()
        for (c in s) {
            when {
                c == '\\' -> sb.append("\\\\")
                c == '"' -> sb.append("\\\"")
                c == '$' -> sb.append("\\$")
                c == '\n' -> sb.append("\\n")
                c == '\r' -> sb.append("\\r")
                c == '\t' -> sb.append("\\t")
                c.code < 0x20 || c.code == 0x7f -> sb.append("\\u%04x".format(c.code))
                else -> sb.append(c)
            }
        }
        return sb.toString()
    }

    companion object {
        private val LOG = LoggerFactory.getLogger(KotlinRequirementTestsGenerator::class.java)

        const val ARG_TEST_PACKAGE = "testPackage"
        const val ARG_WITNESS_CLASS = "witnessClass"
        const val ARG_GRAIN = "grain"
        const val ARG_FILTER = "filter"
        const val ARG_RENDERER = "renderer"
        const val ARG_WARN_UNCOVERED = "warnUncovered"

        /** The refusal code when two tests map to one witness key. */
        const val ERR_WITNESS_KEY_COLLISION = "ERR_REQUIREMENT_WITNESS_KEY_COLLISION"

        /** How many uncovered requirements to name before "and N more". */
        private const val MAX_NAMED_UNCOVERED = 5

        private const val SKIP_PLANNED = "planned - not built yet"
        private const val SKIP_RETIRED = "retired - the capability was deliberately removed; assert it stays removed"

        /** Kotlin's hard keywords: the ones that cannot be an identifier without backticks. */
        private val HARD_KEYWORDS = setOf(
            "as", "break", "class", "continue", "do", "else", "false", "for", "fun", "if", "in",
            "interface", "is", "null", "object", "package", "return", "super", "this", "throw",
            "true", "try", "typealias", "typeof", "val", "var", "when", "while",
        )

        private val KOTLIN_NAME = Regex("[A-Za-z_][A-Za-z0-9_]*(\\.[A-Za-z_][A-Za-z0-9_]*)*")

        private const val GENERATED_HEADER =
            "// GENERATED by metaobjects (requirement-tests). DO NOT EDIT: this file is rewritten whole.\n"
    }
}

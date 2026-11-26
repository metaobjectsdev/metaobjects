package com.metaobjects.generator.kotlin.writer.layout

import com.fasterxml.jackson.databind.ObjectMapper
import com.metaobjects.generator.kotlin.writer.layout.KotlinLayoutAnalyzer.Kind
import java.nio.file.Files
import java.nio.file.Path
import kotlin.io.path.isRegularFile
import kotlin.io.path.readText
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlin.test.fail
import org.junit.jupiter.api.Assumptions.assumeTrue

/**
 * The Kotlin layout ratchet (ADR-0063): generator source never types layout; the writer does.
 *
 * Three parts, as in the other ports: the analyzer's own cases (layout it must catch, and
 * writer-based code it must pass), the scope rule (which files are generator source, by rule and
 * not by list) and the ratchet over the real module: every file with hand-typed layout is on the
 * allowlist with a reason, every allowlisted file still needs its entry, and the allowlist only
 * shrinks.
 */
class KotlinLayoutRatchetTest {

    private fun kinds(body: String): List<Kind> =
        KotlinLayoutAnalyzer.analyze("Fixture.kt", "fun f() {\n$body\n}").map { it.kind }.sorted()

    // ── 1. the analyzer ──────────────────────────────────────────────────────────────────

    @Test
    fun catches_a_newline_escape_and_a_raw_string_over_lines() {
        assertEquals(listOf(Kind.NEWLINE_LITERAL), kinds("val s = \"a\\nb\""))
        assertEquals(listOf(Kind.NEWLINE_LITERAL), kinds("val s = \"a\\r\""))
        assertEquals(listOf(Kind.NEWLINE_LITERAL), kinds("sb.append('\\n')"))
        assertEquals(listOf(Kind.NEWLINE_LITERAL), kinds("val s = \"\"\"\n  a\n\"\"\".trimIndent()"))
        assertEquals(listOf(Kind.NEWLINE_LITERAL), kinds("val s = \"\${x}\\n\""))
    }

    @Test
    fun catches_a_call_that_writes_a_line_break() {
        assertEquals(listOf(Kind.NEWLINE_LITERAL), kinds("sb.appendLine(x)"))
        assertEquals(listOf(Kind.NEWLINE_LITERAL), kinds("val nl = System.lineSeparator()"))
    }

    @Test
    fun catches_a_string_that_starts_with_an_indentation_run() {
        assertEquals(listOf(Kind.INDENT_LITERAL), kinds("rows.add(\"  \" + name)"))
        assertEquals(listOf(Kind.INDENT_LITERAL), kinds("rows.add(\"\\tx\")"))
        assertEquals(listOf(Kind.INDENT_LITERAL), kinds("rows.add(\"    val \$name: String\")"))
    }

    @Test
    fun catches_an_indentation_repeat() {
        assertEquals(listOf(Kind.INDENT_REPEAT), kinds("val pad = \"  \".repeat(depth)"))
        assertEquals(listOf(Kind.INDENT_REPEAT), kinds("val pad = \" \".repeat(depth * 2)"))
    }

    @Test
    fun catches_an_import_of_kotlinpoet() {
        val source = "import com.squareup.kotlinpoet.FileSpec\nimport com.squareup.kotlinpoetx.Other\nfun f() = 1"
        assertEquals(listOf(Kind.PRINTER_IMPORT), KotlinLayoutAnalyzer.analyze("F.kt", source).map { it.kind })
    }

    @Test
    fun a_string_inside_a_template_is_judged_on_its_own() {
        assertEquals(listOf(Kind.NEWLINE_LITERAL), kinds("val s = \"a\${xs.joinToString(\"\\n\")}b\""))
    }

    @Test
    fun findings_carry_the_line_and_column_of_the_literal() {
        val f = KotlinLayoutAnalyzer.analyze("F.kt", "fun f() {\n    val s = \"a\\nb\"\n}").single()
        assertEquals(2, f.line)
        assertEquals(13, f.column)
    }

    @Test
    fun passes_a_generator_written_on_the_writer() {
        val source = """
            import com.metaobjects.generator.kotlin.writer.KotlinWriter

            // Comments may say anything, including "\n" and
            //     indented text: a comment is never a finding.
            /**
             *   KDoc, indented, with "\n" in it
             */
            fun render(name: String): String {
                val w = KotlinWriter()
                val list = w.use("kotlin.collections.List")
                w.block("class ${'$'}name {") {
                    w.line("val names: ", list, "<String> = emptyList()")
                    w.blank()
                    w.line("fun size() = names.size")
                    w.text(""${'"'}
                        fun first(): String =
                            names.first()
                    ""${'"'})
                }
                return w.toString()
            }
        """.trimIndent()
        assertEquals(emptyList(), KotlinLayoutAnalyzer.analyze("Gen.kt", source))
    }

    @Test
    fun a_line_break_used_as_a_search_pattern_or_comparison_is_not_output() {
        assertEquals(emptyList(), kinds("val p = description.split(\"\\n\")"))
        assertEquals(emptyList(), kinds("if (body.contains(\"\\n\")) flag()"))
        assertEquals(emptyList(), kinds("val s = body.replace(\"\\r\\n\", \" \")"))
        assertEquals(emptyList(), kinds("val at = body.indexOf(\"  \")"))
        assertEquals(emptyList(), kinds("if (c == '\\n') flag()"))
        assertEquals(emptyList(), kinds("when (c) { '\\n' -> flag(); else -> {} }"))
        assertEquals(emptyList(), kinds("when (s) { \"\\n\" -> flag(); else -> {} }"))
        assertEquals(emptyList(), kinds("val lines = text.split(Regex(\"\\r\\n|\\r|\\n\"))"))
    }

    @Test
    fun a_replacement_that_writes_a_line_break_is_still_output() {
        assertEquals(listOf(Kind.NEWLINE_LITERAL), kinds("val s = body.replace(\";\", \";\\n\")"))
    }

    @Test
    fun single_spaces_and_text_after_a_concatenation_are_not_layout() {
        assertEquals(emptyList(), kinds("val a = names.joinToString(\", \"); val b = left + \"  \" + right; val c = \" \" + x"))
    }

    // ── 2. the scope rule ────────────────────────────────────────────────────────────────

    @Test
    fun scope_is_decided_by_rule() {
        val cases = mapOf(
            "codegen-kotlin/src/main/kotlin/com/metaobjects/generator/kotlin/KotlinNamesGenerator.kt" to true,
            "codegen-kotlin/src/main/kotlin/com/metaobjects/generator/kotlin/apidocs/KotlinApiDocsRenderer.kt" to true,
            "codegen-kotlin/src/main/kotlin/com/metaobjects/generator/kotlin/writer/KotlinWriter.kt" to false,
            "codegen-kotlin/src/test/kotlin/com/metaobjects/generator/kotlin/KotlinNamesGeneratorTest.kt" to false,
            "codegen-kotlin/src/main/kotlin/com/metaobjects/generator/kotlin/KNOWN_GAPS.md" to false,
            "codegen-spring/src/main/java/com/metaobjects/generator/spring/SpringNamesGenerator.java" to false,
        )
        for ((path, expected) in cases) assertEquals(expected, KotlinLayoutAnalyzer.isGeneratorSource(path), path)
    }

    // ── 3. the ratchet over the real module ─────────────────────────────────────────────────

    /** The allowlist: `unconverted` and `exempt`, each a map from file to its written reason. */
    data class Allowlist(val unconverted: Map<String, String>, val exempt: Map<String, String>) {
        val entries: Map<String, String> get() = (unconverted + exempt).toSortedMap()
    }

    @Test
    fun it_reads_every_scanned_module() {
        for (m in KotlinLayoutAnalyzer.SCANNED_MODULES) assertTrue(findings.keys.any { it.startsWith("$m/") }, m)
    }

    @Test
    fun no_generator_source_types_layout_unless_its_file_is_allowlisted() {
        val entries = allowlist.entries
        val offenders = findings.filter { (file, found) -> found.isNotEmpty() && file !in entries }
            .map { (file, found) -> file + "\n" + found.joinToString("\n") { "  $it" } }
        assertEquals(
            emptyList(), offenders,
            "Write these lines through KotlinWriter (generator/kotlin/writer/) instead of typing line breaks or" +
                " indentation. A file is never added to the allowlist: it only shrinks.",
        )
    }

    @Test
    fun every_allowlisted_file_still_needs_its_entry() {
        val stale = allowlist.entries.keys.filter { findings[it].isNullOrEmpty() }
        assertEquals(emptyList(), stale, "these files no longer type layout (or no longer exist): remove their allowlist entries")
    }

    @Test
    fun every_allowlisted_path_is_generator_source_that_exists() {
        for (file in allowlist.entries.keys) {
            assertTrue(KotlinLayoutAnalyzer.isGeneratorSource(file), "$file is not in the ratchet's scope")
            assertTrue(Files.exists(JAVA.resolve(file)), "$file does not exist")
        }
    }

    @Test
    fun every_entry_carries_a_written_reason() {
        allowlist.entries.forEach { (file, reason) -> assertTrue(reason.length > 40, "$file needs a reason") }
    }

    @Test
    fun a_file_is_either_unconverted_or_exempt_never_both_and_each_list_is_sorted() {
        for (f in allowlist.unconverted.keys) assertFalse(f in allowlist.exempt, f)
        val raw = MAPPER.readTree(ALLOWLIST.readText())
        for (list in listOf("unconverted", "exempt")) {
            val keys = raw.path(list).fieldNames().asSequence().toList()
            assertEquals(keys.sorted(), keys, "$list is sorted")
        }
    }

    /** The allowlist may only shrink. Compared with the copy at the merge base of every integration branch this checkout knows. */
    @Test
    fun the_allowlist_only_shrinks() {
        val bases = mergeBaseAllowlists()
        assumeTrue(bases != null, "git or the integration refs are unavailable (an export or a shallow clone)")
        for (base in bases!!) {
            assertEquals(emptyList(), growth(base, allowlist), "the allowlist grew since the merge base; convert the file to the writer instead")
        }
    }

    @Test
    fun growth_is_an_added_entry_or_an_unconverted_file_relabelled_exempt_and_removal_is_not() {
        val before = Allowlist(mapOf("A.kt" to "r", "B.kt" to "r"), mapOf("C.kt" to "r"))
        assertEquals(emptyList(), growth(before, Allowlist(mapOf("A.kt" to "r"), emptyMap())))
        assertEquals(listOf("added D.kt"), growth(before, Allowlist(mapOf("A.kt" to "r", "D.kt" to "r"), mapOf("C.kt" to "r"))))
        assertEquals(
            listOf("relabelled B.kt as exempt"),
            growth(before, Allowlist(mapOf("A.kt" to "r"), mapOf("B.kt" to "r", "C.kt" to "r"))),
        )
    }

    private companion object {
        val MAPPER = ObjectMapper()

        /** `server/java/`: the tests run with the module as the working directory. */
        val JAVA: Path = Path.of(System.getProperty("user.dir")).resolve("..").normalize()

        val ALLOWLIST: Path = Path.of(System.getProperty("user.dir"), "src/test/resources/layout-ratchet/allowlist.json")

        fun readAllowlist(json: String): Allowlist {
            val raw = MAPPER.readTree(json)
            fun strings(name: String): Map<String, String> =
                raw.path(name).fields().asSequence().associate { it.key to it.value.asText() }.toSortedMap()
            return Allowlist(strings("unconverted"), strings("exempt"))
        }

        val allowlist: Allowlist = readAllowlist(ALLOWLIST.readText())

        val findings: Map<String, List<KotlinLayoutAnalyzer.Finding>> = sortedMapOf<String, List<KotlinLayoutAnalyzer.Finding>>().also { out ->
            for (module in KotlinLayoutAnalyzer.SCANNED_MODULES) {
                Files.walk(JAVA.resolve(module).resolve("src/main/kotlin")).use { files ->
                    for (f in files.filter { it.isRegularFile() }.toList()) {
                        val rel = JAVA.relativize(f).toString().replace('\\', '/')
                        if (KotlinLayoutAnalyzer.isGeneratorSource(rel)) out[rel] = KotlinLayoutAnalyzer.analyze(rel, f.readText())
                    }
                }
            }
            // `-Dlayout.dump=<file>` lists every file that types layout, to write or prune allowlist entries.
            System.getProperty("layout.dump")?.let { dump ->
                Files.write(
                    Path.of(dump),
                    out.filterValues { it.isNotEmpty() }.map { (f, found) ->
                        f + "\t" + found.size + "\t" + found.map { it.kind }.distinct().sorted().joinToString(",")
                    },
                )
            }
        }

        /** How [now] grew relative to [before]: entries that are new, and unconverted files relabelled exempt. */
        fun growth(before: Allowlist, now: Allowlist): List<String> {
            val had = before.entries
            return now.entries.keys.filter { it !in had }.map { "added $it" } +
                now.exempt.keys.filter { it in before.unconverted }.map { "relabelled $it as exempt" }
        }

        fun git(vararg args: String): String? = try {
            val p = ProcessBuilder(listOf("git", "-C", JAVA.toString()) + args)
                .redirectError(ProcessBuilder.Redirect.DISCARD).start()
            val out = p.inputStream.readBytes().toString(Charsets.UTF_8).trim()
            if (p.waitFor() == 0) out else null
        } catch (e: Exception) {
            null
        }

        /** The allowlist as it stood at the merge base of HEAD with each integration branch; null when git or those refs are unavailable. */
        fun mergeBaseAllowlists(): List<Allowlist>? {
            val refs = git("for-each-ref", "--format=%(refname:short)", "refs/remotes/origin/main", "refs/remotes/origin/release/")
            if (refs.isNullOrEmpty()) return null
            val top = git("rev-parse", "--show-toplevel") ?: return null
            val rel = Path.of(top).relativize(ALLOWLIST).toString().replace('\\', '/')
            var reachable = false
            val out = ArrayList<Allowlist>()
            for (ref in refs.split(Regex("\\s+"))) {
                val base = git("merge-base", "HEAD", ref) ?: continue
                reachable = true
                // Absent at the base (the ratchet is newer than it): nothing to compare against.
                git("show", "$base:$rel")?.let { out += readAllowlist(it) }
            }
            return if (reachable) out else null
        }
    }
}

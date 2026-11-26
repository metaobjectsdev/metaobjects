package com.metaobjects.generator.kotlin.writer

import com.metaobjects.generator.writer.CodeWriter
import com.metaobjects.generator.writer.Group
import com.metaobjects.generator.writer.WriterException
import com.metaobjects.generator.writer.WriterOptions
import java.util.TreeMap
import java.util.TreeSet

/**
 * The Kotlin dialect of the code writer (ADR-0063; contract: `spec/code-writer.md`, "Kotlin
 * dialect"). It extends the language-neutral core in `codegen-base`
 * ([CodeWriter]), the same core the Java writer extends.
 *
 * Adds what is Kotlin's own: the `package` line, imports collected while the body is written
 * and printed first (with `as` aliases), Kotlin string quoting (a `$` is escaped), KDoc comments,
 * and the scoped forms Kotlin source needs: [block] with a trailing lambda, [reopen] for
 * `} else {`, and [indented] for a continuation that opens no block.
 *
 * Built to be extended, like the core: each section of the file ([writeHeader], [writePackage],
 * [writeImports]) is its own overridable method, and none of them is a stability contract.
 */
open class KotlinWriter @JvmOverloads constructor(options: WriterOptions = KOTLIN) : CodeWriter(options) {

    /** Local name to the fully qualified name that owns it, so one name cannot come from two types. */
    protected val locals: MutableMap<String, String> = TreeMap()

    /** What each import line names after `import `: `a.b.C` or `a.b.C as D`. */
    protected val imports: MutableSet<String> = TreeSet()

    /** The fully qualified name behind each entry of [imports], to decide whether it needs a line. */
    protected val importTargets: MutableMap<String, String> = TreeMap()

    protected val headLines: MutableList<String> = ArrayList()
    protected var packageName: String? = null

    /** The `package` this file is in; a type in that package needs no import. */
    open fun packageName(name: String): KotlinWriter {
        packageName = name
        return this
    }

    /**
     * Reference a type (or a top-level function or property) by its fully qualified name; returns
     * the name to write, its last segment. A name in a package Kotlin imports by default, or in
     * this file's package, prints no import line. A nested type (`java.util.Map.Entry`) is
     * imported as written and written by its last segment.
     */
    open fun use(qualifiedName: String): String = record(qualifiedName, simpleName(qualifiedName), null)

    /** Reference [qualifiedName] under the local name [alias]: `import a.b.C as D`; returns [alias]. */
    open fun use(qualifiedName: String, alias: String): String = record(qualifiedName, alias, alias)

    protected open fun record(qualifiedName: String, local: String, alias: String?): String {
        val owner = locals[local]
        if (owner != null && owner != qualifiedName) {
            throw WriterException(
                WriterException.IMPORT_CONFLICT, "$local is imported from both $owner and $qualifiedName",
            )
        }
        locals[local] = qualifiedName
        val spec = escapeName(qualifiedName) + if (alias == null) "" else " as " + escapeName(alias)
        imports.add(spec)
        importTargets[spec] = if (alias == null) qualifiedName else ""
        return escapeName(local)
    }

    /** Lines printed at the very top, before the package line: a banner comment or a file annotation. */
    open fun header(vararg lines: String): KotlinWriter {
        headLines.addAll(lines)
        return this
    }

    /**
     * A KDoc comment: one line when it fits, otherwise a block with one ` * ` line per entry and a
     * bare ` *` line for an empty entry. Kotlin comments nest, so both `*` + `/` and `/` + `*`
     * inside the text are neutralised.
     */
    open fun doc(vararg lines: String): KotlinWriter {
        if (lines.isEmpty()) return this
        val safe = lines.map { it.replace("*/", "*&#47;").replace("/*", "&#47;*") }
        val one = "/** " + safe[0] + " */"
        if (safe.size == 1 && fits(one)) {
            line(one)
            return this
        }
        line("/**")
        for (l in safe) line(if (l.isEmpty()) " *" else " * $l")
        line(" */")
        return this
    }

    /**
     * A block written with a trailing lambda: `w.block("class A {") { ... }` writes the head,
     * indents, runs [body], dedents and writes [tail].
     */
    @JvmOverloads
    open fun block(head: Any, tail: Any = "}", body: () -> Unit): KotlinWriter {
        open(head)
        body()
        close(tail)
        return this
    }

    /**
     * Close the open block and open the next on one line, as in `} else {` or
     * `} catch (e: Exception) {`. With no block open it is `ERR_WRITER_UNBALANCED_CLOSE`.
     */
    open fun reopen(vararg parts: Any): KotlinWriter {
        val p = piece(parts.toList())
        if (openers.isEmpty()) {
            throw WriterException(WriterException.UNBALANCED_CLOSE, "reopen(\"" + flat(p) + "\") with no block open")
        }
        openers.removeAt(openers.size - 1)
        wantBlank = false
        openPiece(p)
        return this
    }

    /**
     * Write [body] one level in, opening no block and closing none: the continuation of an
     * expression body (`fun f() =`), or of a statement broken by the generator.
     */
    open fun indented(body: () -> Unit): KotlinWriter {
        openers.add(NO_BLOCK)
        try {
            body()
        } finally {
            openers.removeAt(openers.size - 1)
        }
        return this
    }

    override fun toString(): String {
        val head = sectionWriter()
        writeHeader(head)
        head.blank()
        writePackage(head)
        head.blank()
        writeImports(head)
        val top = head.toString()
        val body = super.toString()
        if (top.isEmpty()) return body
        if (body.isEmpty()) return top
        return top + "\n" + body
    }

    /** The writer the header, package and import sections are laid out with: same options, no dialect. */
    protected open fun sectionWriter(): CodeWriter = CodeWriter(options)

    /** The [header] lines, as given. */
    protected open fun writeHeader(w: CodeWriter) {
        for (l in headLines) w.line(l)
    }

    /** The `package` line, when one was set and is not the default (empty) package. */
    protected open fun writePackage(w: CodeWriter) {
        val pkg = packageName
        if (!pkg.isNullOrEmpty()) w.line("package ", escapeName(pkg))
    }

    /** One `import` line per name, in code-unit order of what follows `import `. */
    protected open fun writeImports(w: CodeWriter) {
        for (spec in imports) {
            if (needsImport(importTargets.getValue(spec))) w.line("import ", spec)
        }
    }

    /**
     * False for a name in a package Kotlin imports by default or in the file's own package. An
     * aliased import ([importTargets] holds `""`) always needs its line, since the alias is the
     * only way the file can say the name. A name with no dot is in the root package, which a file
     * in a named package reaches only through an import.
     */
    protected open fun needsImport(qualifiedName: String): Boolean {
        if (qualifiedName.isEmpty()) return true
        val dot = qualifiedName.lastIndexOf('.')
        val pkg = if (dot < 0) "" else qualifiedName.substring(0, dot)
        return pkg !in DEFAULT_IMPORTS && pkg != (packageName ?: "")
    }

    companion object {
        /** Four spaces, 120 columns and a trailing comma on a broken list, as Kotlin's coding conventions write it. */
        @JvmField
        val KOTLIN: WriterOptions = WriterOptions("    ", 120, true)

        /** The opener text recorded for an indent that opens no block. */
        protected const val NO_BLOCK: String = ""

        /** The packages every Kotlin/JVM file imports by default (Kotlin language spec, "Default imports"). */
        @JvmField
        val DEFAULT_IMPORTS: Set<String> = setOf(
            "kotlin", "kotlin.annotation", "kotlin.collections", "kotlin.comparisons", "kotlin.io",
            "kotlin.ranges", "kotlin.sequences", "kotlin.text", "kotlin.jvm", "java.lang",
        )

        /** Kotlin's hard keywords: as a name segment each must be written in backticks. */
        @JvmField
        val HARD_KEYWORDS: Set<String> = setOf(
            "as", "break", "class", "continue", "do", "else", "false", "for", "fun", "if", "in",
            "interface", "is", "null", "object", "package", "return", "super", "this", "throw", "true",
            "try", "typealias", "typeof", "val", "var", "when", "while",
        )

        /** A correctly quoted Kotlin string literal; a `$` is escaped, so the value is never a template. */
        @JvmStatic
        fun str(value: String): String {
            val sb = StringBuilder(value.length + 2).append('"')
            for (c in value) {
                when (c) {
                    '"' -> sb.append("\\\"")
                    '\\' -> sb.append("\\\\")
                    '$' -> sb.append("\\$")
                    '\n' -> sb.append("\\n")
                    '\r' -> sb.append("\\r")
                    '\t' -> sb.append("\\t")
                    '\b' -> sb.append("\\b")
                    else -> if (c.code < 0x20 || c.code == 0x7f) sb.append(String.format("\\u%04x", c.code)) else sb.append(c)
                }
            }
            return sb.append('"').toString()
        }

        /** A call: `fn(a, b)`, a list that breaks one argument per line. */
        @JvmStatic
        fun call(fn: String, vararg args: Any): Group = list("$fn(", args.toList(), ")")

        /** A dotted name with each hard-keyword segment in backticks: `com.acme.`object``. */
        @JvmStatic
        fun escapeName(name: String): String =
            name.split('.').joinToString(".") { if (it in HARD_KEYWORDS) "`$it`" else it }

        /** The last segment of a dotted name. */
        @JvmStatic
        fun simpleName(qualified: String): String = qualified.substring(qualified.lastIndexOf('.') + 1)
    }
}

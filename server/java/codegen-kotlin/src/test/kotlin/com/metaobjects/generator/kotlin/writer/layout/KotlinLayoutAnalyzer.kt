package com.metaobjects.generator.kotlin.writer.layout

import org.jetbrains.kotlin.lexer.KotlinLexer
import org.jetbrains.kotlin.lexer.KtTokens

/**
 * Finds hand-typed layout in Kotlin generator source (ADR-0063): the line breaks and indentation
 * the code writer owns. It reads the source with the Kotlin compiler's own lexer, so comments and
 * KDoc are never findings, and a string literal is judged by what it contains, template entries
 * and all.
 *
 * What counts:
 * - [Kind.NEWLINE_LITERAL]: a string or character literal that holds a line break (a `\n` or `\r`
 *   escape, or a raw string spanning lines), and a call that writes one (`appendLine`,
 *   `lineSeparator`).
 * - [Kind.INDENT_LITERAL]: a string literal that starts with an indentation run (two spaces or a tab),
 *   unless it follows a `+` (text inside a line, not the line's start).
 * - [Kind.INDENT_REPEAT]: a whitespace-only literal repeated (`"  ".repeat(depth)`).
 * - [Kind.PRINTER_IMPORT]: an import of KotlinPoet, a printer that lays the text out itself.
 *
 * What does not: a fixed snippet passed straight to the writer's `text(...)`, which re-indents it,
 * and a literal used to search or compare, not to write: the argument of `split`,
 * `contains`, `indexOf`, `startsWith`, `Regex` and the like, the first argument of `replace`, an operand of
 * `==` or `!=`, and a `when` branch condition.
 */
object KotlinLayoutAnalyzer {

    enum class Kind { INDENT_LITERAL, INDENT_REPEAT, NEWLINE_LITERAL, PRINTER_IMPORT }

    data class Finding(val kind: Kind, val line: Int, val column: Int, val text: String) {
        override fun toString(): String = "$line:$column $kind $text"
    }

    /** The modules whose main source is generator source. */
    val SCANNED_MODULES: List<String> = listOf("codegen-kotlin")

    /**
     * Whether [path] (relative to `server/java/`) is generator source the ratchet holds: Kotlin main
     * source of a scanned module, outside the writer package, which is the one place layout lives.
     */
    fun isGeneratorSource(path: String): Boolean {
        if (!path.endsWith(".kt")) return false
        val module = SCANNED_MODULES.firstOrNull { path.startsWith("$it/src/main/kotlin/") } ?: return false
        return !path.removePrefix("$module/src/main/kotlin/").contains("/writer/")
    }

    /** A function whose literal argument is a pattern to look for, not text to write. */
    private val SEARCHES = setOf(
        "split", "contains", "indexOf", "lastIndexOf", "startsWith", "endsWith", "removePrefix",
        "removeSuffix", "substringBefore", "substringAfter", "substringBeforeLast", "substringAfterLast",
        "trimEnd", "trimStart", "count", "lines", "Regex", "toRegex",
    )

    private val WRITES_A_LINE_BREAK = setOf("appendLine", "lineSeparator")

    private class Tok(val type: String, val text: String, val offset: Int)

    private class Literal(val open: Int) {
        val parts = StringBuilder()
        var first: String? = null
        var newline = false
    }

    fun analyze(name: String, source: String): List<Finding> {
        val toks = lex(name, source)
        val out = ArrayList<Finding>()
        val stack = ArrayDeque<Literal>()
        for ((i, t) in toks.withIndex()) {
            when (t.type) {
                OPEN_QUOTE -> stack.addLast(Literal(i))
                REGULAR -> stack.lastOrNull()?.let { l ->
                    if (l.first == null) l.first = t.text
                    if ('\n' in t.text || '\r' in t.text) l.newline = true
                    l.parts.append(t.text)
                }
                ESCAPE -> stack.lastOrNull()?.let { l ->
                    if (l.first == null) l.first = t.text
                    if (t.text == "\\n" || t.text == "\\r") l.newline = true
                    l.parts.append(if (t.text == "\\t") "\t" else "x")
                }
                TEMPLATE -> stack.lastOrNull()?.let { l ->
                    if (l.first == null) l.first = ""
                    l.parts.append("x")
                }
                CLOSE_QUOTE -> {
                    val l = stack.removeLastOrNull() ?: continue
                    if (searched(toks, l.open, i)) continue
                    val at = toks[l.open]
                    val literal = source.substring(at.offset, t.offset + t.text.length)
                    val first = l.first ?: ""
                    val ws = l.parts.isNotEmpty() && l.parts.all { it == ' ' || it == '\t' }
                    when {
                        l.newline -> out += finding(Kind.NEWLINE_LITERAL, source, at.offset, literal)
                        ws && toks.getOrNull(i + 1)?.text == "." && toks.getOrNull(i + 2)?.text == "repeat" ->
                            out += finding(Kind.INDENT_REPEAT, source, at.offset, literal)
                        toks.getOrNull(l.open - 1)?.text != "+" &&
                            (first.startsWith("  ") || first.startsWith("\t") || first == "\\t") ->
                            out += finding(Kind.INDENT_LITERAL, source, at.offset, literal)
                    }
                }
                CHAR -> if ((t.text == "'\\n'" || t.text == "'\\r'") && !searchedChar(toks, i)) {
                    out += finding(Kind.NEWLINE_LITERAL, source, t.offset, t.text)
                }
                // `import` is a soft keyword: the lexer hands it over as an identifier.
                IDENT -> if (t.text == "import" && toks.subList(i + 1, minOf(i + 6, toks.size)).joinToString("") { it.text } == "com.squareup.kotlinpoet") {
                    out += finding(Kind.PRINTER_IMPORT, source, t.offset, "import com.squareup.kotlinpoet")
                } else if (t.text in WRITES_A_LINE_BREAK && toks.getOrNull(i + 1)?.text == "(") {
                    out += finding(Kind.NEWLINE_LITERAL, source, t.offset, t.text)
                }
            }
        }
        return out
    }

    /** Whether the literal from token [open] to [close] is a search pattern or a comparison operand. */
    private fun searched(toks: List<Tok>, open: Int, close: Int): Boolean {
        val before = toks.getOrNull(open - 1)?.text
        val call = toks.getOrNull(open - 2)?.text
        val after = toks.getOrNull(close + 1)?.text
        if (before == "==" || before == "!=" || after == "==" || after == "!=") return true
        if (after == "->") return true
        if (before == "(" && call in SEARCHES) return true
        // A snippet handed to the writer's `text()`: the writer re-indents it to the current level.
        if (before == "(" && call == "text" && after == ")") return true
        if (before == "(" && call == "replace" && after == ",") return true
        return false
    }

    private fun searchedChar(toks: List<Tok>, i: Int): Boolean = searched(toks, i, i)

    private fun finding(kind: Kind, source: String, offset: Int, text: String): Finding {
        var line = 1
        var col = 1
        for (k in 0 until offset) {
            if (source[k] == '\n') { line++; col = 1 } else col++
        }
        return Finding(kind, line, col, text.lineSequence().first().take(60))
    }

    private const val OPEN_QUOTE = "OPEN_QUOTE"
    private const val CLOSE_QUOTE = "CLOSING_QUOTE"
    private const val REGULAR = "REGULAR_STRING_PART"
    private const val ESCAPE = "ESCAPE_SEQUENCE"
    private const val TEMPLATE = "TEMPLATE"
    private const val CHAR = "CHARACTER_LITERAL"
    private const val IDENT = "IDENTIFIER"

    /** The source's tokens, without whitespace and comments; a lexer error refuses the file. */
    private fun lex(name: String, source: String): List<Tok> {
        val lexer = KotlinLexer()
        lexer.start(source)
        val out = ArrayList<Tok>()
        while (true) {
            val type = lexer.tokenType ?: break
            val text = source.substring(lexer.tokenStart, lexer.tokenEnd)
            val kind = when {
                type == KtTokens.WHITE_SPACE || KtTokens.COMMENTS.contains(type) -> null
                type == KtTokens.OPEN_QUOTE -> OPEN_QUOTE
                type == KtTokens.CLOSING_QUOTE -> CLOSE_QUOTE
                type == KtTokens.REGULAR_STRING_PART -> REGULAR
                type == KtTokens.ESCAPE_SEQUENCE -> ESCAPE
                type == KtTokens.SHORT_TEMPLATE_ENTRY_START || type == KtTokens.LONG_TEMPLATE_ENTRY_START -> TEMPLATE
                type == KtTokens.CHARACTER_LITERAL -> CHAR
                type == KtTokens.IDENTIFIER -> IDENT
                type.toString() == "BAD_CHARACTER" ->
                    throw IllegalStateException("cannot lex $name at offset ${lexer.tokenStart}")
                else -> type.toString()
            }
            if (kind != null) out += Tok(kind, text, lexer.tokenStart)
            lexer.advance()
        }
        return out
    }
}

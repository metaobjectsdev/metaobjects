package com.metaobjects.render;

import java.util.Map;
import java.util.function.UnaryOperator;

/**
 * Format-keyed escaper registry for the render engine (FR-004).
 *
 * <p>Tier-1 invariant: escaping behavior per format is character-by-character
 * identical to TS ({@code server/typescript/packages/render/src/escapers.ts})
 * and C# ({@code server/csharp/MetaObjects.Render/Escapers.cs}).
 *
 * <p>{@code {{var}}} substitutions in a Mustache template are escaped per
 * format; {@code {{{var}}}} bypasses escaping (Mustache's "triple-stache"
 * raw form is preserved by the {@link Renderer}).
 */
public final class Escapers {

    private Escapers() {}

    public static final String FORMAT_TEXT        = "text";
    public static final String FORMAT_HTML        = "html";
    public static final String FORMAT_XML         = "xml";
    public static final String FORMAT_CSV         = "csv";
    public static final String FORMAT_JSON        = "json";
    public static final String FORMAT_MARKDOWN    = "markdown";
    public static final String FORMAT_SPREADSHEET = "spreadsheet";

    private static final Map<String, UnaryOperator<String>> REGISTRY = Map.of(
        FORMAT_TEXT,        UnaryOperator.identity(),
        FORMAT_MARKDOWN,    UnaryOperator.identity(),
        FORMAT_HTML,        Escapers::escapeXml,  // HTML uses XML entity set per FR-004 spec
        FORMAT_XML,         Escapers::escapeXml,
        FORMAT_CSV,         Escapers::escapeCsv,
        // XML-escape the content first, then guard — the guard's leading quote stays
        // a literal apostrophe (which tells Excel "treat as text"), not &#39;.
        FORMAT_SPREADSHEET, s -> injectionGuard(escapeXml(s)),
        FORMAT_JSON,        Escapers::escapeJson
    );

    /**
     * Escape {@code input} according to the given format. Unknown formats throw
     * — the Renderer defaults to {@code "text"} when no format is supplied.
     */
    public static String escape(String format, String input) {
        UnaryOperator<String> fn = REGISTRY.get(format);
        if (fn == null) {
            throw new IllegalArgumentException("unknown render format \"" + format + "\"");
        }
        return fn.apply(input);
    }

    static String escapeXml(String s) {
        StringBuilder sb = new StringBuilder(s.length() + 8);
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '&'  -> sb.append("&amp;");
                case '<'  -> sb.append("&lt;");
                case '>'  -> sb.append("&gt;");
                case '"'  -> sb.append("&quot;");
                case '\'' -> sb.append("&#39;");
                default   -> sb.append(c);
            }
        }
        return sb.toString();
    }

    // OWASP CSV/Excel formula-injection guard: neutralize a leading active char.
    static String injectionGuard(String s) {
        if (s.isEmpty()) return s;
        char first = s.charAt(0);
        if (first == '=' || first == '+' || first == '-' || first == '@'
                || first == '\t' || first == '\r') {
            return "'" + s;
        }
        return s;
    }

    static String escapeCsv(String s) {
        String guarded = injectionGuard(s);
        boolean needsQuote = guarded.indexOf(',') >= 0
            || guarded.indexOf('"') >= 0
            || guarded.indexOf('\n') >= 0
            || guarded.indexOf('\r') >= 0;
        if (!needsQuote) return guarded;
        return "\"" + guarded.replace("\"", "\"\"") + "\"";
    }

    // Mirrors JS JSON.stringify(s).slice(1, -1): escape ", \, and control chars;
    // nothing else (no HTML-safety escaping of < > &).
    static String escapeJson(String s) {
        StringBuilder sb = new StringBuilder(s.length() + 4);
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"'  -> sb.append("\\\"");
                case '\\' -> sb.append("\\\\");
                case '\b' -> sb.append("\\b");
                case '\f' -> sb.append("\\f");
                case '\n' -> sb.append("\\n");
                case '\r' -> sb.append("\\r");
                case '\t' -> sb.append("\\t");
                default -> {
                    if (c < 0x20) {
                        sb.append(String.format("\\u%04x", (int) c));
                    } else {
                        sb.append(c);
                    }
                }
            }
        }
        return sb.toString();
    }
}

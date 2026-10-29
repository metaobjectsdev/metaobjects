package com.metaobjects.render.extract;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.BiFunction;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Stage-4 tolerant XML reader for the bounded corpus malformation set. Never throws.
 *
 * <p>Maps an element's child elements, text, AND attributes into the field map, and
 * handles self-closing tags ({@code <x a="1"/>}). LLM XML output is commonly
 * attribute-bearing ({@code <check id="A" status="ok"/>}); a lenient reader must
 * surface that data rather than dropping it.</p>
 *
 * <p>Representation:</p>
 * <ul>
 *   <li>text-only element, no attributes → its trimmed text (a {@code String}) — unchanged;</li>
 *   <li>self-closing / element with only attributes → a {@code Map} of attribute name→value
 *       (empty {@code String} when it has neither attributes nor body);</li>
 *   <li>element with child elements (± attributes) → a {@code Map} merging attributes and
 *       child entries (a child element wins a name collision with an attribute);</li>
 *   <li>element with text AND attributes → a {@code Map} of the attributes plus the body text
 *       under {@link #TEXT_KEY}. A scalar consumer unwraps {@code #text} (see
 *       {@code Extract.extractValue}), so a text field with stray attributes still reads as
 *       its text — preserving pre-attribute-support behaviour for scalars;</li>
 *   <li>repeated sibling tags → a {@code List} (unchanged).</li>
 * </ul>
 */
public final class XmlForgivingReader {

    /**
     * Reserved key holding an element's own text content when the element is represented as a
     * {@code Map} (because it also carries attributes). {@code '#'} is not a legal XML name
     * start character, so this never collides with a real attribute or child-element name.
     */
    public static final String TEXT_KEY = "#text";

    // tag name + everything up to the closing '>' (attributes and/or a trailing '/' for a
    // self-closing tag). Non-greedy so the first '>' closes the open tag.
    private static final String OPEN_TAG_RE = "<([A-Za-z_][A-Za-z0-9_]*)([^>]*?)>";

    // a closing tag. Used to spot a STRAY close (of an element whose open never appeared in
    // the body) — LLMs commonly end a block with the wrong tag.
    private static final String CLOSE_TAG_RE = "</([A-Za-z_][A-Za-z0-9_]*)\\s*>";

    // one attribute: name = "double" | 'single' | bareword. Tolerant of surrounding whitespace.
    private static final Pattern ATTR = Pattern.compile(
            "([A-Za-z_:][A-Za-z0-9_:.\\-]*)\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s/>]+))");

    private static final String COMMENT_OPEN = "<!--";
    private static final String COMMENT_CLOSE = "-->";
    private static final String CDATA_OPEN = "<![CDATA[";
    private static final String CDATA_CLOSE = "]]>";
    // the five predefined XML entities plus numeric character references.
    private static final Pattern ENTITY = Pattern.compile("&(#x[0-9a-fA-F]+|#[0-9]+|lt|gt|amp|quot|apos);");

    private static final String KIND_COMMENT = "comment";
    private static final String KIND_CDATA = "cdata";

    /**
     * Rewrite every XML comment and CDATA section in {@code text} through {@code replace}
     * (kind, region), scanning left to right so a comment marker inside CDATA (or the reverse)
     * is never mistaken for markup. An unclosed comment is left as text; an unclosed CDATA
     * section runs to the end.
     */
    private static String rewriteRegions(String text, BiFunction<String, String, String> replace) {
        StringBuilder out = new StringBuilder();
        int pos = 0;
        int from = 0;
        while (true) {
            int c = text.indexOf(COMMENT_OPEN, from);
            int d = text.indexOf(CDATA_OPEN, from);
            boolean isComment = c >= 0 && (d < 0 || c < d);
            int start = isComment ? c : d;
            if (start < 0) break;
            int end;
            if (isComment) {
                int e = text.indexOf(COMMENT_CLOSE, start + COMMENT_OPEN.length());
                if (e < 0) {
                    from = start + COMMENT_OPEN.length();
                    continue;
                }
                end = e + COMMENT_CLOSE.length();
            } else {
                int e = text.indexOf(CDATA_CLOSE, start + CDATA_OPEN.length());
                end = e < 0 ? text.length() : e + CDATA_CLOSE.length();
            }
            out.append(text, pos, start)
                    .append(replace.apply(isComment ? KIND_COMMENT : KIND_CDATA, text.substring(start, end)));
            pos = end;
            from = end;
        }
        return out.append(text.substring(pos)).toString();
    }

    /** {@code text} with comments and CDATA sections blanked to spaces (same length, so
     *  indices hold): the view the tag locators search, so markup inside them is never located. */
    static String maskNonMarkup(String text) {
        return rewriteRegions(text, (kind, region) -> " ".repeat(region.length()));
    }

    /** Drop comments; turn each CDATA section into its text with {@code & < >} entity-escaped,
     *  so the tag scanner cannot split it and the entity decode restores it exactly. */
    private static String prepare(String text) {
        return rewriteRegions(text, (kind, region) -> {
            if (kind.equals(KIND_COMMENT)) return "";
            String body = region.endsWith(CDATA_CLOSE)
                    ? region.substring(CDATA_OPEN.length(), region.length() - CDATA_CLOSE.length())
                    : region.substring(CDATA_OPEN.length());
            return body.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;");
        });
    }

    /** Decode predefined entities and numeric references in one pass (so {@code &amp;lt;} is
     *  {@code &lt;}). An unknown or out-of-range reference stays as written. */
    private static String decodeEntities(String s) {
        if (s.indexOf('&') < 0) return s;
        Matcher m = ENTITY.matcher(s);
        StringBuilder sb = new StringBuilder();
        int last = 0;
        while (m.find()) {
            String body = m.group(1);
            String rep = m.group();
            switch (body) {
                case "lt" -> rep = "<";
                case "gt" -> rep = ">";
                case "amp" -> rep = "&";
                case "quot" -> rep = "\"";
                case "apos" -> rep = "'";
                default -> {
                    try {
                        int cp = body.charAt(1) == 'x'
                                ? Integer.parseInt(body.substring(2), 16)
                                : Integer.parseInt(body.substring(1), 10);
                        boolean surrogate = cp >= 0xD800 && cp <= 0xDFFF;
                        if (cp >= 1 && cp <= 0x10FFFF && !surrogate) rep = new String(Character.toChars(cp));
                    } catch (NumberFormatException ignored) {
                        // out-of-range reference: stays as written
                    }
                }
            }
            sb.append(s, last, m.start()).append(rep);
            last = m.end();
        }
        return sb.append(s.substring(last)).toString();
    }

    public Map<String, Object> read(String rawSpan, boolean caseInsensitive) {
        Map<String, Object> out = new LinkedHashMap<>();
        if (rawSpan == null || rawSpan.isBlank()) return out;
        String span = prepare(rawSpan);
        int gt = span.indexOf('>');
        if (gt < 0) return out;
        int rootEnd = span.lastIndexOf("</");
        String inner = span.substring(gt + 1, (rootEnd < 0 || rootEnd <= gt) ? span.length() : rootEnd);
        parseChildren(inner, caseInsensitive, out, null, false);
        return out;
    }

    /**
     * Rootless read: parse the WHOLE text's top-level elements directly, with no enclosing root
     * element to strip (a flat sequence like {@code <a>..</a><b>..</b>}). Used for
     * {@link ExtractOptions#rootless()} responses. Leading/trailing non-element text is ignored.
     * Never throws.
     */
    public Map<String, Object> readRootless(String text, boolean caseInsensitive) {
        Map<String, Object> out = new LinkedHashMap<>();
        if (text == null || text.isBlank()) return out;
        parseChildren(prepare(text), caseInsensitive, out, null, false);
        return out;
    }

    /**
     * Parse {@code inner}'s elements into {@code out}. When {@code loose} is non-null, the text
     * BETWEEN those elements (an element's own text in mixed content) is appended to it, one
     * segment per gap. {@code literalUnclosed} is set for the body of an element that DID
     * close: an open tag in there with no close tag anywhere after it ({@code List<int> and
     * ...}) is prose, not an element.
     */
    private void parseChildren(String inner, boolean ci, Map<String, Object> out, List<String> loose,
                               boolean literalUnclosed) {
        Pattern openTag = Pattern.compile(OPEN_TAG_RE, ci ? Pattern.CASE_INSENSITIVE : 0);
        Pattern closeTag = Pattern.compile(CLOSE_TAG_RE, ci ? Pattern.CASE_INSENSITIVE : 0);
        Matcher m = openTag.matcher(inner);
        int pos = 0;
        int scan = 0;
        while (m.find(scan)) {
            if (literalUnclosed && !m.group(2).stripTrailing().endsWith("/")
                    && !closeTag.matcher(inner).region(m.end(), inner.length()).find()) {
                scan = m.end();
                continue;
            }
            if (loose != null) loose.add(inner.substring(pos, m.start()));
            String tag = m.group(1);
            String key = ci ? tag.toLowerCase() : tag;

            String rawAttrs = m.group(2) == null ? "" : m.group(2).trim();
            boolean selfClosing = rawAttrs.endsWith("/");
            if (selfClosing) rawAttrs = rawAttrs.substring(0, rawAttrs.length() - 1).trim();
            Map<String, Object> attrs = parseAttrs(rawAttrs, ci);

            if (selfClosing) {
                accumulate(out, key, attrs.isEmpty() ? "" : attrs);
                pos = m.end();
                scan = pos;
                continue;
            }

            int contentStart = m.end();
            String closeRe = "</" + Pattern.quote(tag) + "\\s*>";
            Matcher close = Pattern.compile(closeRe, ci ? Pattern.CASE_INSENSITIVE : 0).matcher(inner);
            int contentEnd, next;
            boolean closed = close.find(contentStart);
            if (closed) {
                contentEnd = close.start();
                next = close.end();
            } else {
                // unclosed tag: extract content up to the next sibling open tag.
                Matcher sib = openTag.matcher(inner);
                if (sib.find(contentStart)) {
                    // When the unclosed element's content begins IMMEDIATELY with a child
                    // open tag (no leading text), that child was almost certainly meant to
                    // be NESTED, not a sibling — a common LLM malformation is dropping the
                    // parent's close tag while still emitting a real child element
                    // (e.g. <thread_check ...><closure_payoff>text). Absorb the remainder
                    // of this span as the unclosed element's content so the child nests
                    // under it. When there IS leading text before the first child tag
                    // (e.g. <t>hi<c>..), keep the sibling split — the leading text is the
                    // unclosed element's body and the following tag is its sibling.
                    boolean noLeadingText = inner.substring(contentStart, sib.start()).isBlank();
                    if (noLeadingText) {
                        contentEnd = inner.length();
                        next = inner.length();
                    } else {
                        contentEnd = sib.start();
                        next = contentEnd;
                    }
                } else {
                    contentEnd = inner.length();
                    next = inner.length();
                }
                // A STRAY close tag of another element inside the unclosed element's body ends
                // the body there (the model closed the block with the wrong tag), and the stray
                // tag itself is dropped rather than kept as literal text.
                int[] stray = findStrayClose(inner, contentStart, contentEnd, ci);
                if (stray != null) {
                    contentEnd = stray[0];
                    next = stray[1];
                }
            }
            String content = inner.substring(contentStart, contentEnd);
            accumulate(out, key, combine(attrs, content, ci, closed));
            pos = next;
            scan = next;
        }
        if (loose != null) loose.add(inner.substring(pos));
    }

    /**
     * The first close tag in {@code inner[from, to)} whose element was never opened after
     * {@code from} — a stray close — as {@code {start, end}}, or {@code null}. A close whose
     * open DID appear is a nested child's own close, not stray.
     */
    private static int[] findStrayClose(String inner, int from, int to, boolean ci) {
        int flags = ci ? Pattern.CASE_INSENSITIVE : 0;
        Matcher close = Pattern.compile(CLOSE_TAG_RE, flags).matcher(inner.substring(0, to));
        int at = from;
        while (close.find(at)) {
            Pattern open = Pattern.compile("<" + Pattern.quote(close.group(1)) + "(?=[\\s/>])", flags);
            if (!open.matcher(inner.substring(from, close.start())).find()) {
                return new int[] {close.start(), close.end()};
            }
            at = close.end();
        }
        return null;
    }

    /**
     * Combine an element's attributes with its body (nested children or plain text). Mixed
     * content keeps BOTH: the children, and the element's own text under {@link #TEXT_KEY}, so
     * a scalar or {@code @xmlText} consumer still reads the prose around a child element.
     */
    private Object combine(Map<String, Object> attrs, String content, boolean ci, boolean closed) {
        if (content.contains("<")) {
            Map<String, Object> nested = new LinkedHashMap<>();
            List<String> loose = new ArrayList<>();
            parseChildren(content, ci, nested, loose, closed);
            if (!nested.isEmpty()) {
                // attributes first; a child element takes precedence on a name collision
                Map<String, Object> merged = new LinkedHashMap<>(attrs);
                merged.putAll(nested);
                String text = mixedText(loose, ci);
                if (!text.isEmpty()) merged.put(TEXT_KEY, text);
                return merged;
            }
        }
        return textValue(attrs, content);
    }

    /** The text segments between child elements: stray close tags dropped, each trimmed, the
     *  non-empty ones joined with a single space. */
    private static String mixedText(List<String> segments, boolean ci) {
        Pattern close = Pattern.compile(CLOSE_TAG_RE, ci ? Pattern.CASE_INSENSITIVE : 0);
        List<String> parts = new ArrayList<>();
        for (String seg : segments) {
            String t = decodeEntities(close.matcher(seg).replaceAll("").trim());
            if (!t.isEmpty()) parts.add(t);
        }
        return String.join(" ", parts);
    }

    /** A text body: bare {@code String} when there are no attributes, else a map carrying the
     *  attributes plus the text under {@link #TEXT_KEY}. */
    private Object textValue(Map<String, Object> attrs, String content) {
        String text = decodeEntities(content.trim());
        if (attrs.isEmpty()) return text;
        Map<String, Object> m = new LinkedHashMap<>(attrs);
        m.put(TEXT_KEY, text);
        return m;
    }

    private Map<String, Object> parseAttrs(String rawAttrs, boolean ci) {
        Map<String, Object> attrs = new LinkedHashMap<>();
        if (rawAttrs.isEmpty()) return attrs;
        Matcher a = ATTR.matcher(rawAttrs);
        while (a.find()) {
            String name = ci ? a.group(1).toLowerCase() : a.group(1);
            String val = a.group(2) != null ? a.group(2)
                    : a.group(3) != null ? a.group(3)
                    : a.group(4) != null ? a.group(4) : "";
            attrs.putIfAbsent(name, decodeEntities(val));
        }
        return attrs;
    }

    @SuppressWarnings("unchecked")
    private void accumulate(Map<String, Object> out, String key, Object value) {
        if (!out.containsKey(key)) {
            out.put(key, value);
            return;
        }
        Object existing = out.get(key);
        if (existing instanceof List) {
            ((List<Object>) existing).add(value);
        } else {
            List<Object> list = new ArrayList<>();
            list.add(existing);
            list.add(value);
            out.put(key, list);
        }
    }
}

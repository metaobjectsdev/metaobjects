package com.metaobjects.render.extract;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
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

    // one attribute: name = "double" | 'single' | bareword. Tolerant of surrounding whitespace.
    private static final Pattern ATTR = Pattern.compile(
            "([A-Za-z_:][A-Za-z0-9_:.\\-]*)\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s/>]+))");

    public Map<String, Object> read(String span, boolean caseInsensitive) {
        Map<String, Object> out = new LinkedHashMap<>();
        if (span == null || span.isBlank()) return out;
        int gt = span.indexOf('>');
        if (gt < 0) return out;
        int rootEnd = span.lastIndexOf("</");
        String inner = span.substring(gt + 1, (rootEnd < 0 || rootEnd <= gt) ? span.length() : rootEnd);
        parseChildren(inner, caseInsensitive, out);
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
        parseChildren(text, caseInsensitive, out);
        return out;
    }

    private void parseChildren(String inner, boolean ci, Map<String, Object> out) {
        Pattern openTag = Pattern.compile(OPEN_TAG_RE, ci ? Pattern.CASE_INSENSITIVE : 0);
        Matcher m = openTag.matcher(inner);
        int pos = 0;
        while (m.find(pos)) {
            String tag = m.group(1);
            String key = ci ? tag.toLowerCase() : tag;

            String rawAttrs = m.group(2) == null ? "" : m.group(2).trim();
            boolean selfClosing = rawAttrs.endsWith("/");
            if (selfClosing) rawAttrs = rawAttrs.substring(0, rawAttrs.length() - 1).trim();
            Map<String, Object> attrs = parseAttrs(rawAttrs, ci);

            if (selfClosing) {
                accumulate(out, key, attrs.isEmpty() ? "" : attrs);
                pos = m.end();
                continue;
            }

            int contentStart = m.end();
            String closeRe = "</" + Pattern.quote(tag) + "\\s*>";
            Matcher close = Pattern.compile(closeRe, ci ? Pattern.CASE_INSENSITIVE : 0).matcher(inner);
            int contentEnd, next;
            if (close.find(contentStart)) {
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
            }
            String content = inner.substring(contentStart, contentEnd);
            accumulate(out, key, combine(attrs, content, ci));
            pos = next;
        }
    }

    /** Combine an element's attributes with its body (nested children or plain text). */
    private Object combine(Map<String, Object> attrs, String content, boolean ci) {
        if (content.contains("<")) {
            Map<String, Object> nested = new LinkedHashMap<>();
            parseChildren(content, ci, nested);
            if (!nested.isEmpty()) {
                // attributes first; a child element takes precedence on a name collision
                Map<String, Object> merged = new LinkedHashMap<>(attrs);
                merged.putAll(nested);
                return merged;
            }
        }
        return textValue(attrs, content);
    }

    /** A text body: bare {@code String} when there are no attributes, else a map carrying the
     *  attributes plus the text under {@link #TEXT_KEY}. */
    private Object textValue(Map<String, Object> attrs, String content) {
        String text = content.trim();
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
            attrs.putIfAbsent(name, val);
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

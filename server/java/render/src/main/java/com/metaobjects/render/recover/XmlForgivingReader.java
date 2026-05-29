package com.metaobjects.render.recover;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Stage-4 tolerant XML reader for the bounded corpus malformation set. Never throws. */
public final class XmlForgivingReader {

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

    private void parseChildren(String inner, boolean ci, Map<String, Object> out) {
        Pattern openTag = Pattern.compile("<([A-Za-z_][A-Za-z0-9_]*)(\\s[^>]*)?>", ci ? Pattern.CASE_INSENSITIVE : 0);
        Matcher m = openTag.matcher(inner);
        int pos = 0;
        while (m.find(pos)) {
            String tag = m.group(1);
            String key = ci ? tag.toLowerCase() : tag;
            int contentStart = m.end();
            String closeRe = "</" + Pattern.quote(tag) + "\\s*>";
            Matcher close = Pattern.compile(closeRe, ci ? Pattern.CASE_INSENSITIVE : 0).matcher(inner);
            int contentEnd, next;
            if (close.find(contentStart)) {
                contentEnd = close.start();
                next = close.end();
            } else {
                // unclosed tag: recover text up to the next sibling open tag
                Matcher sib = openTag.matcher(inner);
                if (sib.find(contentStart)) {
                    contentEnd = sib.start();
                    next = contentEnd;
                } else {
                    contentEnd = inner.length();
                    next = inner.length();
                }
            }
            String content = inner.substring(contentStart, contentEnd);
            Object value = content.contains("<")
                    ? nestedOrText(content, ci)
                    : content.trim();
            accumulate(out, key, value);
            pos = next;
        }
    }

    private Object nestedOrText(String content, boolean ci) {
        Map<String, Object> nested = new LinkedHashMap<>();
        parseChildren(content, ci, nested);
        return nested.isEmpty() ? content.trim() : nested;
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

package com.metaobjects.render.extract;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Stages 2–3: isolate and select the payload root span. JSON: Extract picks among jsonCandidates by the schema (fenced first, first object carrying a declared field); json() (first-closed-else-first-open) is its fallback. */
public final class Locate {
    private Locate() {}

    /** First balanced {...}; if none closes, first '{' to end; null if no '{'. */
    public static String json(String text) {
        if (text == null) return null;
        int firstOpen = -1;
        for (int i = 0; i < text.length(); i++) {
            if (text.charAt(i) == '{') {
                if (firstOpen < 0) firstOpen = i;
                int end = scanBalanced(text, i);
                if (end >= 0) return text.substring(i, end + 1);
            }
        }
        return firstOpen < 0 ? null : text.substring(firstOpen);
    }

    /** Returns index of the matching '}', or -1 if unterminated. String-aware. */
    /**
     * Every top-level object span in {@code text}, in order: each balanced {...} (nested objects
     * are part of their parent, not separate spans), and, for a '{' that never closes, the text
     * from it to the end.
     */
    public static List<String> jsonCandidates(String text) {
        List<String> out = new ArrayList<>();
        if (text == null) return out;
        boolean tailAdded = false;
        for (int i = 0; i < text.length(); i++) {
            if (text.charAt(i) != '{') continue;
            int end = scanBalanced(text, i);
            if (end >= 0) {
                out.add(text.substring(i, end + 1));
                i = end;
            } else if (!tailAdded) {
                out.add(text.substring(i));
                tailAdded = true;
            }
        }
        return out;
    }

    /** The characters a JSON comment may follow: whitespace or a structural separator. */
    private static boolean isCommentLead(char c) {
        return Character.isWhitespace(c) || c == ',' || c == '{' || c == '[';
    }

    private static int scanBalanced(String s, int open) {
        int depth = 0;
        boolean inStr = false;
        boolean esc = false;
        for (int i = open; i < s.length(); i++) {
            char c = s.charAt(i);
            if (inStr) {
                if (esc) esc = false;
                else if (c == '\\') esc = true;
                else if (c == '"') inStr = false;
                continue;
            }
            // Comment-aware: a brace or quote inside `// good } really` must not close the
            // object early. Only after whitespace or a separator, so `http://x` is no comment.
            if (i > open && isCommentLead(s.charAt(i - 1))) {
                int end = JsonForgivingReader.commentEnd(s, i);
                if (end >= 0) { i = end - 1; continue; }
            }
            if (c == '"') inStr = true;
            else if (c == '{') depth++;
            else if (c == '}') { depth--; if (depth == 0) return i; }
        }
        return -1;
    }

    /** Span of <root>...</root>; if close absent, opener to end; null if no opener. */
    public static String xml(String text, String rootName, boolean caseInsensitive) {
        if (text == null || rootName == null) return null;
        int flags = caseInsensitive ? Pattern.CASE_INSENSITIVE : 0;
        Matcher open = Pattern.compile("<" + Pattern.quote(rootName) + "(\\s[^>]*)?>", flags).matcher(text);
        if (!open.find()) return null;
        int start = open.start();
        Matcher close = Pattern.compile("</" + Pattern.quote(rootName) + "\\s*>", flags).matcher(text);
        if (close.find(open.end())) return text.substring(start, close.end());
        return text.substring(start);
    }
}

package com.metaobjects.render.recover;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Stages 2–3: isolate and select the payload root span. Selection rule: first-closed-else-first-open. */
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

package com.metaobjects.render.extract;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Stage 1: remove markdown code-fence markers. Prose around the payload is left for Locate. */
public final class Strip {
    private Strip() {}

    // An opening fence: a run of 3+ backticks, an optional language tag (json/xml/etc, dropped), a line end.
    private static final Pattern OPEN = Pattern.compile("(`{3,})[a-zA-Z0-9_-]*\\s*\\r?\\n");

    /** One fenced block: where it starts and ends in the reply, and its body. */
    private record Fence(int start, int end, String body) {}

    /**
     * Every fenced block, in order. A fence closes at a line that starts with a backtick run at
     * least as long as the opening one and carries nothing else, so backticks inside the payload
     * (a JSON string holding `make` or a nested code sample) do not truncate it. A reply that
     * closes on the payload's own line is accepted when that run ends the text.
     */
    private static List<Fence> fences(String raw) {
        List<Fence> out = new ArrayList<>();
        Matcher m = OPEN.matcher(raw);
        int pos = 0;
        while (pos <= raw.length() && m.find(pos)) {
            int[] close = findClose(raw, m.end(), m.group(1).length());
            if (close == null) { pos = m.end(); continue; }
            out.add(new Fence(m.start(), close[1], raw.substring(m.end(), close[0])));
            pos = close[1];
        }
        return out;
    }

    /** {bodyEnd, end} of the closing fence, or null when the block never closes. */
    private static int[] findClose(String raw, int from, int width) {
        for (int ls = from; ls <= raw.length(); ) {
            int i = ls;
            while (i < raw.length() && (raw.charAt(i) == ' ' || raw.charAt(i) == '\t') && i - ls < 4) i++;
            int j = i;
            while (j < raw.length() && raw.charAt(j) == '`') j++;
            if (j - i >= width) {
                int k = j;
                while (k < raw.length() && (raw.charAt(k) == ' ' || raw.charAt(k) == '\t')) k++;
                if (k >= raw.length() || raw.charAt(k) == '\n' || raw.charAt(k) == '\r') {
                    return new int[] {bodyEnd(raw, from, ls), j};
                }
            }
            int nl = raw.indexOf('\n', ls);
            if (nl < 0) break;
            ls = nl + 1;
        }
        // No closing line: accept a final backtick run that ends the text on the payload's own line.
        int tail = raw.length();
        while (tail > from && Character.isWhitespace(raw.charAt(tail - 1))) tail--;
        int k = tail;
        while (k > from && raw.charAt(k - 1) == '`') k--;
        return tail - k >= width && k > from ? new int[] {k, tail} : null;
    }

    private static int bodyEnd(String raw, int from, int lineStart) {
        int e = lineStart;
        if (e > from && raw.charAt(e - 1) == '\n') e--;
        if (e > from && raw.charAt(e - 1) == '\r') e--;
        return e;
    }

    /** The body of every fenced block, in order. Locate searches these before the whole text,
     *  because a model told to fence its answer puts the answer there. */
    public static List<String> fencedBodies(String raw) {
        List<String> out = new ArrayList<>();
        if (raw == null) return out;
        for (Fence f : fences(raw)) out.add(f.body());
        return out;
    }

    public static String strip(String raw) {
        if (raw == null) return "";
        List<Fence> fences = fences(raw);
        if (!fences.isEmpty()) {
            Fence f = fences.get(0);
            return (raw.substring(0, f.start()) + f.body() + raw.substring(f.end())).trim();
        }
        return raw.trim();
    }
}

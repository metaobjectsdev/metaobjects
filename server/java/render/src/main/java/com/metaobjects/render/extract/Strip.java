package com.metaobjects.render.extract;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Stage 1: remove markdown code-fence markers. Prose around the payload is left for Locate. */
public final class Strip {
    private Strip() {}

    // Captures the body inside a fenced block; optional language tag (json/xml/etc) is dropped.
    private static final Pattern FENCE = Pattern.compile(
            "```[a-zA-Z0-9_-]*\\s*\\r?\\n(.*?)\\r?\\n?```",
            Pattern.DOTALL);

    /** The body of every fenced block, in order. Locate searches these before the whole text,
     *  because a model told to fence its answer puts the answer there. */
    public static List<String> fencedBodies(String raw) {
        List<String> out = new ArrayList<>();
        if (raw == null) return out;
        Matcher m = FENCE.matcher(raw);
        while (m.find()) out.add(m.group(1));
        return out;
    }

    public static String strip(String raw) {
        if (raw == null) return "";
        Matcher m = FENCE.matcher(raw);
        if (m.find()) {
            return (raw.substring(0, m.start()) + m.group(1) + raw.substring(m.end())).trim();
        }
        return raw.trim();
    }
}

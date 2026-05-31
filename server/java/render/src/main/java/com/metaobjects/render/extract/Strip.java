package com.metaobjects.render.extract;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Stage 1: remove markdown code-fence markers. Prose around the payload is left for Locate. */
public final class Strip {
    private Strip() {}

    // Captures the body inside a fenced block; optional language tag (json/xml/etc) is dropped.
    private static final Pattern FENCE = Pattern.compile(
            "```[a-zA-Z0-9_-]*\\s*\\r?\\n(.*?)\\r?\\n?```",
            Pattern.DOTALL);

    public static String strip(String raw) {
        if (raw == null) return "";
        Matcher m = FENCE.matcher(raw);
        if (m.find()) {
            return (raw.substring(0, m.start()) + m.group(1) + raw.substring(m.end())).trim();
        }
        return raw.trim();
    }
}

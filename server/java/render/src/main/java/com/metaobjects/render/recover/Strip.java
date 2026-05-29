package com.metaobjects.render.recover;

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
            StringBuilder sb = new StringBuilder();
            sb.append(raw, 0, m.start());
            sb.append(m.group(1));
            sb.append(raw.substring(m.end()));
            return sb.toString().trim();
        }
        return raw.trim();
    }
}

package com.metaobjects.render;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;

/**
 * One Mustache tag scanner shared by {@link Verify} and the renderer's partial
 * expansion.
 *
 * <p>Both used to find tags on their own ({@code Verify} with a {@code {{} search,
 * {@code Renderer} with a {@code {{> x}}} regex), and neither knew what the engine
 * knows: a comment ends at the first closing delimiter, {@code {{=<% %>=}}} changes
 * the delimiters, and a section close must name the section it closes. {@link #scan}
 * follows the Mustache spec for all three, so the two callers cannot disagree about
 * where a tag is. Mirrors {@code Mustache.parse} in the TypeScript port and the C# and
 * Python scanners.
 */
final class MustacheTags {

    enum Kind { NAME, TRIPLE, AMP, SECTION, INVERTED, CLOSE, PARTIAL, COMMENT, DELIMITERS }

    /** One tag: its kind, trimmed name, and {@code [start, end)} span in the text. */
    record Tag(Kind kind, String value, int start, int end) {}

    /** An unbalanced section; {@link #section()} is the section the finding is about. */
    static final class SyntaxException extends RuntimeException {
        private final String section;

        SyntaxException(String message, String section) {
            super(message);
            this.section = section;
        }

        String section() {
            return section;
        }
    }

    private static final String DEFAULT_OPEN = "{{";
    private static final String DEFAULT_CLOSE = "}}";

    private MustacheTags() {}

    /**
     * Every tag in {@code text}, in order, honouring comments and delimiter changes.
     * Throws {@link SyntaxException} for a close with no open, a close naming a different
     * section than the one open, or a section never closed. An unterminated tag ends the
     * scan (the rest is text), as it always did here.
     */
    static List<Tag> scan(String text) {
        List<Tag> tags = new ArrayList<>();
        String open = DEFAULT_OPEN;
        String close = DEFAULT_CLOSE;
        Deque<String> openSections = new ArrayDeque<>();
        int pos = 0;
        while (pos < text.length()) {
            int start = text.indexOf(open, pos);
            if (start < 0) break;
            int contentStart = start + open.length();
            boolean triple = contentStart < text.length() && text.charAt(contentStart) == '{';
            String endDelim = triple ? "}" + close : close;
            if (triple) contentStart++;
            int closeIdx = text.indexOf(endDelim, contentStart);
            if (closeIdx < 0) break;
            String content = text.substring(contentStart, closeIdx).trim();
            int end = closeIdx + endDelim.length();
            pos = end;

            if (triple) {
                tags.add(new Tag(Kind.TRIPLE, content, start, end));
                continue;
            }
            if (content.isEmpty()) continue;
            char sigil = content.charAt(0);
            String name = content.length() > 1 ? content.substring(1).trim() : "";
            switch (sigil) {
                case '!' -> tags.add(new Tag(Kind.COMMENT, name, start, end));
                case '=' -> {
                    if (content.length() > 1 && content.endsWith("=")) {
                        String[] parts = content.substring(1, content.length() - 1).trim().split("\\s+");
                        if (parts.length == 2) {
                            open = parts[0];
                            close = parts[1];
                        }
                    }
                    tags.add(new Tag(Kind.DELIMITERS, name, start, end));
                }
                case '#', '^' -> {
                    openSections.push(name);
                    tags.add(new Tag(sigil == '#' ? Kind.SECTION : Kind.INVERTED, name, start, end));
                }
                case '/' -> {
                    if (openSections.isEmpty()) {
                        throw new SyntaxException("Unopened section \"" + name + "\"", name);
                    }
                    String opened = openSections.pop();
                    if (!opened.equals(name)) {
                        throw new SyntaxException("Unclosed section \"" + opened + "\"", opened);
                    }
                    tags.add(new Tag(Kind.CLOSE, name, start, end));
                }
                case '>' -> tags.add(new Tag(Kind.PARTIAL, name, start, end));
                case '&' -> tags.add(new Tag(Kind.AMP, name, start, end));
                default -> tags.add(new Tag(Kind.NAME, content, start, end));
            }
        }
        if (!openSections.isEmpty()) {
            String opened = openSections.peek();
            throw new SyntaxException("Unclosed section \"" + opened + "\"", opened);
        }
        return tags;
    }

    /**
     * Where a text that changes delimiters cannot render, or {@code null} when it can: inlined
     * text is parsed under the surrounding delimiters. A partial body ({@code inlinedAs} is its
     * ref) that changes them is reported at that ref; a text that changes them and inlines a
     * partial is reported at its first partial.
     */
    static String delimiterConflict(List<Tag> tags, String inlinedAs) {
        if (tags.stream().noneMatch(t -> t.kind() == Kind.DELIMITERS)) return null;
        if (inlinedAs != null) return inlinedAs;
        return tags.stream().filter(t -> t.kind() == Kind.PARTIAL).map(Tag::value).findFirst().orElse(null);
    }

    /** {@code text} with every comment cut out: what a tag-presence check may scan. */
    static String withoutComments(String text, List<Tag> tags) {
        StringBuilder sb = new StringBuilder(text.length());
        int pos = 0;
        for (Tag tag : tags) {
            if (tag.kind() != Kind.COMMENT) continue;
            sb.append(text, pos, tag.start());
            pos = tag.end();
        }
        return sb.append(text, pos, text.length()).toString();
    }
}

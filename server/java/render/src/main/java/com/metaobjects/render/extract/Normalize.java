package com.metaobjects.render.extract;

/**
 * FR-011: enum-variant normalization for the {@link Coerce} stage.
 *
 * <p>ASCII-only by design: enum members are ASCII identifiers, so a pure {@code [A-Za-z0-9]}
 * transform is byte-identical across ports and sidesteps locale case-folding (Turkish-I).
 * The mode comes from the {@code @normalize} attr ({@code none|collapse|strip}; default
 * {@code strip}). Mirrors the TS {@code normalizeEnum} and the C# {@code Normalize.Enum}.</p>
 *
 * <p><strong>Uppercasing is a manual a&ndash;z &rarr; A&ndash;Z fold</strong>, NOT
 * {@link String#toUpperCase()} (locale-sensitive) nor {@code toUpperCase(Locale.ROOT)}
 * (still Unicode). Only the 26 ASCII lowercase letters are folded; every other code unit
 * passes through unchanged.</p>
 */
public final class Normalize {

    private Normalize() {}

    /** FR-011 {@code @normalize} mode — exact match only (no normalization). */
    public static final String NONE = "none";

    /** FR-011 {@code @normalize} mode — ASCII-upper + trim + collapse runs of {@code [\s_-]+} to {@code _}. */
    public static final String COLLAPSE = "collapse";

    /** FR-011 {@code @normalize} mode — ASCII-upper + keep only {@code [A-Z0-9]}. The default. */
    public static final String STRIP = "strip";

    /** FR-011 default {@code @normalize} mode when absent on both field and owning object. */
    public static final String DEFAULT = STRIP;

    /**
     * ASCII-only enum normalization. Pure {@code [A-Za-z0-9]} transform &rarr; byte-identical cross-port.
     * <ul>
     *   <li>{@code none} — identity.</li>
     *   <li>{@code collapse} — ASCII-upper + trim + collapse runs of {@code [\s_-]+} to a single {@code _}.</li>
     *   <li>{@code strip} — ASCII-upper + keep only {@code [A-Z0-9]}.</li>
     * </ul>
     *
     * @param s    the raw value (or enum member) to normalize
     * @param mode one of {@link #NONE} / {@link #COLLAPSE} / {@link #STRIP}; any unknown mode
     *             is treated as {@link #STRIP} (the default), matching the cross-port resolver
     * @return the normalized string
     */
    public static String enumValue(String s, String mode) {
        if (NONE.equals(mode)) return s;
        String up = asciiUpper(s.trim());
        return COLLAPSE.equals(mode) ? collapseSeparators(up) : stripNonAlnum(up);
    }

    /** ASCII-only uppercasing (a-z -&gt; A-Z); all other code units pass through unchanged. */
    private static String asciiUpper(String s) {
        StringBuilder sb = new StringBuilder(s.length());
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            sb.append(c >= 'a' && c <= 'z' ? (char) (c - 32) : c);
        }
        return sb.toString();
    }

    /** Collapse runs of whitespace / underscore / hyphen into a single underscore (mirrors {@code /[\s_-]+/g -> "_"}). */
    private static String collapseSeparators(String s) {
        StringBuilder sb = new StringBuilder(s.length());
        boolean inRun = false;
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (isSeparator(c)) {
                if (!inRun) {
                    sb.append('_');
                    inRun = true;
                }
            } else {
                sb.append(c);
                inRun = false;
            }
        }
        return sb.toString();
    }

    /** Keep only {@code [A-Z0-9]} (mirrors {@code /[^A-Z0-9]/g -> ""} on an already-uppercased string). */
    private static String stripNonAlnum(String s) {
        StringBuilder sb = new StringBuilder(s.length());
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if ((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')) sb.append(c);
        }
        return sb.toString();
    }

    /**
     * True for a character matched by the JS {@code \s} class OR {@code _} OR {@code -}.
     * The corpus only exercises ASCII space, but the full set keeps cross-port parity for collapse.
     */
    private static boolean isSeparator(char c) {
        if (c == '_' || c == '-') return true;
        switch (c) {
            case ' ':        // space
            case '\t':       // tab
            case '\n':       // line feed
            case '\u000B':   // vertical tab
            case '\f':       // form feed
            case '\r':       // carriage return
            case '\u00A0':   // no-break space
            case '\u1680':   // ogham space mark
            case '\u2028':   // line separator
            case '\u2029':   // paragraph separator
            case '\u202F':   // narrow no-break space
            case '\u205F':   // medium mathematical space
            case '\u3000':   // ideographic space
            case '\uFEFF':   // zero-width no-break space (BOM)
                return true;
            default:
                // U+2000..U+200A (en/em/thin spaces etc.) -- JS \s range.
                return c >= '\u2000' && c <= '\u200A';
        }
    }
}

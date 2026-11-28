package com.metaobjects.docsview;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;

import java.math.BigDecimal;
import java.math.BigInteger;
import java.util.Map;

/**
 * JSON text exactly as JavaScript's {@code JSON.stringify} writes it, which is what the docs view
 * contract states its bytes in ({@code docs/features/docs-view.md}): {@link #pretty} is
 * {@code JSON.stringify(v, null, 2)}, {@link #compact} is {@code JSON.stringify(v)}.
 *
 * <p>Gson's own writer differs in the places that matter for byte parity: it escapes HTML
 * characters and the line separators, and it writes a double as {@code 3.0}. This writer escapes
 * only what {@code JSON.stringify} escapes (the quote, the backslash, control characters and lone
 * surrogates) and writes a number as a JavaScript {@code Number} prints.</p>
 */
public final class DocsViewJson {

    private DocsViewJson() {}

    /** Two-space indented JSON, as {@code JSON.stringify(v, null, 2)}. */
    public static String pretty(JsonElement value) {
        StringBuilder out = new StringBuilder();
        write(out, value, "", true);
        return out.toString();
    }

    /** JSON with no whitespace, as {@code JSON.stringify(v)}. */
    public static String compact(JsonElement value) {
        StringBuilder out = new StringBuilder();
        write(out, value, "", false);
        return out.toString();
    }

    /** A string as a JSON string literal, as {@code JSON.stringify(s)}. */
    public static String quote(String s) {
        StringBuilder out = new StringBuilder(s.length() + 2);
        writeString(out, s);
        return out.toString();
    }

    private static void write(StringBuilder out, JsonElement value, String indent, boolean pretty) {
        if (value == null || value.isJsonNull()) {
            out.append("null");
        } else if (value.isJsonObject()) {
            JsonObject obj = value.getAsJsonObject();
            if (obj.size() == 0) {
                out.append("{}");
                return;
            }
            String inner = indent + "  ";
            out.append('{');
            boolean first = true;
            for (Map.Entry<String, JsonElement> e : obj.entrySet()) {
                if (!first) out.append(',');
                first = false;
                if (pretty) out.append('\n').append(inner);
                writeString(out, e.getKey());
                out.append(pretty ? ": " : ":");
                write(out, e.getValue(), inner, pretty);
            }
            if (pretty) out.append('\n').append(indent);
            out.append('}');
        } else if (value.isJsonArray()) {
            JsonArray arr = value.getAsJsonArray();
            if (arr.isEmpty()) {
                out.append("[]");
                return;
            }
            String inner = indent + "  ";
            out.append('[');
            for (int i = 0; i < arr.size(); i++) {
                if (i > 0) out.append(',');
                if (pretty) out.append('\n').append(inner);
                write(out, arr.get(i), inner, pretty);
            }
            if (pretty) out.append('\n').append(indent);
            out.append(']');
        } else {
            JsonPrimitive p = value.getAsJsonPrimitive();
            if (p.isBoolean()) out.append(p.getAsBoolean());
            else if (p.isNumber()) out.append(number(p.getAsNumber()));
            else writeString(out, p.getAsString());
        }
    }

    private static void writeString(StringBuilder out, String s) {
        out.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"' -> out.append("\\\"");
                case '\\' -> out.append("\\\\");
                case '\b' -> out.append("\\b");
                case '\f' -> out.append("\\f");
                case '\n' -> out.append("\\n");
                case '\r' -> out.append("\\r");
                case '\t' -> out.append("\\t");
                default -> {
                    if (c < 0x20) {
                        unicodeEscape(out, c);
                    } else if (Character.isHighSurrogate(c)) {
                        if (i + 1 < s.length() && Character.isLowSurrogate(s.charAt(i + 1))) {
                            out.append(c).append(s.charAt(++i));
                        } else {
                            unicodeEscape(out, c);
                        }
                    } else if (Character.isLowSurrogate(c)) {
                        unicodeEscape(out, c);
                    } else {
                        out.append(c);
                    }
                }
            }
        }
        out.append('"');
    }

    private static void unicodeEscape(StringBuilder out, char c) {
        out.append("\\u");
        String hex = Integer.toHexString(c);
        for (int k = hex.length(); k < 4; k++) out.append('0');
        out.append(hex);
    }

    /** A number as JavaScript's {@code Number.prototype.toString} writes it. */
    static String number(Number n) {
        if (n instanceof Integer || n instanceof Long || n instanceof Short || n instanceof Byte) {
            long v = n.longValue();
            // A JavaScript number holds integers exactly up to 2^53; beyond that it prints the
            // nearest double, as JSON.parse would have read it.
            if (Math.abs(v) <= (1L << 53)) return Long.toString(v);
            return number((double) v);
        }
        if (n instanceof BigInteger || n instanceof BigDecimal) return number(n.doubleValue());
        double d = n.doubleValue();
        return number(d);
    }

    private static String number(double d) {
        if (Double.isNaN(d) || Double.isInfinite(d)) return "null";
        if (d == 0) return "0";
        // Double.toString gives the shortest digits that round-trip (JDK 19+), as JavaScript does.
        BigDecimal exact = new BigDecimal(Double.toString(Math.abs(d))).stripTrailingZeros();
        String digits = exact.unscaledValue().toString();
        int k = digits.length();
        // The decimal exponent n of ECMA-262 Number::toString: value = 0.digits x 10^n.
        int e = k - exact.scale();
        StringBuilder out = new StringBuilder();
        if (d < 0) out.append('-');
        if (k <= e && e <= 21) {
            out.append(digits);
            for (int i = 0; i < e - k; i++) out.append('0');
        } else if (0 < e && e <= 21) {
            out.append(digits, 0, e).append('.').append(digits, e, k);
        } else if (-6 < e && e <= 0) {
            out.append("0.");
            for (int i = 0; i < -e; i++) out.append('0');
            out.append(digits);
        } else {
            int exp = e - 1;
            out.append(digits.charAt(0));
            if (k > 1) out.append('.').append(digits, 1, k);
            out.append('e').append(exp < 0 ? '-' : '+').append(Math.abs(exp));
        }
        return out.toString();
    }
}

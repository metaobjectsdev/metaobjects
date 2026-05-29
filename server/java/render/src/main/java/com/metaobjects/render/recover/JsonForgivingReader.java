package com.metaobjects.render.recover;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Stage-4 tolerant JSON reader for the bounded corpus malformation set. Never throws. */
public final class JsonForgivingReader {
    /** Sentinel: a key appeared in the text but its value was empty/cut-off (present-but-garbled). */
    static final Object TRUNCATED = new Object();

    private String s;
    private int i;

    public Map<String, Object> read(String span) {
        this.s = span == null ? "" : span;
        this.i = 0;
        ws();
        if (i >= s.length() || s.charAt(i) != '{') return new LinkedHashMap<>();
        Object o = readValue();
        return (o instanceof Map) ? castMap(o) : new LinkedHashMap<>();
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> castMap(Object o) { return (Map<String, Object>) o; }

    private Object readValue() {
        ws();
        if (i >= s.length()) return null;
        char c = s.charAt(i);
        if (c == '{') return readObject();
        if (c == '[') return readArray();
        if (c == '"' || c == '\'') return readString(c);
        return readBareScalar();
    }

    private Object readObject() {
        Map<String, Object> m = new LinkedHashMap<>();
        i++; // consume '{'
        while (true) {
            ws();
            if (i >= s.length()) return m;            // truncation
            if (s.charAt(i) == '}') { i++; return m; }
            String key = readKey();
            if (key == null) return m;                 // truncation mid-key
            ws();
            if (i >= s.length() || s.charAt(i) != ':') return m; // truncation before value
            i++; // consume ':'
            ws();
            if (i >= s.length()) { m.put(key, TRUNCATED); return m; }  // value cut off at EOF → present-but-garbled
            Object v = readValue();
            if (v == null) {                           // present key, empty/zero-width value → present-but-garbled
                m.put(key, TRUNCATED);
                ws();
                if (i < s.length() && s.charAt(i) == ',') { i++; continue; }
                if (i < s.length() && s.charAt(i) == '}') { i++; }
                return m;
            }
            m.put(key, v);
            ws();
            if (i < s.length() && s.charAt(i) == ',') i++; // optional/trailing comma
        }
    }

    private Object readArray() {
        List<Object> xs = new ArrayList<>();
        i++; // consume '['
        while (true) {
            ws();
            if (i >= s.length()) return xs;
            if (s.charAt(i) == ']') { i++; return xs; }
            if (s.charAt(i) == '}') { i++; return xs; }   // malformed brace-close terminates array
            Object v = readValue();
            if (v == null) {                              // zero-width / no value → stop (no spin)
                ws();
                if (i < s.length() && (s.charAt(i) == ']' || s.charAt(i) == '}')) i++;
                return xs;
            }
            xs.add(v);
            ws();
            if (i < s.length() && s.charAt(i) == ',') i++;
            else if (i < s.length() && s.charAt(i) == ']') { i++; return xs; }
            else if (i >= s.length()) return xs;
            else return xs;                               // any other non-separator char → stop
        }
    }

    private String readKey() {
        ws();
        if (i >= s.length()) return null;
        char c = s.charAt(i);
        if (c == '"' || c == '\'') return (String) readString(c);
        int start = i;
        while (i < s.length() && (Character.isLetterOrDigit(s.charAt(i)) || s.charAt(i) == '_')) i++;
        return i > start ? s.substring(start, i) : null;
    }

    private Object readString(char quote) {
        i++; // opening quote
        StringBuilder sb = new StringBuilder();
        boolean esc = false;
        while (i < s.length()) {
            char c = s.charAt(i++);
            if (esc) { sb.append(unescape(c)); esc = false; }
            else if (c == '\\') esc = true;
            else if (c == quote) return sb.toString();
            else sb.append(c);
        }
        return sb.toString(); // unterminated string → return what we have
    }

    private static char unescape(char c) {
        return switch (c) { case 'n' -> '\n'; case 't' -> '\t'; case 'r' -> '\r'; default -> c; };
    }

    private Object readBareScalar() {
        int start = i;
        while (i < s.length() && ",}]".indexOf(s.charAt(i)) < 0) i++;
        String result = s.substring(start, i).trim();
        return result.isEmpty() ? null : result;   // null = no token read (zero-width)
    }

    private void ws() { while (i < s.length() && Character.isWhitespace(s.charAt(i))) i++; }
}

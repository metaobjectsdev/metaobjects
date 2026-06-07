/*
 * Copyright 2003 Doug Mealing LLC dba Meta Objects
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
package com.metaobjects.source;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;

/**
 * Canonical JSONPath builder (FR5a / ADR-0009).
 *
 * <p>Construction rules — cross-port-aligned; every port emits this canonical
 * form byte-identically:</p>
 * <ul>
 *   <li>Root is {@code $}.</li>
 *   <li>Object keys matching {@code ^[A-Za-z_][A-Za-z0-9_]*$} use dot notation:
 *       {@code .foo}.</li>
 *   <li>All other keys use single-quoted bracket form: {@code ['my-key']},
 *       {@code ['@attr']}.</li>
 *   <li>Array indices use bracket form: {@code [N]}.</li>
 *   <li>Embedded single quotes are escaped as {@code \'}.</li>
 *   <li>No trailing dots, no whitespace.</li>
 * </ul>
 *
 * <p>Mirrors {@code JsonPathBuilder} in
 * {@code server/csharp/MetaObjects/Source/JsonPath.cs} and
 * {@code typescript/packages/metadata/src/json-path.ts}.</p>
 *
 * <p>Static one-shot helpers ({@link #segmentForKey(String)},
 * {@link #segmentForIndex(int)}) cover the cases where a builder is overkill.</p>
 */
public final class JsonPath {

    /** Identifier regex for dot-vs-bracket dispatch. Package-private so the builder can share it. */
    static final Pattern IDENT = Pattern.compile("^[A-Za-z_][A-Za-z0-9_]*$");

    private JsonPath() {
        // Static-only utility.
    }

    /**
     * Render a single object-key segment as it would appear in canonical form,
     * without the leading {@code $} — i.e. {@code .foo} or {@code ['my-key']}.
     *
     * @param key the object key
     * @return the segment rendering
     */
    public static String segmentForKey(String key) {
        if (IDENT.matcher(key).matches()) {
            return "." + key;
        }
        return "['" + escapeSingleQuotes(key) + "']";
    }

    /**
     * Render a single array-index segment: {@code [N]}.
     *
     * @param idx the zero-based array index
     * @return the segment rendering
     */
    public static String segmentForIndex(int idx) {
        return "[" + idx + "]";
    }

    /**
     * Escape embedded single quotes in a key for bracket-quoted output.
     *
     * <p>The canonical form escapes {@code '} as {@code \'} (mirrors the C# /
     * TS implementations).</p>
     */
    static String escapeSingleQuotes(String s) {
        if (s.indexOf('\'') < 0) {
            return s;
        }
        return s.replace("'", "\\'");
    }

    /**
     * Mutable builder that mirrors the parser's tree-walk: push a key or index
     * when descending into a child, pop when returning.
     *
     * <p>This class is intentionally not {@link Cloneable} — each parse uses
     * its own builder. Not thread-safe.</p>
     */
    public static final class Builder {

        private final List<Segment> segments = new ArrayList<>();

        /** Push an object-key segment (e.g. {@code .foo} or {@code ['my-key']}). */
        public void pushKey(String key) {
            segments.add(new Segment(SegmentKind.KEY, key, 0));
        }

        /** Push an array-index segment (e.g. {@code [2]}). */
        public void pushIndex(int idx) {
            segments.add(new Segment(SegmentKind.INDEX, null, idx));
        }

        /**
         * Pop the most recently pushed segment.
         *
         * <p>No-op when the stack is empty — pop balance is the caller's
         * responsibility, but a defensive bottom matches the C# behavior so
         * the builder never throws on imbalanced parse paths.</p>
         */
        public void pop() {
            if (!segments.isEmpty()) {
                segments.remove(segments.size() - 1);
            }
        }

        /** Number of segments currently on the stack (root is segment 0; not counted). */
        public int depth() {
            return segments.size();
        }

        /**
         * Render the current stack as a canonical JSONPath string.
         *
         * @return the canonical form (always starts with {@code $})
         */
        @Override
        public String toString() {
            // ~8 chars per segment is a reasonable starting cap.
            StringBuilder sb = new StringBuilder(segments.size() * 8 + 1);
            sb.append('$');
            for (Segment seg : segments) {
                if (seg.kind == SegmentKind.INDEX) {
                    sb.append('[').append(seg.index).append(']');
                } else {
                    String key = seg.key;
                    if (IDENT.matcher(key).matches()) {
                        sb.append('.').append(key);
                    } else {
                        sb.append("['").append(escapeSingleQuotes(key)).append("']");
                    }
                }
            }
            return sb.toString();
        }

        private enum SegmentKind { KEY, INDEX }

        private static final class Segment {
            final SegmentKind kind;
            final String key;
            final int index;

            Segment(SegmentKind kind, String key, int index) {
                this.kind = kind;
                this.key = key;
                this.index = index;
            }
        }
    }
}

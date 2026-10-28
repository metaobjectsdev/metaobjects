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
package com.metaobjects.config;

import com.metaobjects.ErrorCode;
import com.metaobjects.MetaData;
import com.metaobjects.MetaDataException;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.regex.Pattern;

/**
 * FR-023 §4.3 — the scope-pattern grammar: whether a fully-qualified node name falls
 * inside a consumer's declared {@code include}/{@code exclude} scope.
 *
 * <p>A pure, no-I/O port of {@code server/typescript/packages/metadata/src/scope.ts}
 * ({@code compilePattern} / {@code compileScope} / {@code matchesScope}). The shared
 * corpus {@code fixtures/scope-conformance/cases.json} pins the semantics, so the
 * behavior must match the reference exactly:
 *
 * <ul>
 *   <li>{@code *} inside a segment matches any run of characters but never crosses a
 *       {@code ::}.</li>
 *   <li>A segment that is exactly {@code **} matches one or more whole segments.</li>
 *   <li>Every other character is literal, regex metacharacters included.</li>
 *   <li>An absent or empty {@code include} means everything; {@code exclude} is applied
 *       after it. Matching is case-sensitive.</li>
 * </ul>
 *
 * <p>This is deliberately NOT the {@code <filters>} glob of the Maven plugin
 * ({@code GeneratorUtil.createRegexFromGlob}), whose {@code *} and {@code @} are the
 * inverse of {@code **} and {@code *} here. The two are separate surfaces.
 */
public final class Scope {

    private Scope() {}

    /** One package segment: any run of characters containing no separator char. */
    private static final String SEGMENT = "[^:]+";

    /** One or more segments, separator-joined — the {@code **} expansion. */
    private static final String SEGMENTS =
            SEGMENT + "(?:" + Pattern.quote(MetaData.PKG_SEPARATOR) + SEGMENT + ")*";

    /** Regex metacharacters escaped for literal matching; mirrors the reference's class. */
    private static final String METACHARACTERS = ".*+?^${}()|[]\\";

    /** A compiled scope. Both arrays are already anchored to the whole name. */
    public static final class Compiled {
        private final List<Pattern> include;
        private final List<Pattern> exclude;

        Compiled(List<Pattern> include, List<Pattern> exclude) {
            this.include = Collections.unmodifiableList(include);
            this.exclude = Collections.unmodifiableList(exclude);
        }

        public List<Pattern> include() { return include; }

        public List<Pattern> exclude() { return exclude; }
    }

    private static String escapeLiteral(String text) {
        StringBuilder out = new StringBuilder(text.length());
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            if (METACHARACTERS.indexOf(c) >= 0) out.append('\\');
            out.append(c);
        }
        return out.toString();
    }

    /** Compile one segment. {@code **} spans segments; {@code *} never crosses a separator. */
    private static String compileSegment(String segment, String pattern) {
        if (segment.isEmpty()) {
            throw new MetaDataException(
                    "empty segment in scope pattern \"" + pattern + "\"",
                    ErrorCode.ERR_SCOPE_PATTERN_INVALID);
        }
        // A segment surviving the split on "::" can still hold a lone ":" when the
        // pattern has an odd colon run ("acme:::Order" splits to "acme", ":Order").
        // Treating it as literal would compile a pattern no legal name can match, so it
        // is refused loudly instead of silently matching nothing.
        if (segment.indexOf(':') >= 0) {
            throw new MetaDataException(
                    "scope pattern \"" + pattern + "\" has a malformed separator (an odd run of \":\")"
                            + " — segments are joined by \"::\", never a single \":\"",
                    ErrorCode.ERR_SCOPE_PATTERN_INVALID);
        }
        if (segment.equals("**")) return "(?:" + SEGMENTS + ")";
        // `*` inside a segment matches any characters except the separator char. The -1
        // limit keeps trailing empties, as the reference's split does ("a*" -> "a", "").
        String[] parts = segment.split("\\*", -1);
        List<String> escaped = new ArrayList<>(parts.length);
        for (String part : parts) escaped.add(escapeLiteral(part));
        return String.join("[^:]*", escaped);
    }

    public static Pattern compilePattern(String pattern) {
        if (pattern.isEmpty()) {
            throw new MetaDataException(
                    "scope pattern must not be empty", ErrorCode.ERR_SCOPE_PATTERN_INVALID);
        }
        // Limit -1: a trailing separator yields a trailing empty segment, which must be
        // refused rather than dropped (Java's default split discards trailing empties).
        String[] segments = pattern.split(Pattern.quote(MetaData.PKG_SEPARATOR), -1);
        List<String> body = new ArrayList<>(segments.length);
        for (String segment : segments) body.add(compileSegment(segment, pattern));
        return Pattern.compile(String.join(MetaData.PKG_SEPARATOR, body));
    }

    /** Absent ({@code null}) or empty {@code include} means "everything". */
    public static Compiled compileScope(List<String> include, List<String> exclude) {
        return new Compiled(compileAll(include), compileAll(exclude));
    }

    private static List<Pattern> compileAll(List<String> patterns) {
        List<Pattern> out = new ArrayList<>();
        if (patterns != null) for (String p : patterns) out.add(compilePattern(p));
        return out;
    }

    /** True when {@code fqn} is inside the scope. An empty {@code include} means everything. */
    public static boolean matchesScope(String fqn, Compiled compiled) {
        // matches() requires the WHOLE name to match; `$` would also accept a trailing
        // newline, which the reference's anchored regex never does.
        boolean included = compiled.include().isEmpty();
        for (Pattern p : compiled.include()) {
            if (p.matcher(fqn).matches()) { included = true; break; }
        }
        if (!included) return false;
        for (Pattern p : compiled.exclude()) {
            if (p.matcher(fqn).matches()) return false;
        }
        return true;
    }
}

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

import java.util.List;

/**
 * Post-load provenance: extends / {@code @via} / {@code @objectRef} /
 * {@code @payloadRef} resolution failure (FR5d — reserved slot; FR5a does not
 * populate this variant).
 *
 * <p>Mirrors {@code ResolvedSource} in
 * {@code server/csharp/MetaObjects/Source/ErrorSource.cs}.</p>
 *
 * @param files contributing file paths (project-root-relative, forward slashes)
 * @param jsonPath optional canonical JSONPath; may be {@code null}
 * @param referrer optional FQN of the referrer; may be {@code null}
 * @param target optional intended target FQN; may be {@code null}
 */
public record ResolvedSource(List<String> files, String jsonPath, String referrer, String target)
    implements ErrorSource {

    /**
     * Canonical constructor: defensive-copies {@code files}.
     *
     * @throws NullPointerException if {@code files} is {@code null}
     */
    public ResolvedSource {
        if (files == null) {
            throw new NullPointerException("ResolvedSource files must not be null");
        }
        files = List.copyOf(files);
    }

    /** Convenience constructor: files only, all other fields {@code null}. */
    public ResolvedSource(List<String> files) {
        this(files, null, null, null);
    }

    /**
     * FR5d — build a {@code format: "resolved"} envelope from a referrer node's
     * source envelope (typically a {@link JsonSource} or {@link YamlSource}
     * parse-time source) plus the referrer FQN and unresolved target string.
     *
     * <p>The resolved envelope carries:</p>
     * <ul>
     *   <li>{@code files}: the referrer's source files (so editors can jump to it),</li>
     *   <li>{@code jsonPath}: the referrer's jsonPath when known (the location of
     *       the broken reference on disk),</li>
     *   <li>{@code referrer}: the FQN of the metadata node that declared the broken
     *       reference (e.g. {@code "acme::Premium"}),</li>
     *   <li>{@code target}: the unresolved reference string itself (e.g.
     *       {@code "BaseEntity"}, {@code "Program.weeks.invalid"},
     *       {@code "DoesNotExist"}).</li>
     * </ul>
     *
     * <p>{@code referrerSource} may be any {@link ErrorSource} variant — we read its
     * files/jsonPath best-effort and fall back to an empty {@code files: []} when
     * the referrer's source is itself a {@link CodeSource}/{@link DatabaseSource}
     * envelope. Mirrors the TS {@code resolvedSource(referrerSource, referrer, target)}
     * helper in {@code server/typescript/packages/metadata/src/source.ts}.</p>
     *
     * @param referrerSource the source envelope of the node declaring the broken reference
     * @param referrer the FQN of the referrer node; may be {@code null}
     * @param target the unresolved reference string; may be {@code null}
     * @return a {@code format: "resolved"} envelope populated from the referrer
     */
    public static ResolvedSource from(ErrorSource referrerSource, String referrer, String target) {
        List<String> files;
        String jsonPath;
        if (referrerSource instanceof JsonSource js) {
            files = js.files();
            jsonPath = js.jsonPath();
        } else if (referrerSource instanceof YamlSource ys) {
            files = ys.files();
            jsonPath = ys.jsonPath();
        } else if (referrerSource instanceof MergedSource ms) {
            files = ms.files();
            jsonPath = ms.jsonPath();
        } else if (referrerSource instanceof ResolvedSource rs) {
            files = rs.files();
            jsonPath = rs.jsonPath();
        } else if (referrerSource instanceof DatabaseSource ds) {
            files = List.of();
            jsonPath = ds.jsonPath();
        } else {
            // CodeSource or null
            files = List.of();
            jsonPath = null;
        }
        return new ResolvedSource(files, jsonPath, referrer, target);
    }

    @Override
    public String format() {
        return "resolved";
    }
}

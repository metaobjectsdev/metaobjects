/*
 * Copyright 2003 Doug Mealing LLC dba Meta Objects. All Rights Reserved.
 *
 * This software is the proprietary information of Doug Mealing LLC dba Meta Objects.
 * Use is subject to license terms.
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

    @Override
    public String format() {
        return "resolved";
    }
}

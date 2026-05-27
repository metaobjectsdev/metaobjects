/*
 * Copyright 2003 Doug Mealing LLC dba Meta Objects. All Rights Reserved.
 *
 * This software is the proprietary information of Doug Mealing LLC dba Meta Objects.
 * Use is subject to license terms.
 */
package com.metaobjects.source;

import java.util.List;

/**
 * Authoring-time provenance: a single JSON file (FR5a).
 *
 * <p>Mirrors {@code JsonSource} in {@code server/csharp/MetaObjects/Source/ErrorSource.cs}.
 * FR5a invariant: <strong>exactly one file path</strong> — multi-file provenance
 * lives on {@link MergedSource} (FR5c). The invariant is enforced at construction
 * so the type can be trusted by cross-port comparison.</p>
 *
 * @param files length-1 file list; project-root-relative path with forward slashes
 * @param jsonPath canonical JSONPath string for the node within {@code files[0]}
 */
public record JsonSource(List<String> files, String jsonPath) implements ErrorSource {

    /**
     * Canonical constructor: validates the FR5a length-1 invariant and returns
     * an immutable copy of the input list.
     *
     * @throws IllegalArgumentException if {@code files} does not contain exactly one entry
     * @throws NullPointerException if {@code files} or {@code jsonPath} is {@code null}
     */
    public JsonSource {
        if (files == null) {
            throw new NullPointerException("JsonSource files must not be null");
        }
        if (jsonPath == null) {
            throw new NullPointerException("JsonSource jsonPath must not be null");
        }
        if (files.size() != 1) {
            throw new IllegalArgumentException(
                "JsonSource requires exactly one file path; got " + files.size()
                    + ". Use MergedSource for multi-file provenance.");
        }
        // Defensive copy to enforce immutability of the record component.
        files = List.copyOf(files);
    }

    @Override
    public String format() {
        return "json";
    }
}

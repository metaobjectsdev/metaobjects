/*
 * Copyright 2003 Doug Mealing LLC dba Meta Objects. All Rights Reserved.
 *
 * This software is the proprietary information of Doug Mealing LLC dba Meta Objects.
 * Use is subject to license terms.
 */
package com.metaobjects.source;

import java.util.List;

/**
 * Authoring-time provenance: a single YAML file with optional source-map
 * positions (FR5b — reserved slot; FR5a does not populate this variant).
 *
 * <p>Mirrors {@code YamlSource} in {@code server/csharp/MetaObjects/Source/ErrorSource.cs}.</p>
 *
 * @param files length-1 file list; project-root-relative path with forward slashes
 * @param jsonPath canonical JSONPath string for the node within {@code files[0]}
 * @param yamlPosition optional YAML line/col position; may be {@code null}
 */
public record YamlSource(List<String> files, String jsonPath, YamlPosition yamlPosition)
    implements ErrorSource {

    /**
     * Canonical constructor: defensive-copies the file list to enforce
     * immutability.
     *
     * @throws NullPointerException if {@code files} or {@code jsonPath} is {@code null}
     */
    public YamlSource {
        if (files == null) {
            throw new NullPointerException("YamlSource files must not be null");
        }
        if (jsonPath == null) {
            throw new NullPointerException("YamlSource jsonPath must not be null");
        }
        files = List.copyOf(files);
    }

    /** Convenience constructor: no YAML position. */
    public YamlSource(List<String> files, String jsonPath) {
        this(files, jsonPath, null);
    }

    @Override
    public String format() {
        return "yaml";
    }
}

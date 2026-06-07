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

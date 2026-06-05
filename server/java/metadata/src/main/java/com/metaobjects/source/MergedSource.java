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
 * Post-load provenance: an overlay-merge that produced a semantic change
 * (FR5c — reserved slot; FR5a does not populate this variant).
 *
 * <p>Mirrors {@code MergedSource} in
 * {@code server/csharp/MetaObjects/Source/ErrorSource.cs}.</p>
 *
 * @param files all contributing file paths (project-root-relative, forward slashes)
 * @param jsonPath canonical JSONPath string for the merged node
 * @param contributors per-file contributor records with role tags
 */
public record MergedSource(List<String> files, String jsonPath, List<Contributor> contributors)
    implements ErrorSource {

    /**
     * Canonical constructor: defensive-copies both list components.
     *
     * @throws NullPointerException if any argument is {@code null}
     */
    public MergedSource {
        if (files == null) {
            throw new NullPointerException("MergedSource files must not be null");
        }
        if (jsonPath == null) {
            throw new NullPointerException("MergedSource jsonPath must not be null");
        }
        if (contributors == null) {
            throw new NullPointerException("MergedSource contributors must not be null");
        }
        files = List.copyOf(files);
        contributors = List.copyOf(contributors);
    }

    @Override
    public String format() {
        return "merged";
    }
}

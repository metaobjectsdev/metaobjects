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
 * Authoring-time provenance: a single JSON file (FR5a).
 *
 * <p>Mirrors {@code JsonSource} in {@code server/csharp/MetaObjects/Source/ErrorSource.cs}.
 * FR5a invariant: <strong>exactly one file path</strong> — multi-file provenance
 * lives on {@link MergedSource} (FR5c). The invariant is enforced at construction
 * so the type can be trusted by cross-port comparison.</p>
 *
 * <p>FR5b (2026-05-27 — Java port): {@link #yamlPosition} is an OPTIONAL field on this
 * {@code format: "json"} variant so that errors emitted from a YAML input (lowered
 * through the desugar to canonical JSON, then through the same buildTree pipeline as
 * JSON) can still carry the source position without re-flagging the format
 * discriminator. The C# and Python ports adopted the same compromise: until ALL four
 * ports ship FR5b — at which point buildTree-emitted errors from YAML inputs flip to
 * {@link YamlSource} and the cross-port yaml-conformance fixtures are mass-updated —
 * keeping the discriminator at {@code "json"} preserves cross-port fixture parity
 * (the yaml-conformance fixtures whose buildTree-side errors are format-keyed
 * {@code "json"} would otherwise diverge until all ports catch up).</p>
 *
 * @param files length-1 file list; project-root-relative path with forward slashes
 * @param jsonPath canonical JSONPath string for the node within {@code files[0]}
 * @param yamlPosition FR5b — optional YAML line/col position; {@code null} for JSON inputs
 *                     and for YAML inputs where no position was tracked for the node
 */
public record JsonSource(List<String> files, String jsonPath, YamlPosition yamlPosition)
    implements ErrorSource {

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
        // yamlPosition is intentionally nullable.
    }

    /**
     * Convenience constructor: no YAML position. Matches the FR5a-only callers
     * unchanged, so all existing call-sites continue to compile without diff.
     */
    public JsonSource(List<String> files, String jsonPath) {
        this(files, jsonPath, null);
    }

    @Override
    public String format() {
        return "json";
    }
}

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

/**
 * Provenance envelope for a metadata node or loader error (FR5a / ADR-0009).
 *
 * <p>Discriminated union over the provenance variants a metadata node or error
 * can carry. Cross-port-aligned: every metaobjects port emits the same envelope
 * shape so a tool consuming errors from multiple language ports can compare
 * them byte-identically.</p>
 *
 * <p>This Java realization uses a {@code sealed interface} with {@code record}
 * permits, mirroring the C# {@code abstract record} hierarchy
 * ({@code server/csharp/MetaObjects/Source/ErrorSource.cs}). Pattern-match on
 * the concrete subtype (e.g. {@code switch (src) { case JsonSource js -> ...; }})
 * to access variant-specific fields.</p>
 *
 * <p>The {@link #format()} method returns the discriminant tag (one of
 * {@code "json"}, {@code "yaml"}, {@code "merged"}, {@code "resolved"},
 * {@code "database"}, {@code "code"}).</p>
 *
 * @see JsonSource for FR5a authoring-time single-file JSON provenance
 * @see CodeSource for the programmatic / test-construction default
 */
public sealed interface ErrorSource
    permits JsonSource, YamlSource, MergedSource, ResolvedSource, DatabaseSource, CodeSource {

    /**
     * The discriminant tag — one of {@code "json"} / {@code "yaml"} /
     * {@code "merged"} / {@code "resolved"} / {@code "database"} / {@code "code"}.
     *
     * @return the canonical format tag for this provenance variant
     */
    String format();
}

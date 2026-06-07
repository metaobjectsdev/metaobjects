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

import com.metaobjects.ErrorCode;

import java.util.List;

/**
 * Envelope shape every loader error conforms to (ADR-0009 §Decision).
 *
 * <p>{@link #code()}, {@link #message()} and {@link #source()} are REQUIRED
 * (conformance-enforced). The remaining fields are RECOMMENDED; FR5a does not
 * populate them, FR5b–FR5e may.</p>
 *
 * <p>Mirrors {@code LoaderError} in
 * {@code server/csharp/MetaObjects/Source/ErrorSource.cs}.</p>
 *
 * @param code structured error code (e.g. {@link ErrorCode#ERR_UNKNOWN_TYPE})
 * @param message human-readable message
 * @param source provenance envelope; never {@code null}
 * @param suggestions optional did-you-mean candidates; may be {@code null}
 * @param fixture optional canonical fixture name; may be {@code null}
 * @param node optional structural context; may be {@code null}
 */
public record LoaderError(
    ErrorCode code,
    String message,
    ErrorSource source,
    List<String> suggestions,
    String fixture,
    NodeContext node) {

    /**
     * Canonical constructor: defensive-copies {@code suggestions}; enforces
     * non-null {@code code}, {@code message}, and {@code source}.
     */
    public LoaderError {
        if (code == null) {
            throw new NullPointerException("LoaderError code must not be null");
        }
        if (message == null) {
            throw new NullPointerException("LoaderError message must not be null");
        }
        if (source == null) {
            throw new NullPointerException("LoaderError source must not be null");
        }
        if (suggestions != null) {
            suggestions = List.copyOf(suggestions);
        }
    }

    /** Convenience constructor: required fields only, T2 slots {@code null}. */
    public LoaderError(ErrorCode code, String message, ErrorSource source) {
        this(code, message, source, null, null, null);
    }
}

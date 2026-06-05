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
 * Warning envelope — same shape as {@link LoaderError} but with a
 * {@code WARN_*} code (today stored as a string until the cross-port
 * {@code WARN_*} taxonomy lands; initial code per ADR-0009:
 * {@code WARN_DUPLICATE_DECLARATION}).
 *
 * <p>Mirrors {@code LoaderWarning} in
 * {@code server/csharp/MetaObjects/Source/ErrorSource.cs}.</p>
 *
 * @param code WARN_* code string
 * @param message human-readable message
 * @param source provenance envelope; never {@code null}
 * @param suggestions optional did-you-mean candidates; may be {@code null}
 * @param fixture optional canonical fixture name; may be {@code null}
 * @param node optional structural context; may be {@code null}
 */
public record LoaderWarning(
    String code,
    String message,
    ErrorSource source,
    List<String> suggestions,
    String fixture,
    NodeContext node) {

    /** Canonical constructor: defensive-copies {@code suggestions}; enforces required fields. */
    public LoaderWarning {
        if (code == null) {
            throw new NullPointerException("LoaderWarning code must not be null");
        }
        if (message == null) {
            throw new NullPointerException("LoaderWarning message must not be null");
        }
        if (source == null) {
            throw new NullPointerException("LoaderWarning source must not be null");
        }
        if (suggestions != null) {
            suggestions = List.copyOf(suggestions);
        }
    }

    /** Convenience constructor: required fields only, T2 slots {@code null}. */
    public LoaderWarning(String code, String message, ErrorSource source) {
        this(code, message, source, null, null, null);
    }
}

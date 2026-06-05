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
 * Future provenance: database-sourced metadata (FR5e — reserved slot, gated on
 * FR-003; FR5a does not populate this variant).
 *
 * <p>Mirrors {@code DatabaseSource} in
 * {@code server/csharp/MetaObjects/Source/ErrorSource.cs}.</p>
 *
 * @param dbLocation database table + id of the originating row
 * @param jsonPath optional canonical JSONPath within the row's payload; may be {@code null}
 */
public record DatabaseSource(DbLocation dbLocation, String jsonPath) implements ErrorSource {

    /**
     * Canonical constructor: rejects a null {@code dbLocation}.
     *
     * @throws NullPointerException if {@code dbLocation} is {@code null}
     */
    public DatabaseSource {
        if (dbLocation == null) {
            throw new NullPointerException("DatabaseSource dbLocation must not be null");
        }
    }

    /** Convenience constructor: no JSONPath. */
    public DatabaseSource(DbLocation dbLocation) {
        this(dbLocation, null);
    }

    @Override
    public String format() {
        return "database";
    }
}

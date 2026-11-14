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
package com.metaobjects.config;

import com.metaobjects.MetaData;
import com.metaobjects.MetaRoot;

/**
 * The project's {@code api} block in {@code .metaobjects/config.json}: how a generated REST
 * surface treats list paging and undeclared body keys.
 *
 * <p>{@code api.pagination} is {@code {"defaultLimit": n, "maxLimit": m}} (both positive
 * integers, {@code defaultLimit <= maxLimit}); a list route with no {@code limit} returns
 * {@code defaultLimit} rows and a {@code limit} above {@code maxLimit} is answered with
 * {@code 400 {"error": "limit_too_large", "maxLimit": m}}. Absent, the routes page as they
 * always have ({@link #hasPagination()} is false, {@link #pagination()} is {@code null}).</p>
 *
 * <p>{@code api.unknownFields} is {@code "reject"} (the default) or {@code "drop"}: what a
 * generated create, PUT or PATCH does with a body key the entity does not declare.</p>
 *
 * <p>Read a tree's setting with {@link #of(MetaData)}; the same value is on
 * {@code MetaRoot#getApiSettings()}.</p>
 */
public record ApiSettings(Pagination pagination, UnknownFields unknownFields) {

    /** The page size of a generated list route. */
    public record Pagination(long defaultLimit, long maxLimit) {}

    /** What a body key the entity does not declare does. */
    public enum UnknownFields {
        /** Refuse with {@code 400 {"error": "unknown_fields", "fields": [...]}}. The default. */
        REJECT("reject"),
        /** Ignore the key silently. */
        DROP("drop");

        private final String wireName;

        UnknownFields(String wireName) { this.wireName = wireName; }

        /** The value as spelled in {@code .metaobjects/config.json}. */
        public String wireName() { return wireName; }
    }

    /** No pagination, {@code reject}: what a tree loaded with no project carries. */
    public static final ApiSettings DEFAULT = new ApiSettings(null, UnknownFields.REJECT);

    public ApiSettings {
        if (unknownFields == null) unknownFields = UnknownFields.REJECT;
    }

    /** True when the project set {@code api.pagination}. */
    public boolean hasPagination() {
        return pagination != null;
    }

    /** True when an undeclared body key is refused (the default). */
    public boolean rejectsUnknownFields() {
        return unknownFields == UnknownFields.REJECT;
    }

    /** The {@code unknownFields} value spelled {@code raw}, or {@code null} when it names none. */
    public static UnknownFields unknownFieldsOf(String raw) {
        for (UnknownFields u : UnknownFields.values()) if (u.wireName.equals(raw)) return u;
        return null;
    }

    /** The setting the tree {@code node} belongs to: what its root carries, else {@link #DEFAULT}. */
    public static ApiSettings of(MetaData node) {
        for (MetaData n = node; n != null; n = n.getParent()) {
            if (n instanceof MetaRoot root) return root.getApiSettings();
        }
        return DEFAULT;
    }
}

/*
 * Copyright 2026 Doug Mealing LLC dba Meta Objects
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
package com.metaobjects.reporting;

import com.metaobjects.MetaData;

import java.util.Map;

/**
 * Base node class for {@code type = "segment"} (FR-044): a named, reusable row filter on
 * the declaring entity. The concrete subtype is {@link FilterSegment}
 * ({@code segment.filter}). Accessors are RESOLVING (ADR-0039).
 */
@SuppressWarnings("serial")
public abstract class MetaSegment extends MetaData {

    protected MetaSegment(String subType, String name) {
        super(ReportingConstants.TYPE_SEGMENT, subType, name);
    }

    /** The named row scope: a canonical attr.filter over the declaring entity's fields. */
    public Map<String, Object> getFilter() {
        return ReportingAttrs.filterMap(this, ReportingConstants.ATTR_FILTER);
    }
}

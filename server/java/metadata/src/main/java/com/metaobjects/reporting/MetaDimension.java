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

import java.util.ArrayList;
import java.util.List;

/**
 * Base node class for {@code type = "dimension"} (FR-044): a named group-by of the entity
 * that declares it. Concrete subtypes are {@link AttributeDimension}
 * ({@code dimension.attribute}) and {@link TimeDimension} ({@code dimension.time}).
 *
 * <p>Accessors are RESOLVING (ADR-0039): a dimension declared on an abstract base entity
 * is read through the same accessors as one declared on the concrete entity.</p>
 */
@SuppressWarnings("serial")
public abstract class MetaDimension extends MetaData {

    protected MetaDimension(String subType, String name) {
        super(ReportingConstants.TYPE_DIMENSION, subType, name);
    }

    /** True for {@code dimension.time} (grain truncation); false for {@code dimension.attribute}. */
    public boolean isTime() {
        return ReportingConstants.DIMENSION_SUBTYPE_TIME.equals(getSubType());
    }

    /** Dotted {@code Entity.field} reference naming the grouped column, or {@code null}. */
    public String getOf() {
        return ReportingAttrs.optionalString(this, ReportingConstants.ATTR_OF);
    }

    /** Optional dotted to-one relationship path from the owning entity to the {@code @of} entity. */
    public String getVia() {
        return ReportingAttrs.optionalString(this, ReportingConstants.ATTR_VIA);
    }

    /** The grains a {@code dimension.time} supports (empty for {@code dimension.attribute}),
     *  keeping only members of the closed grain set. */
    public List<String> getGrains() {
        List<String> out = new ArrayList<>();
        for (String g : ReportingAttrs.stringList(this, ReportingConstants.ATTR_GRAINS)) {
            if (ReportingConstants.TIME_GRAINS.contains(g)) out.add(g);
        }
        return out;
    }
}

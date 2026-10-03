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
import com.metaobjects.attr.StringAttribute;
import com.metaobjects.registry.MetaDataRegistry;

/**
 * {@code dimension.attribute} (FR-044): groups report rows by a column value as-is.
 * {@code @of} names {@code Entity.field} on the owning entity, or the {@code @via} terminal.
 */
@SuppressWarnings("serial")
public class AttributeDimension extends MetaDimension {

    public AttributeDimension(String name) {
        super(ReportingConstants.DIMENSION_SUBTYPE_ATTRIBUTE, name);
    }

    /**
     * Register {@code dimension.attribute}. Descriptions come from the shared
     * {@code spec/metamodel/reporting.json} (FR-033), never hand-copied.
     */
    public static void registerTypes(MetaDataRegistry registry) {
        registry.registerType(AttributeDimension.class, def -> {
            def.type(ReportingConstants.TYPE_DIMENSION).subType(ReportingConstants.DIMENSION_SUBTYPE_ATTRIBUTE)
               .description("A named group-by attribute of the entity that declares it.")
               .inheritsFrom(MetaData.TYPE_METADATA, MetaData.SUBTYPE_BASE);
            def.requiredAttributeWithConstraints(ReportingConstants.ATTR_OF)
               .ofType(StringAttribute.SUBTYPE_STRING).asSingle();
            def.optionalAttributeWithConstraints(ReportingConstants.ATTR_VIA)
               .ofType(StringAttribute.SUBTYPE_STRING).asSingle();
        });
    }
}

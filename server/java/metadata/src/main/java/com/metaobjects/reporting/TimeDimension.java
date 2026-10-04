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
 * {@code dimension.time} (FR-044): groups report rows by a date or timestamp column
 * truncated to a grain. Weeks start on Monday (ISO-8601). A report names it as
 * {@code dimension:grain} and the derived report field is {@code <dimension><Grain>}.
 */
@SuppressWarnings("serial")
public class TimeDimension extends MetaDimension {

    public TimeDimension(String name) {
        super(ReportingConstants.DIMENSION_SUBTYPE_TIME, name);
    }

    /**
     * Register {@code dimension.time}. Descriptions and the {@code @grains}
     * {@code allowedValues} come from {@code spec/metamodel/reporting.json} (FR-033);
     * {@code .withEnum} is decorative on attr children in this port, so the closed set is
     * enforced post-load by the reporting validation pass.
     */
    public static void registerTypes(MetaDataRegistry registry) {
        registry.registerType(TimeDimension.class, def -> {
            def.type(ReportingConstants.TYPE_DIMENSION).subType(ReportingConstants.DIMENSION_SUBTYPE_TIME)
               .description("A named time dimension.")
               .inheritsFrom(MetaData.TYPE_METADATA, MetaData.SUBTYPE_BASE);
            def.requiredAttributeWithConstraints(ReportingConstants.ATTR_OF)
               .ofType(StringAttribute.SUBTYPE_STRING).asSingle();
            def.optionalAttributeWithConstraints(ReportingConstants.ATTR_VIA)
               .ofType(StringAttribute.SUBTYPE_STRING).asSingle();
            def.requiredAttributeWithConstraints(ReportingConstants.ATTR_GRAINS)
               .ofType(StringAttribute.SUBTYPE_STRING).asArray();
        });
    }
}

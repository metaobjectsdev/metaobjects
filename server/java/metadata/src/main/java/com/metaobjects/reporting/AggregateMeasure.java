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
import com.metaobjects.attr.BooleanAttribute;
import com.metaobjects.attr.FilterAttribute;
import com.metaobjects.attr.IntAttribute;
import com.metaobjects.attr.StringAttribute;
import com.metaobjects.registry.MetaDataRegistry;

/**
 * {@code measure.aggregate} (FR-044): one aggregate over the declaring entity's own rows.
 * Unlike {@code origin.aggregate}, {@code count} is NOT distinct by default.
 */
@SuppressWarnings("serial")
public class AggregateMeasure extends MetaMeasure {

    public AggregateMeasure(String name) {
        super(ReportingConstants.MEASURE_SUBTYPE_AGGREGATE, name);
    }

    /**
     * Register {@code measure.aggregate}. Descriptions and the {@code @agg}
     * {@code allowedValues} come from {@code spec/metamodel/reporting.json} (FR-033); the
     * closed set is enforced post-load by the reporting validation pass.
     */
    public static void registerTypes(MetaDataRegistry registry) {
        registry.registerType(AggregateMeasure.class, def -> {
            def.type(ReportingConstants.TYPE_MEASURE).subType(ReportingConstants.MEASURE_SUBTYPE_AGGREGATE)
               .description("A named aggregate over the declaring entity's own rows.")
               .inheritsFrom(MetaData.TYPE_METADATA, MetaData.SUBTYPE_BASE);
            def.requiredAttributeWithConstraints(ReportingConstants.ATTR_AGG)
               .ofType(StringAttribute.SUBTYPE_STRING).asSingle();
            def.requiredAttributeWithConstraints(ReportingConstants.ATTR_OF)
               .ofType(StringAttribute.SUBTYPE_STRING).asArray();
            def.optionalAttributeWithConstraints(ReportingConstants.ATTR_DISTINCT)
               .ofType(BooleanAttribute.SUBTYPE_BOOLEAN).asSingle();
            def.optionalAttributeWithConstraints(ReportingConstants.ATTR_FILTER)
               .ofType(FilterAttribute.SUBTYPE_FILTER).asSingle();
            def.optionalAttributeWithConstraints(ReportingConstants.ATTR_SEGMENT)
               .ofType(StringAttribute.SUBTYPE_STRING).asSingle();
            def.optionalAttributeWithConstraints(ReportingConstants.ATTR_DEFAULT)
               .ofType(IntAttribute.SUBTYPE_INT).asSingle();
        });
    }
}

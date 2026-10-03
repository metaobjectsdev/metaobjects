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
 * {@code measure.ratio} (FR-044): a quotient of two {@code measure.aggregate} siblings,
 * lowered as {@code numerator / NULLIF(denominator, 0)}.
 */
@SuppressWarnings("serial")
public class RatioMeasure extends MetaMeasure {

    public RatioMeasure(String name) {
        super(ReportingConstants.MEASURE_SUBTYPE_RATIO, name);
    }

    /** Register {@code measure.ratio}; descriptions come from {@code spec/metamodel/reporting.json}. */
    public static void registerTypes(MetaDataRegistry registry) {
        registry.registerType(RatioMeasure.class, def -> {
            def.type(ReportingConstants.TYPE_MEASURE).subType(ReportingConstants.MEASURE_SUBTYPE_RATIO)
               .description("A named quotient of two measure.aggregate siblings.")
               .inheritsFrom(MetaData.TYPE_METADATA, MetaData.SUBTYPE_BASE);
            def.requiredAttributeWithConstraints(ReportingConstants.ATTR_NUMERATOR)
               .ofType(StringAttribute.SUBTYPE_STRING).asSingle();
            def.requiredAttributeWithConstraints(ReportingConstants.ATTR_DENOMINATOR)
               .ofType(StringAttribute.SUBTYPE_STRING).asSingle();
        });
    }
}

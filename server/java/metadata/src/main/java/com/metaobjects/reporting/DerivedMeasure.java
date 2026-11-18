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
import com.metaobjects.attr.ExpressionAttribute;
import com.metaobjects.registry.MetaDataRegistry;

/**
 * {@code measure.derived} (FR-044 R13): arithmetic ({@code @expr}) over the entity's measures
 * and its numeric attribute dimensions — FR-037 R5's first arithmetic wave. It takes no
 * {@code @default}.
 */
@SuppressWarnings("serial")
public class DerivedMeasure extends MetaMeasure {

    public DerivedMeasure(String name) {
        super(ReportingConstants.MEASURE_SUBTYPE_DERIVED, name);
    }

    /** Register {@code measure.derived}; descriptions come from {@code spec/metamodel/reporting.json}. */
    public static void registerTypes(MetaDataRegistry registry) {
        registry.registerType(DerivedMeasure.class, def -> {
            def.type(ReportingConstants.TYPE_MEASURE).subType(ReportingConstants.MEASURE_SUBTYPE_DERIVED)
               .description("A named arithmetic expression over measures and grouped dimensions.")
               .inheritsFrom(MetaData.TYPE_METADATA, MetaData.SUBTYPE_BASE);
            def.requiredAttributeWithConstraints(ReportingConstants.ATTR_EXPR)
               .ofType(ExpressionAttribute.SUBTYPE_EXPRESSION).asSingle();
        });
    }
}

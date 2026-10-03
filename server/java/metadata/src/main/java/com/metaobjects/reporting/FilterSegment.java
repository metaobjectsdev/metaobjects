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
import com.metaobjects.attr.FilterAttribute;
import com.metaobjects.registry.MetaDataRegistry;

/** {@code segment.filter} (FR-044): a named, reusable row filter on the declaring entity. */
@SuppressWarnings("serial")
public class FilterSegment extends MetaSegment {

    public FilterSegment(String name) {
        super(ReportingConstants.SEGMENT_SUBTYPE_FILTER, name);
    }

    /** Register {@code segment.filter}; descriptions come from {@code spec/metamodel/reporting.json}. */
    public static void registerTypes(MetaDataRegistry registry) {
        registry.registerType(FilterSegment.class, def -> {
            def.type(ReportingConstants.TYPE_SEGMENT).subType(ReportingConstants.SEGMENT_SUBTYPE_FILTER)
               .description("A named, reusable row filter on the declaring entity.")
               .inheritsFrom(MetaData.TYPE_METADATA, MetaData.SUBTYPE_BASE);
            def.requiredAttributeWithConstraints(ReportingConstants.ATTR_FILTER)
               .ofType(FilterAttribute.SUBTYPE_FILTER).asSingle();
        });
    }
}

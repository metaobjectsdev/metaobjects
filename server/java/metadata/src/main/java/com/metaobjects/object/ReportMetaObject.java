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
package com.metaobjects.object;

import com.metaobjects.attr.FilterAttribute;
import com.metaobjects.attr.StringAttribute;
import com.metaobjects.object.value.ValueObject;
import com.metaobjects.registry.MetaDataRegistry;

/**
 * object.report — a declared report (FR-044): a fixed combination of the dimensions and
 * measures of ONE entity ({@code @from}), compiled to a read-only view. Its fields are
 * derived from {@code @dimensions} and {@code @measures}, never declared; its rules
 * (R1-R7) are enforced by the loader's reporting validation pass.
 *
 * <p>The declared node carries no field children. Its read shape is derived by
 * {@link com.metaobjects.reporting.ReportShape} (contract Table B), and a runtime reads it
 * through {@link com.metaobjects.reporting.ReportReadModel}. The view itself is lowered by
 * the TypeScript toolchain only (ADR-0015); the Java generators emit nothing for a report.</p>
 */
@SuppressWarnings("serial")
public class ReportMetaObject extends AbstractObjectRepresentation {
    public ReportMetaObject(String name) { super(MetaObject.SUBTYPE_REPORT, name); }
    protected ReportMetaObject(String subType, String name) { super(subType, name); }

    /**
     * Register {@code object.report} (FR-044). Called by the reporting pack's provider, not by
     * core: it inherits {@code object.base} from the object-types provider (the cross-definition
     * {@code extendsBase}), so the inherited attrs are not a new claim by the reporting pack. Its
     * structural children come from spec/metamodel/reporting.json (extendsBase), like
     * object.projection.
     */
    public static void registerTypes(MetaDataRegistry registry) {
        registry.registerType(ReportMetaObject.class, def -> {
            def.type(MetaObject.TYPE_OBJECT).subType(MetaObject.SUBTYPE_REPORT)
               .description("Report object (derived, read-only) — a declared aggregation of one entity")
               .inheritsFrom(MetaObject.TYPE_OBJECT, MetaObject.SUBTYPE_BASE);
            def.requiredAttributeWithConstraints(MetaObject.ATTR_REPORT_FROM)
               .ofType(StringAttribute.SUBTYPE_STRING).asSingle();
            def.optionalAttributeWithConstraints(MetaObject.ATTR_REPORT_DIMENSIONS)
               .ofType(StringAttribute.SUBTYPE_STRING).asArray();
            def.requiredAttributeWithConstraints(MetaObject.ATTR_REPORT_MEASURES)
               .ofType(StringAttribute.SUBTYPE_STRING).asArray();
            def.optionalAttributeWithConstraints(MetaObject.ATTR_REPORT_SEGMENT)
               .ofType(StringAttribute.SUBTYPE_STRING).asSingle();
            def.optionalAttributeWithConstraints(MetaObject.ATTR_FILTER)
               .ofType(FilterAttribute.SUBTYPE_FILTER).asSingle();
            def.optionalAttributeWithConstraints(MetaObject.ATTR_REPORT_SPINE)
               .ofType(StringAttribute.SUBTYPE_STRING).asSingle();
        });
    }
    @Override protected Class<?> getDefaultObjectClass() { return ValueObject.class; }
}

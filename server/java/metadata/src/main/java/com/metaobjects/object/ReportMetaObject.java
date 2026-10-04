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

import com.metaobjects.object.value.ValueObject;

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
    @Override protected Class<?> getDefaultObjectClass() { return ValueObject.class; }
}

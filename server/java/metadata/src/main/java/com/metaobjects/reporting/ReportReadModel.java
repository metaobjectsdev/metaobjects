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
import com.metaobjects.MetaDataException;
import com.metaobjects.MetaRoot;
import com.metaobjects.attr.BooleanAttribute;
import com.metaobjects.attr.MetaAttribute;
import com.metaobjects.attr.StringAttribute;
import com.metaobjects.database.CoreDBMetaDataProvider;
import com.metaobjects.field.CurrencyField;
import com.metaobjects.field.DateField;
import com.metaobjects.field.DecimalField;
import com.metaobjects.field.DoubleField;
import com.metaobjects.field.EnumField;
import com.metaobjects.field.LongField;
import com.metaobjects.field.MetaField;
import com.metaobjects.object.MetaObject;
import com.metaobjects.object.ReportMetaObject;
import com.metaobjects.source.MetaSource;

import java.util.List;

/**
 * A report's READ MODEL (FR-044): a detached {@code object.report} node carrying one real
 * {@code field.*} child per derived field ({@link ReportShape}, contract Table B) and a
 * copy of the source the report is read from.
 *
 * <h2>Why it exists</h2>
 * An {@code object.report} declares no fields: its read shape is derived from its
 * dimensions and measures. A metadata-driven runtime walks an object's field children
 * everywhere (column mapping, filter and sort resolution, instance construction, every
 * read codec). Rather than teach each of those what a report is, a runtime reads a report
 * through this model and sees ordinary fields.
 *
 * <h2>Why it is detached</h2>
 * The model is never added to the root: it has no parent, the loader does not list it,
 * and the canonical serializer, {@code fmt}, codegen and every other tree walker never see
 * it. Nothing in the loaded tree is mutated to build it — the type-shaping attrs and the
 * source are COPIED (attrs only), never re-parented ({@code addChild} rewrites a child's
 * parent). Nodes are constructed directly, not through the loader, and no vocabulary is
 * added: every node is an already-registered {@code type.subType}.
 *
 * <p>It keeps the report's name, package and {@code object.report} subtype, so a consumer
 * holding it can still tell it is a report (no identity, read-only). It is its own class so
 * it can be told apart from the declared node, which has the same name and subtype.</p>
 *
 * <p>Mirrors the TypeScript {@code report-read-model.ts}.</p>
 */
@SuppressWarnings("serial")
public final class ReportReadModel extends ReportMetaObject {

    private static final String CACHE_KEY = "ReportReadModel.of()";

    /**
     * Table B: the type-shaping attrs a derived field carries from its type source, read
     * with the RESOLVING accessor (ADR-0039) so a value the {@code @of} field inherits
     * through {@code extends} is carried too. {@code @dbColumnType} and array-ness are
     * handled separately. Nothing else is carried: no {@code @column}, {@code @required},
     * {@code @default}, validators or views.
     */
    private static final List<String> CARRIED_ATTRS = List.of(
            CurrencyField.ATTR_CURRENCY,
            EnumField.ATTR_VALUES,
            EnumField.ATTR_INT_VALUE_MAP,
            MetaField.ATTR_MAX_LENGTH,
            MetaField.ATTR_PRECISION,
            MetaField.ATTR_SCALE,
            CoreDBMetaDataProvider.LOCAL_TIME,
            MetaField.ATTR_OBJECT_REF,
            MetaField.ATTR_STORAGE);

    /** The declared report this model was built from; {@code null} only on a bare instance. */
    private transient MetaObject report;

    /**
     * Constructs an EMPTY model node. Public only because the node contract requires a
     * {@code (String name)} constructor ({@link MetaData#clone()}); obtain a model with
     * {@link #of(MetaObject)}.
     */
    public ReportReadModel(String name) {
        super(name);
    }

    /** True for an {@code object.report}: the declared node or its read model. */
    public static boolean isReport(MetaObject object) {
        return object != null && MetaObject.SUBTYPE_REPORT.equals(object.getSubType());
    }

    /**
     * The read model of a report attached to a loaded model; the root is found from the
     * report. Passing a read model returns it unchanged.
     *
     * @throws MetaDataException what {@link ReportShape#of(MetaObject)} throws
     */
    public static ReportReadModel of(MetaObject report) {
        if (report instanceof ReportReadModel) return (ReportReadModel) report;
        return report.useFrozenCache(CACHE_KEY, () -> build(ReportShape.of(report)));
    }

    /**
     * The read model of an {@code object.report}: one field per Table B row, in Table B
     * order, plus a copy of the source the report is read from
     * ({@link ReportShape#readSource(MetaObject)}) when it declares one. A sourceless report
     * yields a model with no source: it has a shape and no view, and the caller decides
     * what that means ({@link #isServed()}).
     *
     * <p>Cached on the report node once the loaded tree is frozen (the loader freezes it
     * when the load completes), so a report has one model for its lifetime; before that
     * each call builds a fresh, equal model, so nothing derived from a still-mutable tree is
     * served stale.</p>
     *
     * @throws MetaDataException what {@link ReportShape#of(MetaObject, MetaRoot)} throws
     */
    public static ReportReadModel of(MetaObject report, MetaRoot root) {
        if (report instanceof ReportReadModel) return (ReportReadModel) report;
        return report.useFrozenCache(CACHE_KEY, () -> build(ReportShape.of(report, root)));
    }

    /** The declared {@code object.report} node this model reads. */
    public MetaObject report() {
        return report;
    }

    /** True when the report has a view to read (Table A); a sourceless report is not served. */
    public boolean isServed() {
        return findPrimaryReadOnlySource().isPresent();
    }

    /**
     * The physical name of the view the model is read from, or {@code null} when the
     * report is not served. Resolved through the source's kind-matching alias
     * ({@code @view} for a view), so a report is read under the name the lowering created.
     */
    public String viewName() {
        return findPrimaryReadOnlySource().map(MetaSource::getPhysicalName).orElse(null);
    }

    private static ReportReadModel build(ReportShape shape) {
        MetaObject report = shape.report();
        // The resolution key carries the package, so the model resolves as the report does.
        ReportReadModel model = new ReportReadModel(report.getName());
        model.report = report;
        for (ReportShape.Field f : shape.fields()) model.addChild(derivedField(f));

        MetaSource source = ReportShape.readSource(report);
        if (source != null) model.addChild(copySource(source));

        model.freeze();
        return model;
    }

    private static MetaField<?> derivedField(ReportShape.Field f) {
        MetaField<?> field = newField(f);
        // From the derived shape, never from the type source: a `min` of a required column
        // is still nullable, and a dimension reached by @via is nullable.
        field.addMetaAttr(BooleanAttribute.create(MetaField.ATTR_REQUIRED, f.required()));
        MetaField<?> src = f.typeSource();
        if (src == null) return field;

        for (String name : CARRIED_ATTRS) {
            if (src.hasMetaAttr(name)) field.addMetaAttr(copyAttr(src.getMetaAttr(name)));
        }
        // ADR-0039: own — @dbColumnType is the one deliberately own-only attr (a physical
        // column-type override is never inherited). So it is read own from the type source:
        // the derived field carries exactly what the @of field itself declares, and nothing
        // its supers declare.
        if (src.hasMetaAttr(CoreDBMetaDataProvider.DB_COLUMN_TYPE, false)) {
            field.addMetaAttr(copyAttr(src.getMetaAttr(CoreDBMetaDataProvider.DB_COLUMN_TYPE, false)));
        }
        // Array-ness is a native flag, not an attr; isArrayType() is its resolving read.
        if (src.isArrayType()) field.setArray(true);
        return field;
    }

    /**
     * A new, parentless field node of the derived subtype. A derived field that has a type
     * source always has that source's subtype (Table B), so it is built as the same node
     * class; the rows with no type source produce one of four fixed subtypes.
     */
    @SuppressWarnings({"unchecked", "rawtypes"})
    private static MetaField<?> newField(ReportShape.Field f) {
        MetaField<?> src = f.typeSource();
        if (src != null && f.subType().equals(src.getSubType())) {
            return (MetaField<?>) src.newInstanceFromClass((Class) src.getClass(), MetaField.TYPE_FIELD, f.subType(), f.name());
        }
        switch (f.subType()) {
            case LongField.SUBTYPE_LONG: return new LongField(f.name());
            case DecimalField.SUBTYPE_DECIMAL: return new DecimalField(f.name());
            case DoubleField.SUBTYPE_DOUBLE: return new DoubleField(f.name());
            case DateField.SUBTYPE_DATE: return new DateField(f.name());
            default:
                throw new MetaDataException("report read model: derived field '" + f.name()
                        + "' has subtype field." + f.subType() + ", which Table B does not derive without a type source.");
        }
    }

    /**
     * A detached copy of a source node: same node class, name and effective attrs, and
     * nothing else (attrs only — the loaded node is never re-parented).
     *
     * <p>The copy is the model's ONLY source, and it is pinned to {@code @role: primary}:
     * a runtime resolves an object's relation through its primary source, so this is what
     * makes the read land on the selected source's physical name rather than on a default
     * table name nobody declared.</p>
     */
    @SuppressWarnings({"unchecked", "rawtypes"})
    private static MetaSource copySource(MetaSource source) {
        MetaSource copy = (MetaSource) source.newInstanceFromClass(
                (Class) source.getClass(), source.getType(), source.getSubType(), source.getName());
        // ADR-0039: resolving — the copy carries the source's effective configuration
        // (@kind, the physical-name alias, @schema, @unmanaged, @sql).
        for (MetaAttribute<?> attr : (List<MetaAttribute>) source.getMetaAttrs()) {
            if (!MetaSource.ATTR_ROLE.equals(attr.getShortName())) copy.addMetaAttr(copyAttr(attr));
        }
        copy.addMetaAttr(StringAttribute.create(MetaSource.ATTR_ROLE, MetaSource.ROLE_PRIMARY));
        return copy;
    }

    /** A parentless copy of an attr node (same class, name and value). */
    private static MetaAttribute<?> copyAttr(MetaAttribute<?> attr) {
        return (MetaAttribute<?>) attr.clone();
    }
}

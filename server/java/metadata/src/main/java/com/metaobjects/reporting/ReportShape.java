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
import com.metaobjects.field.CurrencyField;
import com.metaobjects.field.DateField;
import com.metaobjects.field.DecimalField;
import com.metaobjects.field.DoubleField;
import com.metaobjects.field.FloatField;
import com.metaobjects.field.IntegerField;
import com.metaobjects.field.LongField;
import com.metaobjects.field.MetaField;
import com.metaobjects.field.TimestampField;
import com.metaobjects.loader.ValidationPhase;
import com.metaobjects.object.MetaObject;
import com.metaobjects.reporting.ReportAccessors.ReportDimensionItem;
import com.metaobjects.source.MetaSource;

import java.util.ArrayList;
import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Set;

/**
 * A report's derived fields (FR-044, contract Table B): the read shape of an
 * {@code object.report}, which declares no fields of its own. One field per
 * {@code @dimensions} item in listed order, then one per {@code @measures} item in
 * listed order.
 *
 * <p>The single definition in the JVM ports — the Kotlin generators consume this class
 * rather than restating the table. Rule-for-rule the TypeScript {@code report-shape.ts};
 * gated by {@code fixtures/persistence-conformance/report-shapes.json}, which every port
 * byte-matches. Every read is RESOLVING (ADR-0039) unless a comment says otherwise.</p>
 *
 * <p>Pure metadata: nothing here touches a database, emits SQL (ADR-0015) or mutates the
 * loaded tree.</p>
 */
public final class ReportShape {

    /** Whether a derived field comes from a dimension or from a measure. */
    public enum Role {
        DIMENSION("dimension"),
        MEASURE("measure");

        private final String wireName;

        Role(String wireName) {
            this.wireName = wireName;
        }

        /** The role as the shapes artifact spells it. */
        public String wireName() {
            return wireName;
        }
    }

    /**
     * One derived field.
     *
     * @param name       the derived field name: the dimension name, {@code <dimension><Grain>}
     *                   for a time dimension, or the measure name. The physical column is the
     *                   naming strategy applied to THIS name; an {@code @column} on the
     *                   {@code @of} field is never inherited
     * @param role       dimension or measure
     * @param subType    a field subtype name ({@code long}, {@code decimal}, {@code date}, …)
     * @param required   whether the column can never be null
     * @param typeSource the {@code @of} field whose type-shaping attrs the derived field
     *                   carries ({@code @currency}, {@code @values}, {@code @intValueMap},
     *                   {@code @maxLength}, {@code @precision}, {@code @scale},
     *                   {@code @localTime}, {@code @objectRef}, {@code @storage},
     *                   {@code @dbColumnType} and array-ness), or {@code null} when it carries none
     * @param dimension  the dimension node, for a dimension field; else {@code null}
     * @param grain      the time grain, for a time dimension; else {@code null}
     * @param measure    the measure node, for a measure field; else {@code null}
     */
    public record Field(String name, Role role, String subType, boolean required, MetaField<?> typeSource,
                        MetaDimension dimension, String grain, MetaMeasure measure) {

        /**
         * {@code <resolution key of the entity that DECLARES the type source>.<field name>},
         * or {@code null} without a type source. The form the shapes artifact records.
         */
        public String typeSourceKey() {
            if (typeSource == null) return null;
            // The parent of a field is the object that declares it — for a field the
            // @of entity inherits through extends, that is the base, not the @of entity.
            MetaData owner = typeSource.getParent();
            if (owner == null) {
                throw new MetaDataException("field '" + typeSource.getName() + "' has no owning entity.");
            }
            return owner.getName() + SEP + typeSource.getName();
        }
    }

    /** The member separator of an {@code Entity.field} reference. */
    private static final String SEP = ".";

    private static final Set<String> SUM_LONG = Set.of(IntegerField.SUBTYPE_INT, LongField.SUBTYPE_LONG);
    private static final Set<String> FLOATING = Set.of(DoubleField.SUBTYPE_DOUBLE, FloatField.SUBTYPE_FLOAT);

    private final MetaObject report;
    private final MetaObject from;
    private final MetaRoot root;
    private final List<Field> fields;

    private ReportShape(MetaObject report, MetaObject from, MetaRoot root, List<Field> fields) {
        this.report = report;
        this.from = from;
        this.root = root;
        this.fields = Collections.unmodifiableList(fields);
    }

    /** The {@code object.report} node this shape was derived from. */
    public MetaObject report() {
        return report;
    }

    /** The {@code @from} entity. */
    public MetaObject from() {
        return from;
    }

    /** The derived fields, dimensions then measures, each in listed order. */
    public List<Field> fields() {
        return fields;
    }

    /**
     * The entity a derived field's {@code @of} field is READ from, by the rule that derived
     * the field ({@link #resolveFieldRef}): the {@code @from} entity for a measure or a
     * dimension without {@code @via}, and the entity the {@code @of} reference names for a
     * dimension with {@code @via}. {@code null} when that entity does not resolve, which a
     * shape derived from a loaded model cannot reach.
     *
     * <p>It is the entity whose generated artifacts describe the field (a Kotlin enum class,
     * say), which for an inherited field is not the object that declares it.</p>
     */
    public MetaObject ofEntity(Field field) {
        MetaDimension dim = field.dimension();
        if (dim == null || dim.getVia() == null) return from;
        return resolveFieldRefEntity(dim.getOf(), memberOwner(dim, from), root);
    }

    /**
     * The physical name of the view the report is read from, or {@code null} when the
     * report declares no read-only source (Table A: not lowered, not served).
     */
    public String viewName() {
        MetaSource source = readSource(report);
        return source == null ? null : source.getPhysicalName();
    }

    /**
     * The source a report is READ from: its own read-only source with {@code @role: primary},
     * else its first own read-only source; {@code null} when it declares none.
     *
     * <p>This is the rule that NAMES the lowered view in the TypeScript toolchain
     * ({@code viewName} / {@code projectionViewSource}). It is restated here because no port
     * but TypeScript lowers a report; the two must stay the same rule, or a runtime reads a
     * relation the lowering did not create. For every model that loads, the primary branch
     * fires (a report whose sources include no primary is refused at load); the fallback
     * covers a tree built in code.</p>
     */
    public static MetaSource readSource(MetaObject report) {
        MetaSource first = null;
        // ADR-0039: own — source classification reads the sources the report declares
        // ITSELF (getSources(false)), exactly as the lowering does. A report inherits no source.
        for (MetaSource source : report.getSources(false)) {
            if (!source.isReadOnly()) continue;
            if (MetaSource.ROLE_PRIMARY.equals(source.getRole())) return source;
            if (first == null) first = source;
        }
        return first;
    }

    /**
     * Table B for a report attached to a loaded model; the root is found from the report.
     *
     * @throws MetaDataException naming the report, when it is not under a root or a
     *                           reference does not resolve
     */
    public static ReportShape of(MetaObject report) {
        return of(report, rootOf(report));
    }

    /**
     * Table B.
     *
     * @param report an {@code object.report}
     * @param root   the model its references resolve in
     * @throws MetaDataException naming the report, when a reference does not resolve (a
     *                           report that passed the loader's reporting validation always resolves)
     */
    public static ReportShape of(MetaObject report, MetaRoot root) {
        String fromName = ReportAccessors.reportFrom(report);
        if (fromName == null) throw unresolved(report, "@from");
        MetaObject from = ValidationPhase.resolveRootObject(root, fromName, packageOf(report));
        if (from == null) throw unresolved(report, "@from '" + fromName + "'");

        List<Field> fields = new ArrayList<>();
        for (ReportDimensionItem item : ReportAccessors.reportDimensionItems(report)) {
            fields.add(dimensionField(item, from, root, report));
        }
        for (String item : ReportAccessors.reportMeasureNames(report)) {
            fields.add(measureField(item, from, root, report));
        }
        return new ReportShape(report, from, root, fields);
    }

    /**
     * The entity that DECLARES a dimension or measure reached through {@code from}: the
     * member's parent, which is {@code from} itself or an entity {@code from} extends. A bare
     * entity name inside the member ({@code @of}, {@code @via}) resolves in THIS entity's
     * package, exactly as the loader's reporting validation resolves it
     * ({@code pkgOf(ctx.declaring())}), never in {@code from}'s package or the report's.
     */
    public static MetaData memberOwner(MetaData member, MetaObject from) {
        MetaData parent = member.getParent();
        return parent != null ? parent : from;
    }

    /**
     * Resolve a dimension's or measure's {@code Entity.field} reference to the field node,
     * or {@code null}. The ONE rule, the same as the loader's (reporting validation D1 / M1)
     * and as the TypeScript {@code resolveReportingFieldRef}:
     *
     * <ol>
     *   <li>A package qualifier uses {@code ::}, so the member separator is the LAST dot.
     *       The entity half resolves relative to the package of {@code declaring}, the
     *       entity that declares the member ({@link #memberOwner}; ADR-0042).</li>
     *   <li>With {@code host} (a measure, or a dimension without {@code @via}: the reference
     *       is about the {@code @from} entity's own rows) the named entity must be
     *       {@code host} or an entity it extends, and the field is read from {@code host},
     *       so a field {@code host} redeclares wins.</li>
     *   <li>Without {@code host} ({@code null}: a dimension with {@code @via}) the field is
     *       read from the named entity.</li>
     * </ol>
     */
    public static MetaField<?> resolveFieldRef(String ref, MetaData declaring, MetaRoot root, MetaObject host) {
        MetaObject named = resolveFieldRefEntity(ref, declaring, root);
        if (named == null) return null;
        if (host != null && !isSelfOrAncestor(named, host)) return null;
        String fieldName = ref.substring(ref.lastIndexOf(SEP) + SEP.length());
        // ADR-0039: resolving, so a field inherited through extends is found.
        for (MetaField<?> f : (host != null ? host : named).getMetaFields()) {
            if (fieldName.equals(f.getName())) return f;
        }
        return null;
    }

    /**
     * The entity an {@code Entity.field} reference NAMES, or {@code null}: the entity half
     * of {@link #resolveFieldRef}, resolved relative to the package of {@code declaring}
     * (the entity that declares the dimension or measure carrying the reference). It is the
     * entity the reference is written against, which for an inherited field is not the
     * object that declares it.
     */
    public static MetaObject resolveFieldRefEntity(String ref, MetaData declaring, MetaRoot root) {
        if (ref == null) return null;
        int dot = ref.lastIndexOf(SEP);
        if (dot <= 0) return null;
        return ValidationPhase.resolveRootObject(root, ref.substring(0, dot), packageOf(declaring));
    }

    /** True when {@code candidate} is {@code entity} or an entity it extends (the super chain). */
    private static boolean isSelfOrAncestor(MetaData candidate, MetaData entity) {
        Set<MetaData> visited = Collections.newSetFromMap(new IdentityHashMap<>());
        for (MetaData n = entity; n != null && !visited.contains(n); n = n.getSuperData()) {
            if (n == candidate) return true;
            visited.add(n);
        }
        return false;
    }

    private static Field dimensionField(ReportDimensionItem item, MetaObject from, MetaRoot root, MetaObject report) {
        MetaDimension dim = declaredMember(from, MetaDimension.class, item.name());
        if (dim == null) throw unresolved(report, "dimension '" + item.name() + "' on '" + from.getShortName() + "'");
        boolean vialess = dim.getVia() == null;
        MetaField<?> of = dim.getOf() == null ? null
                : resolveFieldRef(dim.getOf(), memberOwner(dim, from), root, vialess ? from : null);
        if (of == null) throw unresolved(report, "dimension '" + item.name() + "' @of");

        String name = ReportAccessors.reportDerivedFieldName(item);
        // Attr only: a validator.required child does not make the column non-null.
        boolean required = vialess && ReportingAttrs.isTrue(of, MetaField.ATTR_REQUIRED);
        if (dim.isTime()) {
            // Loader rule R2 guarantees a grain from the closed set; a tree built in code does not.
            String grain = item.grain();
            if (grain == null || !ReportingConstants.TIME_GRAINS.contains(grain)) {
                throw unresolved(report, "time dimension '" + item.name() + "' grain '" + (grain == null ? "" : grain) + "'");
            }
            if (ReportingConstants.GRAIN_HOUR.equals(grain)) {
                return new Field(name, Role.DIMENSION, TimestampField.SUBTYPE_TIMESTAMP, required, of, dim, grain, null);
            }
            // day / week / month / quarter / year: the first day of the bucket.
            return new Field(name, Role.DIMENSION, DateField.SUBTYPE_DATE, required, null, dim, grain, null);
        }
        return new Field(name, Role.DIMENSION, of.getSubType(), required, of, dim, null, null);
    }

    /**
     * One {@code @measures} item, bare ({@code total}) or dotted ({@code Sale.total}, loader
     * rule R3). The measure is named by the item's last segment and looked up on
     * {@code from}; a qualifier resolves in the REPORT's package and must be {@code from} or
     * an entity {@code from} extends.
     */
    private static Field measureField(String item, MetaObject from, MetaRoot root, MetaObject report) {
        String name = ReportAccessors.reportMeasureItemName(item);
        String qualifier = ReportAccessors.reportMeasureItemOwner(item);
        if (qualifier != null) {
            MetaObject owner = ValidationPhase.resolveRootObject(root, qualifier, packageOf(report));
            if (owner == null || !isSelfOrAncestor(owner, from)) {
                throw unresolved(report, "measure '" + item + "' on '" + from.getShortName() + "'");
            }
        }
        MetaMeasure m = declaredMember(from, MetaMeasure.class, name);
        if (m == null) throw unresolved(report, "measure '" + item + "' on '" + from.getShortName() + "'");
        if (m.isRatio()) {
            return new Field(name, Role.MEASURE, DecimalField.SUBTYPE_DECIMAL, false, null, null, null, m);
        }
        String agg = m.getAgg();
        if (ReportingConstants.AGG_COUNT.equals(agg)) {
            // A count is never null, with or without @distinct.
            return new Field(name, Role.MEASURE, LongField.SUBTYPE_LONG, true, null, null, null, m);
        }
        List<String> columns = m.getOfColumns();
        MetaField<?> of = columns.isEmpty() ? null
                : resolveFieldRef(columns.get(0), memberOwner(m, from), root, from);
        if (of == null) throw unresolved(report, "measure '" + name + "' @of");
        String src = of.getSubType();
        if (ReportingConstants.AGG_SUM.equals(agg)) {
            if (CurrencyField.SUBTYPE_CURRENCY.equals(src)) {
                return new Field(name, Role.MEASURE, CurrencyField.SUBTYPE_CURRENCY, false, of, null, null, m);
            }
            String subType = SUM_LONG.contains(src) ? LongField.SUBTYPE_LONG
                    : FLOATING.contains(src) ? DoubleField.SUBTYPE_DOUBLE
                    : DecimalField.SUBTYPE_DECIMAL;
            return new Field(name, Role.MEASURE, subType, false, null, null, null, m);
        }
        if (ReportingConstants.AGG_AVG.equals(agg)) {
            String subType = FLOATING.contains(src) ? DoubleField.SUBTYPE_DOUBLE : DecimalField.SUBTYPE_DECIMAL;
            return new Field(name, Role.MEASURE, subType, false, null, null, null, m);
        }
        // min / max keep the source field's type.
        return new Field(name, Role.MEASURE, src, false, of, null, null, m);
    }

    private static <T extends MetaData> T declaredMember(MetaObject from, Class<T> type, String name) {
        // ADR-0039: resolving children, so a member declared on an abstract base is found.
        for (T member : from.getChildren(type, true)) {
            if (name.equals(member.getShortName())) return member;
        }
        return null;
    }

    /** The node's package for ADR-0042 bare-reference resolution. */
    private static String packageOf(MetaData node) {
        return node.getPackage() == null ? "" : node.getPackage();
    }

    private static MetaRoot rootOf(MetaObject report) {
        for (MetaData node = report.getParent(); node != null; node = node.getParent()) {
            if (node instanceof MetaRoot) return (MetaRoot) node;
        }
        throw new MetaDataException("report '" + report.getShortName()
                + "': is not attached to a model root; pass the root its references resolve in.");
    }

    private static MetaDataException unresolved(MetaObject report, String what) {
        return new MetaDataException("report '" + report.getShortName() + "': " + what + " does not resolve.");
    }
}

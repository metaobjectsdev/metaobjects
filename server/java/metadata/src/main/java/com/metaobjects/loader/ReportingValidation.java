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
package com.metaobjects.loader;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.metaobjects.ErrorCode;
import com.metaobjects.MetaData;
import com.metaobjects.MetaDataException;
import com.metaobjects.MetaRoot;
import com.metaobjects.attr.FilterAttribute;
import com.metaobjects.attr.MetaAttribute;
import com.metaobjects.field.BooleanField;
import com.metaobjects.field.CurrencyField;
import com.metaobjects.field.DateField;
import com.metaobjects.field.DecimalField;
import com.metaobjects.field.DoubleField;
import com.metaobjects.field.FloatField;
import com.metaobjects.field.IntegerField;
import com.metaobjects.field.LongField;
import com.metaobjects.field.MapField;
import com.metaobjects.field.MetaField;
import com.metaobjects.field.ObjectField;
import com.metaobjects.field.TimestampField;
import com.metaobjects.identity.MetaIdentity;
import com.metaobjects.loader.parser.BaseMetaDataParser;
import com.metaobjects.object.MetaObject;
import com.metaobjects.query.FilterOps;
import com.metaobjects.relationship.MetaRelationship;
import com.metaobjects.reporting.MetaDimension;
import com.metaobjects.reporting.MetaMeasure;
import com.metaobjects.reporting.MetaSegment;
import com.metaobjects.reporting.ReportAccessors;
import com.metaobjects.reporting.ReportAccessors.ReportDimensionItem;
import com.metaobjects.reporting.ReportingConstants;
import com.metaobjects.source.MetaSource;
import com.metaobjects.util.MetaDataUtil;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Consumer;
import java.util.regex.Pattern;

/**
 * FR-044 — cross-node rules for the reporting vocabulary. The rule ids (D1…F2) match the
 * rule table in the FR-044 Plan 1 document and the error fixtures in
 * {@code fixtures/conformance/error-*}. Every port implements the same table WITH THE SAME
 * MESSAGE TEXT; the TypeScript {@code reporting-validation.ts} is the reference and the
 * fixtures are the contract.
 *
 * <p>Two design rules hold throughout, so one broken rule yields exactly one error:</p>
 * <ul>
 *   <li>No cascades. A member that fails a structural rule is not checked further (a
 *       dimension whose {@code @via} fails D2 skips D1/D3/D4; a report whose {@code @from}
 *       fails R1 skips R2/R3/R6/R7 and its {@code @filter}; an invalid
 *       {@code @dimensions}/{@code @measures} item derives no report field for R6).</li>
 *   <li>Each error's source is the offending node (the dimension / measure / segment /
 *       report, or for R4/R5 the declared child), so a conformance fixture's jsonPath
 *       points at it.</li>
 * </ul>
 *
 * <p>Inheritance (ADR-0039): an entity's members are read through the resolving
 * {@code getChildren(..., true)}, so a member declared on an abstract base is validated
 * against every entity that inherits it. Members declared on an entity are validated first
 * (pass 1), then inherited ones (pass 2); an error already reported for the same node with
 * the same message is not repeated, so a broken base member is reported ONCE, and a failure
 * that only an inheritor exposes carries {@code " (inherited by '<entity>')"}.</p>
 *
 * <p>Java addition: {@code .withEnum} is decorative on attr children in this port (see
 * {@code validateRequirementStatus}), so the closed {@code @agg} / {@code @grains} sets the
 * TS registry enforces generically are checked here as {@code ERR_BAD_ATTR_VALUE}.</p>
 */
final class ReportingValidation {

    private ReportingValidation() {
    }

    // ---------------------------------------------------------------------------
    // Closed sets the rules consult
    // ---------------------------------------------------------------------------

    /** M4 — the field subtypes {@code sum}/{@code avg} accept. */
    private static final List<String> NUMERIC_FIELD_SUBTYPES = List.of(
            IntegerField.SUBTYPE_INT, LongField.SUBTYPE_LONG, DoubleField.SUBTYPE_DOUBLE,
            FloatField.SUBTYPE_FLOAT, DecimalField.SUBTYPE_DECIMAL, CurrencyField.SUBTYPE_CURRENCY);

    /** M4 — the field subtypes {@code min}/{@code max} refuse (no total order). */
    private static final List<String> UNORDERED_FIELD_SUBTYPES = List.of(
            BooleanField.SUBTYPE_BOOLEAN, ObjectField.SUBTYPE_OBJECT, MapField.SUBTYPE_MAP);

    /** D3 / F2 — the temporal field subtypes. */
    private static final List<String> TEMPORAL_FIELD_SUBTYPES = List.of(
            DateField.SUBTYPE_DATE, TimestampField.SUBTYPE_TIMESTAMP);

    /** F2 — the only ops a relative-date value may sit under. */
    private static final List<String> RELATIVE_DATE_OPS = List.of(
            FilterOps.FILTER_OP_GT, FilterOps.FILTER_OP_GTE, FilterOps.FILTER_OP_LT, FilterOps.FILTER_OP_LTE);

    /** Filter composition keys (the attr.filter grammar). */
    private static final String FILTER_COMPOSE_OR = "or";
    private static final String FILTER_COMPOSE_AND = "and";

    private static final String SEP = MetaDataUtil.CHILD_REF_SEPARATOR;

    /** JSON rendering of an operand for a message, matching JS {@code JSON.stringify}. */
    private static final Gson GSON = new GsonBuilder().disableHtmlEscaping().create();

    // ---------------------------------------------------------------------------
    // Entry point
    // ---------------------------------------------------------------------------

    /** Run every FR-044 rule over the loaded tree; returns the findings in emission order. */
    static List<MetaDataException> validate(MetaRoot root) {
        ErrorSink sink = new ErrorSink();
        // ADR-0039: own — root has no super; this lists the root-level declarations.
        List<MetaObject> objects = new ArrayList<>();
        for (MetaData c : root.getChildren(MetaData.class, false)) {
            if (c instanceof MetaObject) objects.add((MetaObject) c);
        }
        List<MetaObject> entities = new ArrayList<>();
        for (MetaObject o : objects) {
            if (MetaObject.SUBTYPE_ENTITY.equals(o.getSubType())) entities.add(o);
        }

        // Pass 1: every member against the entity that declares it (an abstract base
        // included — its members must be self-consistent). Pass 2: inherited members
        // against each inheriting entity, so an override that breaks one is caught.
        for (MetaObject entity : entities) checkEntityMembers(root, entity, true, sink);
        for (MetaObject entity : entities) checkEntityMembers(root, entity, false, sink);

        for (MetaObject o : objects) {
            if (MetaObject.SUBTYPE_REPORT.equals(o.getSubType())) checkReport(root, o, sink);
        }

        // F1 on every host that is not a reporting host.
        checkNoRelativeDates(root, sink);

        // Java-only: closed-set membership the TS registry enforces generically.
        checkClosedSets(root, sink);
        return sink.errors;
    }

    /**
     * Collects errors, dropping a repeat — the shape an unmodified inherited member's
     * failure takes when it is re-validated under an inheriting entity. A message is
     * {@code head + suffix + body}. A pass-2 error (suffix {@code " (inherited by '<entity>')"})
     * is dropped when pass 1 already reported the same failure without a suffix, or the
     * same inheritor already reported it; a second inheritor's identical failure is still
     * reported, under its own name.
     */
    private static final class ErrorSink {
        final List<MetaDataException> errors = new ArrayList<>();
        private final Map<MetaData, Set<String>> seen = new IdentityHashMap<>();

        void push(MetaData node, ErrorCode code, String head, String body) {
            push(node, code, head, body, "");
        }

        void push(MetaData node, ErrorCode code, String head, String body, String suffix) {
            // `base` drops a pass-2 copy of a failure pass 1 already reported; a pass-2
            // entry is keyed WITH its suffix, so two inheritors that break the same
            // inherited member the same way are each reported.
            String base = code.name() + "\u0000" + head + body;
            String key = base + "\u0000" + suffix;
            Set<String> keys = seen.computeIfAbsent(node, k -> new HashSet<>());
            if (keys.contains(base) || keys.contains(key)) return;
            keys.add(suffix.isEmpty() ? base : key);
            errors.add(new MetaDataException(head + suffix + body, code, node.getSource()));
        }
    }

    // ---------------------------------------------------------------------------
    // Shared helpers
    // ---------------------------------------------------------------------------

    /** The node's package for ADR-0042 bare-reference resolution. */
    private static String pkgOf(MetaData node) {
        return node.getPackage() == null ? "" : node.getPackage();
    }

    /** A dotted {@code Owner.child[.child…]} reference split into its owner and child path. */
    private record Dotted(String owner, List<String> path) {
    }

    /**
     * Split a dotted {@code Owner.child[.child…]} reference at the first {@code .} after the
     * last {@code ::} (the same rule {@code refNamedOwner} applies to extends refs), so an
     * FQN owner keeps its package. {@code null} when there is no owner, no child, or an
     * empty child segment.
     */
    private static Dotted splitDotted(String ref) {
        int lastSep = ref.lastIndexOf(MetaData.PKG_SEPARATOR);
        int segStart = lastSep == -1 ? 0 : lastSep + MetaData.PKG_SEPARATOR.length();
        int dot = ref.indexOf(SEP, segStart);
        if (dot <= segStart) return null;
        String[] parts = ref.substring(dot + SEP.length()).split(Pattern.quote(SEP), -1);
        for (String s : parts) {
            if (s.isEmpty()) return null;
        }
        return new Dotted(ref.substring(0, dot), List.of(parts));
    }

    /** True when {@code candidate} is {@code entity} or an entity it extends (the super chain). */
    private static boolean isSelfOrAncestor(MetaData candidate, MetaData entity) {
        if (candidate == null) return false;
        Set<MetaData> visited = java.util.Collections.newSetFromMap(new IdentityHashMap<>());
        for (MetaData n = entity; n != null && !visited.contains(n); n = n.getSuperData()) {
            if (n == candidate) return true;
            visited.add(n);
        }
        return false;
    }

    private static MetaData childOfType(MetaData obj, String type, String name) {
        // ADR-0039: resolving — inherited members (via extends) are visible.
        for (MetaData c : obj.getChildren(MetaData.class, true)) {
            if (type.equals(c.getType()) && name.equals(c.getShortName())) return c;
        }
        return null;
    }

    private static MetaData fieldOf(MetaData obj, String name) {
        return childOfType(obj, MetaField.TYPE_FIELD, name);
    }

    /** An object operand carrying a {@code now} key — a relative-date value, well-formed
     *  (exactly {@code { now }}) or not. A malformed one is refused, never read as data. */
    private static boolean isRelativeValue(Object v) {
        return v instanceof Map && ((Map<?, ?>) v).containsKey(ReportingConstants.FILTER_RELATIVE_NOW);
    }

    /** The relative value an op's operand carries: the operand itself, or one inside a list operand. */
    private static Map<?, ?> relativeOperand(Object v) {
        if (isRelativeValue(v)) return (Map<?, ?>) v;
        if (v instanceof List) {
            for (Object item : (List<?>) v) {
                if (isRelativeValue(item)) return (Map<?, ?>) item;
            }
        }
        return null;
    }

    /** Deep search of an operand VALUE: is a relative value (well-formed or not) anywhere inside it? */
    private static boolean operandContainsRelativeValue(Object v) {
        if (isRelativeValue(v)) return true;
        if (v instanceof List) {
            for (Object item : (List<?>) v) {
                if (operandContainsRelativeValue(item)) return true;
            }
            return false;
        }
        if (v instanceof Map) {
            for (Object item : ((Map<?, ?>) v).values()) {
                if (operandContainsRelativeValue(item)) return true;
            }
        }
        return false;
    }

    /**
     * Does a filter contain a relative value in any operand? Walks the filter grammar
     * ({@code and}/{@code or} arrays, {@code { field: { op: operand } }}) so only operand
     * VALUES are searched: a field key that happens to be named {@code now} is a field, not
     * a relative date.
     */
    private static boolean filterContainsRelativeValue(Object filter) {
        if (!(filter instanceof Map)) return false;
        for (Map.Entry<?, ?> e : ((Map<?, ?>) filter).entrySet()) {
            String key = String.valueOf(e.getKey());
            Object clause = e.getValue();
            if (FILTER_COMPOSE_OR.equals(key) || FILTER_COMPOSE_AND.equals(key)) {
                if (clause instanceof List) {
                    for (Object sub : (List<?>) clause) {
                        if (filterContainsRelativeValue(sub)) return true;
                    }
                }
                continue;
            }
            if (isRelativeValue(clause)) return true; // un-desugared shorthand
            if (clause instanceof Map) {
                for (Object operand : ((Map<?, ?>) clause).values()) {
                    if (operandContainsRelativeValue(operand)) return true;
                }
            }
        }
        return false;
    }

    private static String quoteValue(Object v) {
        return v instanceof String ? (String) v : GSON.toJson(v);
    }

    /**
     * The node's authored name, or "" for an unnamed node. Unnamed source / origin /
     * identity / view / validator nodes carry a parser auto-name ({@code <subType><N>}) in
     * this port; the TS reference leaves them empty, so the auto-name is not shown.
     */
    private static String displayName(MetaData node) {
        String shortName = node.getShortName();
        if (shortName == null) return "";
        if (BaseMetaDataParser.isAutoNamingType(node.getType())) {
            String sub = node.getSubType();
            String prefix = (sub != null && !sub.isEmpty() ? sub : node.getType()).toLowerCase(java.util.Locale.ROOT);
            if (shortName.isEmpty() || shortName.matches("^" + Pattern.quote(prefix) + "\\d+$")) return "";
        }
        return shortName;
    }

    /** {@code <type>.<subType> '<name>'}, or just {@code <type>.<subType>} for an unnamed node. */
    private static String childLabel(MetaData node) {
        String head = node.getType() + "." + node.getSubType();
        String name = displayName(node);
        return name.isEmpty() ? head : head + " '" + name + "'";
    }

    /** {@code <type>.<subType> '<FQN>'} for a root-level node, else its childLabel plus
     *  {@code " in <parent label>"}. */
    private static String nodeLabel(MetaData node) {
        MetaData parent = node.getParent();
        if (parent == null || parent.getParent() == null) {
            return node.getType() + "." + node.getSubType() + " '" + node.getName() + "'";
        }
        return childLabel(node) + " in " + nodeLabel(parent);
    }

    // ---------------------------------------------------------------------------
    // D1–D4, M1–M6, S1/F2 — members of an object.entity
    // ---------------------------------------------------------------------------

    /** Validation context for one member of one entity. */
    private record MemberCtx(
            MetaRoot root,
            /* The entity whose resolving children the member was reached through. */
            MetaData host,
            /* The entity that declares the member (the host, or an ancestor of it). */
            MetaData declaring,
            /* {@code <kind> '<name>' on entity '<declaring FQN>'} — every member message starts with it. */
            String label,
            /* "" in pass 1; " (inherited by '<host FQN>')" in pass 2. */
            String suffix,
            ErrorSink sink) {
    }

    /**
     * The FQN a member message names for {@code entity}: the DECLARING entity in place of
     * the host, so a failure is worded identically whichever entity reached the member (the
     * suffix names the inheritor) and the ErrorSink repeat test holds.
     */
    private static String shown(MemberCtx ctx, MetaData entity) {
        return (entity == ctx.host() ? ctx.declaring() : entity).getName();
    }

    private static void checkEntityMembers(MetaRoot root, MetaObject entity, boolean declaredHere, ErrorSink sink) {
        // ADR-0039: resolving — inherited members are validated against this entity.
        for (MetaData member : entity.getChildren(MetaData.class, true)) {
            if (!(member instanceof MetaDimension) && !(member instanceof MetaMeasure)
                    && !(member instanceof MetaSegment)) {
                continue;
            }
            MetaData declaring = member.getParent() != null ? member.getParent() : entity;
            if ((declaring == entity) != declaredHere) continue;
            MemberCtx ctx = new MemberCtx(
                    root, entity, declaring,
                    member.getType() + " '" + member.getShortName() + "' on entity '" + declaring.getName() + "'",
                    declaredHere ? "" : " (inherited by '" + entity.getName() + "')",
                    sink);
            if (member instanceof MetaDimension) {
                checkDimension(ctx, (MetaDimension) member);
            } else if (member instanceof MetaMeasure) {
                checkMeasure(ctx, (MetaMeasure) member);
            } else {
                Map<String, Object> filter = ((MetaSegment) member).getFilter();
                if (filter != null) {
                    checkFilter(filter, entity, declaring.getName(), ctx.label(), member, ctx.suffix(), sink);
                }
            }
        }
    }

    private static void checkDimension(MemberCtx ctx, MetaDimension dim) {
        Consumer<String> err = message ->
                ctx.sink().push(dim, ErrorCode.ERR_INVALID_DIMENSION, ctx.label(), ": " + message, ctx.suffix());

        // D2 — the @via walk; its terminal is the entity @of must name.
        MetaData ofEntity = ctx.host();
        String via = dim.getVia();
        if (via != null) {
            MetaData terminal = walkToOneVia(ctx, via, err);
            if (terminal == null) return;
            ofEntity = terminal;
        }

        // D1 — @of is Entity.field on the owning entity (or the @via terminal).
        String of = dim.getOf();
        if (of == null) return; // missing @of is ERR_MISSING_REQUIRED_ATTR (attr schema pass)
        Dotted parts = splitDotted(of);
        if (parts == null || parts.path().size() != 1) {
            err.accept("@of '" + of + "' must be Entity.field.");
            return;
        }
        MetaData named = ValidationPhase.resolveRootObject(ctx.root(), parts.owner(), pkgOf(ctx.declaring()));
        if (!isSelfOrAncestor(named, ofEntity)) {
            if (via == null) {
                err.accept("@of '" + of + "' must name a field of the owning entity '" + ctx.declaring().getName()
                        + "'. Reach another entity's field with @via.");
            } else {
                err.accept("@of '" + of + "' must name a field of '" + shown(ctx, ofEntity)
                        + "', the entity @via '" + via + "' reaches.");
            }
            return;
        }
        String fieldName = parts.path().get(0);
        MetaData field = fieldOf(ofEntity, fieldName);
        if (field == null) {
            err.accept("@of '" + of + "' names no field '" + fieldName + "' on '" + shown(ctx, ofEntity) + "'.");
            return;
        }

        if (!dim.isTime()) return;
        // D3 — a time dimension groups a date or timestamp.
        if (!TEMPORAL_FIELD_SUBTYPES.contains(field.getSubType())) {
            err.accept("a time dimension's @of must be a field.date or field.timestamp, but '" + of
                    + "' is field." + field.getSubType() + ".");
            return;
        }
        // D4 — a date has no hour.
        if (DateField.SUBTYPE_DATE.equals(field.getSubType()) && dim.getGrains().contains(ReportingConstants.GRAIN_HOUR)) {
            err.accept("grain 'hour' is impossible on '" + of
                    + "', a field.date (a date has no hour). Remove 'hour' from @grains.");
        }
    }

    /**
     * D2 — walk {@code Owner.hop[.hop...]}: Owner is the owning entity, and every hop is a
     * to-one {@code relationship.*} or an {@code identity.reference}. Returns the terminal
     * entity, or {@code null} after reporting the first failure.
     */
    private static MetaData walkToOneVia(MemberCtx ctx, String via, Consumer<String> err) {
        Dotted parts = splitDotted(via);
        if (parts == null) {
            err.accept("@via '" + via + "' must be Owner.hop[.hop...], starting at the owning entity.");
            return null;
        }
        MetaData owner = ValidationPhase.resolveRootObject(ctx.root(), parts.owner(), pkgOf(ctx.declaring()));
        if (!isSelfOrAncestor(owner, ctx.host())) {
            err.accept("@via '" + via + "' must start at the owning entity '" + ctx.declaring().getName() + "'.");
            return null;
        }
        MetaData current = ctx.host();
        for (String hopName : parts.path()) {
            MetaData hop = childOfType(current, MetaRelationship.TYPE_RELATIONSHIP, hopName);
            if (hop == null) {
                // ADR-0039: resolving — an inherited identity.reference is a hop too.
                for (MetaData c : current.getChildren(MetaData.class, true)) {
                    if (MetaIdentity.TYPE_IDENTITY.equals(c.getType())
                            && MetaIdentity.SUBTYPE_REFERENCE.equals(c.getSubType())
                            && hopName.equals(c.getShortName())) {
                        hop = c;
                        break;
                    }
                }
            }
            if (hop == null) {
                err.accept("@via '" + via + "' names '" + hopName
                        + "', which is not a relationship or identity.reference of '" + shown(ctx, current) + "'.");
                return null;
            }
            boolean isReference = MetaIdentity.TYPE_IDENTITY.equals(hop.getType());
            if (!isReference && !MetaRelationship.CARDINALITY_ONE.equals(stringAttr(hop, MetaRelationship.ATTR_CARDINALITY))) {
                err.accept("@via '" + via + "' crosses relationship '" + hopName + "' on '" + shown(ctx, current)
                        + "', which is not to-one. A dimension follows only @cardinality: one relationships and "
                        + "identity.reference hops, so grouping can never multiply the measured rows.");
                return null;
            }
            String targetRef = stringAttr(hop, isReference ? MetaIdentity.ATTR_REFERENCES : MetaRelationship.ATTR_OBJECT_REF);
            // ADR-0042 — a hop target resolves in the package of the entity declaring the hop.
            MetaData target = targetRef == null ? null
                    : ValidationPhase.resolveRootObject(ctx.root(), targetRef, pkgOf(current));
            if (target == null) {
                err.accept("@via '" + via + "' hop '" + hopName + "' on '" + shown(ctx, current) + "' targets no object.");
                return null;
            }
            current = target;
        }
        return current;
    }

    /** A string attr read RESOLVING (ADR-0039), or {@code null} when absent / not a string. */
    private static String stringAttr(MetaData node, String name) {
        if (!node.hasMetaAttr(name)) return null;
        Object v = node.getMetaAttr(name).getValue();
        return v instanceof String ? (String) v : null;
    }

    private static void checkMeasure(MemberCtx ctx, MetaMeasure measure) {
        Consumer<String> err = message ->
                ctx.sink().push(measure, ErrorCode.ERR_INVALID_MEASURE, ctx.label(), ": " + message, ctx.suffix());

        if (measure.isRatio()) {
            checkRatioOperands(ctx, measure, err);
            return;
        }
        if (!ReportingConstants.MEASURE_SUBTYPE_AGGREGATE.equals(measure.getSubType())) return;

        checkAggregateColumns(ctx, measure, err);

        // M5 — @segment names a segment of the owning entity.
        String segment = measure.getSegmentName();
        if (segment != null && childOfType(ctx.host(), ReportingConstants.TYPE_SEGMENT, segment) == null) {
            err.accept("@segment '" + segment + "' names no segment of '" + ctx.declaring().getName() + "'.");
        }

        // S1 / F2 — the measure's own row scope.
        Map<String, Object> filter = measure.getFilter();
        if (filter != null) {
            checkFilter(filter, ctx.host(), ctx.declaring().getName(), ctx.label(), measure, ctx.suffix(), ctx.sink());
        }
    }

    /** M1–M4, in order; the first failure stops the chain (no M2+M3 double report). */
    private static void checkAggregateColumns(MemberCtx ctx, MetaMeasure measure, Consumer<String> err) {
        String agg = measure.getAgg();
        List<String> columns = measure.getOfColumns();

        // M1 — every @of item is a field of the owning entity.
        List<MetaData> fields = new ArrayList<>();
        for (String item : columns) {
            Dotted parts = splitDotted(item);
            if (parts == null || parts.path().size() != 1) {
                err.accept("@of '" + item + "' must be Entity.field.");
                return;
            }
            MetaData named = ValidationPhase.resolveRootObject(ctx.root(), parts.owner(), pkgOf(ctx.declaring()));
            if (!isSelfOrAncestor(named, ctx.host())) {
                err.accept("@of '" + item + "' must name a field of the owning entity '" + ctx.declaring().getName()
                        + "'. A measure aggregates its own entity's rows; declare it on the entity that owns the column.");
                return;
            }
            MetaData field = fieldOf(ctx.host(), parts.path().get(0));
            if (field == null) {
                err.accept("@of '" + item + "' names no field '" + parts.path().get(0) + "' on '"
                        + ctx.declaring().getName() + "'.");
                return;
            }
            fields.add(field);
        }

        // M2 — a tuple is a distinct count only.
        if (columns.size() > 1 && (!ReportingConstants.AGG_COUNT.equals(agg) || !measure.isDistinct())) {
            err.accept("@of lists " + columns.size() + " columns; a tuple is legal only with @agg: count and "
                    + "@distinct: true (a distinct count of the tuple).");
            return;
        }

        // M3 — @distinct is a count modifier.
        if (measure.isDistinct() && agg != null && !ReportingConstants.AGG_COUNT.equals(agg)) {
            err.accept("@distinct: true requires @agg: count, not '" + agg + "'.");
            return;
        }

        // M4 — the aggregate must be meaningful for the column's type.
        MetaData field = fields.size() == 1 ? fields.get(0) : null;
        if (field == null || agg == null) return;
        String item = columns.get(0);
        if ((ReportingConstants.AGG_SUM.equals(agg) || ReportingConstants.AGG_AVG.equals(agg))
                && !NUMERIC_FIELD_SUBTYPES.contains(field.getSubType())) {
            err.accept("@agg '" + agg + "' needs a numeric field (field.int, long, double, float, decimal or currency), "
                    + "but '" + item + "' is field." + field.getSubType() + ".");
            return;
        }
        if ((ReportingConstants.AGG_MIN.equals(agg) || ReportingConstants.AGG_MAX.equals(agg))
                && UNORDERED_FIELD_SUBTYPES.contains(field.getSubType())) {
            err.accept("@agg '" + agg + "' cannot order '" + item + "', a field." + field.getSubType() + ".");
        }
    }

    /** M6 — each operand names a measure.aggregate of the same entity. */
    private static void checkRatioOperands(MemberCtx ctx, MetaMeasure ratio, Consumer<String> err) {
        String[][] operands = {
                {ReportingConstants.ATTR_NUMERATOR, ratio.getNumerator()},
                {ReportingConstants.ATTR_DENOMINATOR, ratio.getDenominator()},
        };
        for (String[] operand : operands) {
            String attr = operand[0];
            String ref = operand[1];
            if (ref == null) continue; // missing operand is ERR_MISSING_REQUIRED_ATTR
            MetaData target = childOfType(ctx.host(), ReportingConstants.TYPE_MEASURE, ref);
            if (target == null) {
                err.accept("@" + attr + " '" + ref + "' names no measure of '" + ctx.declaring().getName() + "'.");
            } else if (!ReportingConstants.MEASURE_SUBTYPE_AGGREGATE.equals(target.getSubType())) {
                err.accept("@" + attr + " '" + ref + "' is a measure." + target.getSubType()
                        + "; a ratio's operands must be measure.aggregate (a ratio of ratios is not supported).");
            }
        }
    }

    // ---------------------------------------------------------------------------
    // S1 / F2 — a reporting-host @filter over its entity
    // ---------------------------------------------------------------------------

    /**
     * Validate a canonical (post-desugar) attr.filter against {@code entity}'s fields: every
     * key names a field (S1), every op is legal for that field (S1), and a relative-date
     * operand sits on a date/timestamp, under a range op, with a valid ISO-8601 duration
     * (F2). One error per offending clause op.
     */
    private static void checkFilter(Map<?, ?> filter, MetaData entity, String entityKey, String hostLabel,
                                    MetaData host, String suffix, ErrorSink sink) {
        Consumer<String> err = message ->
                sink.push(host, ErrorCode.ERR_BAD_ATTR_FILTER, hostLabel, ": " + message, suffix);
        for (Map.Entry<?, ?> e : filter.entrySet()) {
            String key = String.valueOf(e.getKey());
            Object clause = e.getValue();
            if (FILTER_COMPOSE_OR.equals(key) || FILTER_COMPOSE_AND.equals(key)) {
                if (!(clause instanceof List)) {
                    err.accept("@filter '" + key + "' must be an array of sub-clauses.");
                    continue;
                }
                for (Object sub : (List<?>) clause) {
                    if (sub instanceof Map) {
                        checkFilter((Map<?, ?>) sub, entity, entityKey, hostLabel, host, suffix, sink);
                    } else {
                        err.accept("@filter '" + key + "' contains a non-object sub-clause.");
                    }
                }
                continue;
            }
            MetaData fieldNode = fieldOf(entity, key);
            if (!(fieldNode instanceof MetaField)) {
                err.accept("@filter names '" + key + "', which is not a field of '" + entityKey + "'.");
                continue;
            }
            MetaField<?> field = (MetaField<?>) fieldNode;
            if (!(clause instanceof Map) || ((Map<?, ?>) clause).isEmpty()) {
                err.accept("@filter on '" + key + "' must be an { op: value } object.");
                continue;
            }
            Set<String> allowed = FilterOps.opsForField(field);
            for (Map.Entry<?, ?> opEntry : ((Map<?, ?>) clause).entrySet()) {
                String op = String.valueOf(opEntry.getKey());
                if (!allowed.contains(op)) {
                    err.accept("@filter on '" + key + "' uses op '" + op + "', which is not allowed for field."
                            + field.getSubType() + ". Allowed ops: "
                            + (allowed.isEmpty() ? "(none)" : String.join(", ", allowed)) + ".");
                    continue;
                }
                Map<?, ?> relative = relativeOperand(opEntry.getValue());
                if (relative == null) continue;
                if (relative.size() != 1) {
                    err.accept("@filter on '" + key + "' has a malformed relative date " + GSON.toJson(relative)
                            + "; a relative date is exactly { now: \"<ISO-8601 duration>\" } with no other keys.");
                    continue;
                }
                if (!TEMPORAL_FIELD_SUBTYPES.contains(field.getSubType())) {
                    err.accept("@filter on '" + key + "' uses a relative date ({ now: ... }), but '" + key
                            + "' is field." + field.getSubType()
                            + "; relative dates apply only to field.date and field.timestamp.");
                    continue;
                }
                if (!RELATIVE_DATE_OPS.contains(op)) {
                    err.accept("@filter on '" + key + "' puts a relative date under op '" + op
                            + "'; relative dates are legal only under gt, gte, lt and lte.");
                    continue;
                }
                Object duration = relative.get(ReportingConstants.FILTER_RELATIVE_NOW);
                if (!(duration instanceof String)
                        || !ReportingConstants.ISO_DURATION_RE.matcher((String) duration).matches()) {
                    err.accept("@filter on '" + key + "' has relative date '" + quoteValue(duration)
                            + "', which is not an ISO-8601 duration (e.g. '-P7D', '-PT12H').");
                }
            }
        }
    }

    // ---------------------------------------------------------------------------
    // R1–R7 — object.report
    // ---------------------------------------------------------------------------

    private static void checkReport(MetaRoot root, MetaObject report, ErrorSink sink) {
        String label = "report '" + report.getName() + "'";

        // R4 — a report's fields and identity are derived, never declared.
        // ADR-0039: own — the rule is about what the author declared on THIS report.
        for (MetaData child : report.getChildren(MetaData.class, false)) {
            if (MetaField.TYPE_FIELD.equals(child.getType()) || MetaIdentity.TYPE_IDENTITY.equals(child.getType())) {
                sink.push(child, ErrorCode.ERR_INVALID_REPORT, label,
                        " declares " + childLabel(child) + "; a report's fields and identity are derived "
                                + "from @dimensions and @measures, never declared.");
            }
        }

        // R5 — a report is read-only, so any source it has is read-only.
        // ADR-0039: resolving — an inherited source binds the report just the same.
        for (MetaData child : report.getChildren(MetaData.class, true)) {
            if (child instanceof MetaSource && ((MetaSource) child).isWritable()) {
                sink.push(child, ErrorCode.ERR_INVALID_REPORT, label,
                        ": " + childLabel(child) + " is writable; a report is read-only, so its source must "
                                + "declare @kind: view.");
            }
        }

        // R1 — @from resolves to an object.entity. Without it, R2/R3/R6/R7 and the
        // @filter have nothing to resolve against, so they are skipped.
        String fromRef = ReportAccessors.reportFrom(report);
        if (fromRef == null) return; // missing @from is ERR_MISSING_REQUIRED_ATTR
        MetaObject from = ValidationPhase.resolveRootObject(root, fromRef, pkgOf(report));
        if (from == null) {
            sink.push(report, ErrorCode.ERR_INVALID_REPORT, label, ": @from '" + fromRef + "' does not resolve to an object.");
            return;
        }
        if (!MetaObject.SUBTYPE_ENTITY.equals(from.getSubType())) {
            sink.push(report, ErrorCode.ERR_INVALID_REPORT, label, ": @from '" + fromRef + "' is an "
                    + from.getType() + "." + from.getSubType() + "; a report aggregates the rows of an object.entity.");
            return;
        }
        String fromKey = from.getName();

        // R6 — derived field name -> the item that derived it ("dimension item 'x'" / "measure 'y'").
        Map<String, String> derived = new LinkedHashMap<>();
        java.util.function.BiConsumer<String, String> claim = (fieldName, what) -> {
            String prior = derived.get(fieldName);
            if (what.equals(prior)) {
                // The same measure listed twice: name the repeat, not a "collision" with itself.
                sink.push(report, ErrorCode.ERR_INVALID_REPORT, label, ": @measures lists '" + fieldName + "' more than once.");
                return;
            }
            if (prior != null) {
                sink.push(report, ErrorCode.ERR_INVALID_REPORT, label, ": " + prior + " and " + what
                        + " both derive report field '" + fieldName + "'. Report field names must be unique; "
                        + "rename the measure or drop one item.");
                return;
            }
            derived.put(fieldName, what);
        };

        // R2 — each @dimensions item names a dimension of @from, with a grain exactly when it is a time dimension.
        Set<String> seenItems = new HashSet<>();
        for (ReportDimensionItem item : ReportAccessors.reportDimensionItems(report)) {
            String raw = item.grain() == null ? item.name()
                    : item.name() + ReportingConstants.REPORT_DIMENSION_GRAIN_SEPARATOR + item.grain();
            if (seenItems.contains(raw)) {
                sink.push(report, ErrorCode.ERR_INVALID_REPORT, label, ": @dimensions lists '" + raw + "' more than once.");
                continue;
            }
            seenItems.add(raw);
            MetaData dimNode = childOfType(from, ReportingConstants.TYPE_DIMENSION, item.name());
            if (!(dimNode instanceof MetaDimension)) {
                sink.push(report, ErrorCode.ERR_INVALID_REPORT, label, ": @dimensions item '" + raw
                        + "' names no dimension of @from '" + fromKey + "'.");
                continue;
            }
            MetaDimension dim = (MetaDimension) dimNode;
            if (dim.isTime()) {
                List<String> grains = dim.getGrains();
                if (item.grain() == null) {
                    sink.push(report, ErrorCode.ERR_INVALID_REPORT, label, ": @dimensions item '" + raw
                            + "' names time dimension '" + item.name() + "' without a grain; write '" + item.name()
                            + ":<grain>' with a grain from its @grains (" + String.join(", ", grains) + ").");
                    continue;
                }
                if (!grains.contains(item.grain())) {
                    sink.push(report, ErrorCode.ERR_INVALID_REPORT, label, ": @dimensions item '" + raw
                            + "' uses grain '" + item.grain() + "', which time dimension '" + item.name()
                            + "' does not declare. Its @grains: " + String.join(", ", grains) + ".");
                    continue;
                }
            } else if (item.grain() != null) {
                sink.push(report, ErrorCode.ERR_INVALID_REPORT, label, ": @dimensions item '" + raw
                        + "' gives a grain to attribute dimension '" + item.name()
                        + "'; only a time dimension takes a grain.");
                continue;
            }
            claim.accept(ReportAccessors.reportDerivedFieldName(item), "dimension item '" + raw + "'");
        }

        // R3 — each @measures item names a measure of @from.
        for (String item : ReportAccessors.reportMeasureNames(report)) {
            String measureName = checkReportMeasure(root, report, from, item, label, sink);
            if (measureName != null) claim.accept(measureName, "measure '" + measureName + "'");
        }

        // R7 — @segment names a segment of @from.
        String segment = stringAttr(report, MetaObject.ATTR_REPORT_SEGMENT);
        if (segment != null && childOfType(from, ReportingConstants.TYPE_SEGMENT, segment) == null) {
            sink.push(report, ErrorCode.ERR_INVALID_REPORT, label, ": @segment '" + segment
                    + "' names no segment of @from '" + fromKey + "'.");
        }

        // S1 / F2 — the report's row scope over @from.
        // ADR-0039: resolving — a report that extends another inherits its @filter.
        if (report.hasMetaAttr(MetaObject.ATTR_FILTER)) {
            Object filter = report.getMetaAttr(MetaObject.ATTR_FILTER).getValue();
            if (filter instanceof Map) checkFilter((Map<?, ?>) filter, from, fromKey, label, report, "", sink);
        }
    }

    /**
     * R3 for one {@code @measures} item (bare {@code name} or dotted {@code Entity.name}).
     * Returns the measure's name when it is a measure of {@code @from} (for R6), else reports
     * ERR_REPORT_FOREIGN_MEASURE (it is another entity's measure) or ERR_INVALID_REPORT (it
     * is nobody's) and returns {@code null}.
     */
    private static String checkReportMeasure(MetaRoot root, MetaObject report, MetaObject from, String item,
                                             String label, ErrorSink sink) {
        String fromKey = from.getName();
        MetaData owner;
        Dotted parts = splitDotted(item);
        if (parts != null && parts.path().size() == 1) {
            owner = ValidationPhase.resolveRootObject(root, parts.owner(), pkgOf(report));
            String name = parts.path().get(0);
            if (owner != null && isSelfOrAncestor(owner, from)
                    && childOfType(from, ReportingConstants.TYPE_MEASURE, name) != null) {
                return name;
            }
            if (owner != null && childOfType(owner, ReportingConstants.TYPE_MEASURE, name) == null) owner = null;
        } else if (!item.contains(SEP)) {
            String name = item;
            if (childOfType(from, ReportingConstants.TYPE_MEASURE, name) != null) return name;
            owner = null;
            // ADR-0039: own — root has no super; this lists the root-level declarations.
            for (MetaData o : root.getChildren(MetaData.class, false)) {
                if (o instanceof MetaObject && MetaObject.SUBTYPE_ENTITY.equals(o.getSubType())
                        && childOfType(o, ReportingConstants.TYPE_MEASURE, name) != null) {
                    owner = o;
                    break;
                }
            }
        } else {
            owner = null;
        }

        if (owner != null) {
            String ownerKey = owner.getName();
            sink.push(report, ErrorCode.ERR_REPORT_FOREIGN_MEASURE, label,
                    " lists measure '" + item.substring(item.lastIndexOf(SEP) + 1) + "', which belongs to '"
                            + ownerKey + "', not @from '" + fromKey + "'. All measures of a report come from @from; "
                            + "make a second report over '" + ownerKey + "'.");
        } else {
            sink.push(report, ErrorCode.ERR_INVALID_REPORT, label,
                    ": @measures item '" + item + "' names no measure of @from '" + fromKey + "' or of any other entity.");
        }
        return null;
    }

    // ---------------------------------------------------------------------------
    // F1 — relative-date values only on reporting hosts
    // ---------------------------------------------------------------------------

    /** True for the hosts whose {@code @filter} may carry a relative-date value. */
    private static boolean isReportingFilterHost(MetaData node) {
        return ReportingConstants.TYPE_SEGMENT.equals(node.getType())
                || (ReportingConstants.TYPE_MEASURE.equals(node.getType())
                    && ReportingConstants.MEASURE_SUBTYPE_AGGREGATE.equals(node.getSubType()))
                || (MetaObject.TYPE_OBJECT.equals(node.getType()) && MetaObject.SUBTYPE_REPORT.equals(node.getSubType()));
    }

    /**
     * F1 — walk the whole tree and refuse a {@code { now: ... }} value in any attr.filter
     * outside a reporting host (a projection {@code @filter}, a dataGrid preset, an
     * origin.aggregate/first {@code @filter}): those hosts have no lowering for it.
     */
    private static void checkNoRelativeDates(MetaData node, ErrorSink sink) {
        // ADR-0039: own — a tree walk; each declared node (and each locally declared attr)
        // is visited once, at its declaration (an inherited filter is checked where it is
        // declared; origin.* never inherits, ADR-0029). Attrs are children in this port.
        List<MetaData> own = node.getChildren(MetaData.class, false);
        if (!isReportingFilterHost(node)) {
            for (MetaData c : own) {
                if (c instanceof FilterAttribute
                        && filterContainsRelativeValue(((MetaAttribute<?>) c).getValue())) {
                    sink.push(node, ErrorCode.ERR_BAD_ATTR_FILTER, nodeLabel(node),
                            ": @" + c.getShortName() + " uses a relative date ({ now: ... }), which is legal only in "
                                    + "the @filter of a segment, measure.aggregate or object.report.");
                }
            }
        }
        for (MetaData c : own) {
            if (!(c instanceof MetaAttribute)) checkNoRelativeDates(c, sink);
        }
    }

    // ---------------------------------------------------------------------------
    // Closed sets (Java: the registry's allowedValues are not enforced generically)
    // ---------------------------------------------------------------------------

    /**
     * {@code measure.aggregate @agg} and {@code dimension.time @grains} hold members of their
     * closed sets ({@code ERR_BAD_ATTR_VALUE}, one error per offending value, as the TS
     * attr-schema check reports them).
     */
    private static void checkClosedSets(MetaData node, ErrorSink sink) {
        if (node instanceof MetaMeasure && ReportingConstants.MEASURE_SUBTYPE_AGGREGATE.equals(node.getSubType())) {
            // ADR-0039: own — an attr rule validates the attr on the node that DECLARES it.
            String agg = node.hasMetaAttr(ReportingConstants.ATTR_AGG, false)
                    ? stringAttr(node, ReportingConstants.ATTR_AGG) : null;
            if (agg != null && !ReportingConstants.MEASURE_AGGS.contains(agg)) {
                pushBadValue(node, ReportingConstants.ATTR_AGG, agg, ReportingConstants.MEASURE_AGGS, sink);
            }
        }
        if (node instanceof MetaDimension && ((MetaDimension) node).isTime()
                // ADR-0039: own — an attr rule validates the attr on the node that DECLARES it.
                && node.hasMetaAttr(ReportingConstants.ATTR_GRAINS, false)) {
            Object v = node.getMetaAttr(ReportingConstants.ATTR_GRAINS, false).getValue();
            List<?> items = v instanceof List ? (List<?>) v : v == null ? List.of() : List.of(v);
            for (Object g : items) {
                if (!ReportingConstants.TIME_GRAINS.contains(String.valueOf(g))) {
                    pushBadValue(node, ReportingConstants.ATTR_GRAINS, String.valueOf(g), ReportingConstants.TIME_GRAINS, sink);
                }
            }
        }
        // ADR-0039: own — a tree walk; each declared node is visited once, at its declaration.
        for (MetaData c : node.getChildren(MetaData.class, false)) {
            if (!(c instanceof MetaAttribute)) checkClosedSets(c, sink);
        }
    }

    private static void pushBadValue(MetaData node, String attr, String value, List<String> allowed, ErrorSink sink) {
        // The TS attr-schema check's short label (`type.subType 'name'`, no parent chain).
        sink.push(node, ErrorCode.ERR_BAD_ATTR_VALUE, childLabel(node),
                " attribute '@" + attr + "' has value '" + value + "' which is not one of the allowed values: "
                        + String.join(", ", allowed));
    }
}

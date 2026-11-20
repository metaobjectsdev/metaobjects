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

import com.metaobjects.ErrorCode;
import com.metaobjects.MetaData;
import com.metaobjects.MetaDataException;
import com.metaobjects.MetaRoot;
import com.metaobjects.api.ApiConstants;
import com.metaobjects.api.Lifecycles;
import com.metaobjects.field.EnumField;
import com.metaobjects.field.MetaField;
import com.metaobjects.object.MetaObject;
import com.metaobjects.source.MetaSource;
import com.metaobjects.transition.TransitionConstants;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collection;
import java.util.Collections;
import java.util.EnumSet;
import java.util.IdentityHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * ADR-0066 — cross-node rules for operations (slice A) and lifecycles (slice B). Every port
 * implements the same rules WITH THE SAME MESSAGE TEXT; the TypeScript
 * {@code rules-validation.ts} is the reference and {@code fixtures/conformance/error-rules-*}
 * (with the positive {@code rules-*} cases) are the contract.
 *
 * <p>One broken rule yields one error: each error's source is the offending node (the
 * transition, the enum field (L3), the entity (L2b), the operation or the binding); an
 * operation that fails O1 is not checked further, one whose target fails O2 or O3 is not
 * checked for O4 or B1; and an error is reported once per (node, code), so a broken transition
 * on an abstract base is reported once, not once per inheritor.</p>
 *
 * <p>Rules: L1 and L2 {@code ERR_TRANSITION_NOT_ON_ENTITY}; L3 {@code ERR_LIFECYCLE_NO_INITIAL};
 * L4 {@code ERR_TRANSITION_UNKNOWN_STATE}; L5, L6 and O0 {@code ERR_TRANSITION_NAME_COLLISION};
 * L7 and O5 {@code ERR_BAD_ATTR_VALUE}; P1 {@code ERR_PERMISSION_PUBLIC_CONFLICT}; P2 {@code ERR_BAD_ATTR_VALUE} (@permission shape); O1
 * {@code ERR_OPERATION_SHAPE}; O2 {@code ERR_OPERATION_TARGET_UNRESOLVED}; O3
 * {@code ERR_OPERATION_TARGET_MISMATCH}; O4 {@code ERR_OPERATION_UNKNOWN_TRANSITION}; B1
 * {@code ERR_BINDING_PATH_MISMATCH}.</p>
 */
final class RulesValidation {

    private RulesValidation() {
    }

    private static final Set<String> RESERVED = new LinkedHashSet<>(ApiConstants.RESERVED_OPERATION_NAMES);
    private static final String RESERVED_LIST = String.join(", ", ApiConstants.RESERVED_OPERATION_NAMES);
    private static final Set<String> RESERVED_CODES = new LinkedHashSet<>(ApiConstants.RESERVED_ERROR_CODES);
    private static final Pattern PLACEHOLDER = Pattern.compile("\\{([^}]*)\\}");

    /** A derived name is compared without case: a command, a permission constant or a file named from it collides on a case-folding target. */
    private static boolean isReservedName(String name) {
        return RESERVED.contains(name.toLowerCase(java.util.Locale.ROOT));
    }

    /** {@code "Entity.field.transition"} for a transition, {@code "Api.operation"} for an operation. */
    private static String label(MetaData node) {
        List<String> parts = new ArrayList<>();
        // A binding is unnamed (its parser-generated name is not shown): its label is its operation's.
        for (MetaData n = node; n != null && n.getParent() != null; n = n.getParent()) {
            String name = n.getShortName();
            if (name == null || name.isEmpty() || n.isAutoNamed()) continue;
            parts.add(0, name);
        }
        return String.join(".", parts);
    }

    private static String quoteList(Collection<String> xs) {
        List<String> q = new ArrayList<>();
        for (String x : xs) q.add("\"" + x + "\"");
        return String.join(", ", q);
    }

    private static final class Sink {
        final List<MetaDataException> errors = new ArrayList<>();
        private final Map<MetaData, Set<ErrorCode>> seen = new IdentityHashMap<>();

        void add(MetaData node, ErrorCode code, String message) {
            if (!seen.computeIfAbsent(node, k -> EnumSet.noneOf(ErrorCode.class)).add(code)) return;
            errors.add(new MetaDataException(message, code, node.getSource()));
        }
    }

    /** P1 and P2 for an operation or a transition. */
    private static void checkPermission(MetaData node, Sink sink) {
        boolean isPublic = node.hasMetaAttr(ApiConstants.ATTR_PUBLIC)
            && Boolean.TRUE.equals(node.getMetaAttr(ApiConstants.ATTR_PUBLIC).getValue());
        if (isPublic && node.hasMetaAttr(ApiConstants.ATTR_PERMISSION)) {
            sink.add(node, ErrorCode.ERR_PERMISSION_PUBLIC_CONFLICT,
                node.getType() + "." + node.getSubType() + " \"" + label(node)
                    + "\" declares both @public: true and @permission; a public " + node.getType()
                    + " calls no permission check, so remove one.");
        }
        String permission = Lifecycles.stringValue(node, ApiConstants.ATTR_PERMISSION);
        if (permission != null && !ApiConstants.PERMISSION_NAME_PATTERN.matcher(permission).matches()) {
            sink.add(node, ErrorCode.ERR_BAD_ATTR_VALUE,
                node.getType() + "." + node.getSubType() + " \"" + label(node) + "\" @permission \"" + permission
                    + "\" is not a dotted identifier path; use names of letters, digits and _ joined by \".\" "
                    + "(a package prefix may use \"::\"), such as \"purchasing.approve\".");
        }
    }

    /** L1, L3, L4, L5, L7 and P1 for the transitions declared on one field. */
    private static void checkDeclaredTransitions(MetaData field, Sink sink) {
        List<MetaData> declared = new ArrayList<>();
        // ADR-0039: own — each transition is checked where it is declared.
        for (MetaData c : field.getChildren(MetaData.class, false)) {
            if (TransitionConstants.TYPE_TRANSITION.equals(c.getType())
                    && TransitionConstants.SUBTYPE_ACTION.equals(c.getSubType())) declared.add(c);
        }
        if (declared.isEmpty()) return;
        MetaData owner = field.getParent();
        if (!Lifecycles.isEntity(owner)) {
            String where = owner == null || !MetaObject.TYPE_OBJECT.equals(owner.getType())
                ? "the document root" : "object." + owner.getSubType() + " \"" + owner.getShortName() + "\"";
            for (MetaData t : declared) {
                sink.add(t, ErrorCode.ERR_TRANSITION_NOT_ON_ENTITY,
                    "transition.action \"" + label(t) + "\" is declared on a field of " + where
                        + "; a lifecycle belongs to an object.entity with a writable source.");
            }
            return;
        }
        if (EnumField.SUBTYPE_ENUM.equals(field.getSubType())
                && Lifecycles.stringValue(field, MetaField.ATTR_DEFAULT) == null) {
            sink.add(field, ErrorCode.ERR_LIFECYCLE_NO_INITIAL,
                "field.enum \"" + label(field) + "\" declares transitions but no @default; its @default is the lifecycle's initial state.");
        }
        // ADR-0039: RESOLVING array-ness (isArrayType), never the own-only native flag.
        if (field instanceof MetaField mf && mf.isArrayType()) {
            sink.add(field, ErrorCode.ERR_BAD_ATTR_VALUE,
                "field." + field.getSubType() + " \"" + label(field)
                    + "\" declares transitions but is an array (@isArray: true); a lifecycle's state is one value.");
        }
        Set<String> states = new LinkedHashSet<>(Lifecycles.stringList(field, EnumField.ATTR_VALUES));
        for (MetaData t : declared) {
            checkPermission(t, sink);
            if (Lifecycles.transitionFrom(t).isEmpty()) {
                sink.add(t, ErrorCode.ERR_BAD_ATTR_VALUE,
                    "transition.action \"" + label(t) + "\" @from is empty; name at least one state the transition leaves.");
            }
            String to = Lifecycles.transitionTo(t);
            Set<String> mentioned = new LinkedHashSet<>(Lifecycles.transitionFrom(t));
            if (to != null) mentioned.add(to);
            List<String> unknown = new ArrayList<>();
            for (String s : mentioned) if (!states.contains(s)) unknown.add(s);
            if (!unknown.isEmpty()) {
                sink.add(t, ErrorCode.ERR_TRANSITION_UNKNOWN_STATE,
                    "transition.action \"" + label(t) + "\" names " + quoteList(unknown) + ", which "
                        + (unknown.size() == 1 ? "is not a member" : "are not members") + " of \"" + field.getShortName()
                        + "\" @values (" + quoteList(states) + ").");
            }
            if (isReservedName(t.getShortName())) {
                sink.add(t, ErrorCode.ERR_TRANSITION_NAME_COLLISION,
                    "transition.action \"" + label(t) + "\" is named \"" + t.getShortName()
                        + "\", which is a derived CRUD verb (" + RESERVED_LIST + "); rename it.");
            }
            if (t.hasMetaAttr(TransitionConstants.ATTR_CONDITION)) {
                // L7 reuses the cross-field validator's @condition grammar check.
                String message = ValidationPhase.conditionMessage(
                    t.getMetaAttr(TransitionConstants.ATTR_CONDITION).getValue(), (MetaObject) owner,
                    "transition.action \"" + label(t) + "\" @condition");
                if (message != null) sink.add(t, ErrorCode.ERR_BAD_ATTR_VALUE, message);
            }
        }
    }

    /** Every field declared in the tree: at the root and on every object. */
    private static List<MetaData> declaredFields(MetaData root) {
        List<MetaData> out = new ArrayList<>();
        // ADR-0039: own — a structural walk over the declarations themselves.
        for (MetaData top : root.getChildren(MetaData.class, false)) {
            if (MetaField.TYPE_FIELD.equals(top.getType())) {
                out.add(top);
            } else if (MetaObject.TYPE_OBJECT.equals(top.getType())) {
                for (MetaData c : top.getChildren(MetaData.class, false)) {
                    if (MetaField.TYPE_FIELD.equals(c.getType())) out.add(c);
                }
            }
        }
        return out;
    }

    /**
     * L10: an entity's field named like an ancestor's lifecycle field that does not carry that
     * lifecycle's transitions. Redeclaring the field replaces it, so the base's state machine
     * would silently stop applying to this entity.
     */
    private static void checkRedeclaredLifecycles(MetaData entity, Sink sink) {
        List<MetaData> lineage = Lifecycles.entityLineage(entity);
        for (MetaData ancestor : lineage.subList(1, lineage.size())) {
            // ADR-0039: own — the lifecycle fields the ancestor itself declares.
            for (MetaData baseField : ancestor.getChildren(MetaData.class, false)) {
                if (!MetaField.TYPE_FIELD.equals(baseField.getType())) continue;
                List<MetaData> baseTransitions = Lifecycles.lifecycleTransitionsOf(ancestor, baseField);
                if (baseTransitions.isEmpty()) continue;
                MetaData field = null;
                for (MetaData c : entity.getChildren(MetaData.class, true)) {
                    if (MetaField.TYPE_FIELD.equals(c.getType()) && c.getShortName().equals(baseField.getShortName())) { field = c; break; }
                }
                if (field == null || field == baseField) continue;
                List<MetaData> kept = Lifecycles.lifecycleTransitionsOf(entity, field);
                boolean all = true;
                for (MetaData t : baseTransitions) if (!Lifecycles.containsIdentity(kept, t)) all = false;
                if (all) continue;
                sink.add(field, ErrorCode.ERR_LIFECYCLE_REDECLARED,
                    "field." + field.getSubType() + " \"" + label(field) + "\" redeclares \"" + label(baseField)
                        + "\", which has a lifecycle, and drops its transitions; extend it (\"extends\": \""
                        + ancestor.getShortName() + "." + baseField.getShortName() + "\") or give the field another name.");
            }
        }
    }

    /** L2, L6 and L10 for one entity, over its effective (inherited) lifecycles. */
    private static void checkEntityLifecycles(MetaData entity, Sink sink) {
        checkRedeclaredLifecycles(entity, sink);
        List<MetaData> transitions = Lifecycles.entityTransitions(entity);
        if (transitions.isEmpty()) return;
        Map<String, MetaData> byName = new java.util.LinkedHashMap<>();
        for (MetaData t : transitions) {
            MetaData first = byName.putIfAbsent(t.getShortName().toLowerCase(java.util.Locale.ROOT), t);
            if (first != null && first != t) {
                sink.add(t, ErrorCode.ERR_TRANSITION_NAME_COLLISION,
                    "transition.action \"" + label(t) + "\" has the same name as \"" + label(first)
                        + "\" (names are compared without case); the transitions of \"" + entity.getShortName()
                        + "\" share one namespace (each may derive a command), so rename one.");
            }
        }
        boolean writable = false;
        for (MetaData c : entity.getChildren(MetaData.class, true)) {
            if (c instanceof MetaSource src && src.isWritable()) { writable = true; break; }
        }
        if (!Lifecycles.isAbstract(entity) && Lifecycles.lifecycleIsLive(entity) && !writable) {
            Set<String> fields = new LinkedHashSet<>();
            for (MetaData t : transitions) fields.add(t.getParent() == null ? "" : t.getParent().getShortName());
            sink.add(entity, ErrorCode.ERR_TRANSITION_NOT_ON_ENTITY,
                "object.entity \"" + entity.getShortName() + "\" has a lifecycle (transitions on " + quoteList(fields)
                    + ") and a source, but no writable one; a transition is a guarded update of a stored row. "
                    + "(An entity with no source at all may carry a lifecycle: it is inert until a source is added.)");
        }
    }

    private static String objectKind(MetaData node) {
        return node == null ? "names no object" : "is an object." + node.getSubType();
    }

    /** O0-O5, P1 and B1 for one operation. */
    private static void checkOperation(MetaData op, Sink sink) {
        String head = "operation." + op.getSubType() + " \"" + label(op) + "\"";
        if (isReservedName(op.getShortName())) {
            sink.add(op, ErrorCode.ERR_TRANSITION_NAME_COLLISION,
                head + " is named \"" + op.getShortName() + "\", which is a derived CRUD verb (" + RESERVED_LIST + "); rename it.");
        }
        checkPermission(op, sink);

        List<String> errorCodes = Lifecycles.stringList(op, ApiConstants.ATTR_ERRORS);
        List<String> bad = new ArrayList<>();
        List<String> dup = new ArrayList<>();
        for (int i = 0; i < errorCodes.size(); i++) {
            String c = errorCodes.get(i);
            if (!ApiConstants.BUSINESS_ERROR_CODE_PATTERN.matcher(c).matches()) bad.add(c);
            if (errorCodes.indexOf(c) != i) dup.add(c);
        }
        Set<String> reserved = new LinkedHashSet<>();
        for (String c : errorCodes) if (RESERVED_CODES.contains(c)) reserved.add(c);
        if (!bad.isEmpty() || !dup.isEmpty() || !reserved.isEmpty()) {
            String why;
            if (!bad.isEmpty()) {
                why = quoteList(bad) + " " + (bad.size() == 1 ? "is not a" : "are not") + " lower snake case code"
                    + (bad.size() == 1 ? "" : "s");
            } else if (!dup.isEmpty()) {
                Set<String> uniq = new LinkedHashSet<>(dup);
                why = quoteList(uniq) + " " + (uniq.size() == 1 ? "is" : "are") + " listed twice";
            } else {
                why = quoteList(reserved) + " " + (reserved.size() == 1 ? "is a code" : "are codes")
                    + " the route answers itself (" + String.join(", ", ApiConstants.RESERVED_ERROR_CODES) + ")";
            }
            sink.add(op, ErrorCode.ERR_BAD_ATTR_VALUE, head + " @errors: " + why + ".");
        }

        // Java addition: .withEnum is decorative on attr children in this port, so the closed
        // @method set the TS registry enforces generically is checked here.
        // ADR-0039: own — a binding is checked on the operation that declares it.
        for (MetaData b : op.getChildren(MetaData.class, false)) {
            if (!ApiConstants.TYPE_BINDING.equals(b.getType()) || !b.hasMetaAttr(ApiConstants.ATTR_METHOD, false)) continue;
            String method = Lifecycles.stringValue(b, ApiConstants.ATTR_METHOD);
            if (method != null && !ApiConstants.BINDING_METHODS.contains(method)) {
                sink.add(b, ErrorCode.ERR_BAD_ATTR_VALUE,
                    b.getType() + "." + b.getSubType() + " attribute '@" + ApiConstants.ATTR_METHOD + "' has value '" + method
                        + "' which is not one of the allowed values: " + String.join(", ", ApiConstants.BINDING_METHODS));
            }
        }

        // O1 — shapes.
        String inputRef = Lifecycles.stringValue(op, ApiConstants.ATTR_INPUT_REF);
        if (inputRef != null) {
            MetaData input = Lifecycles.resolveObjectOn(op, inputRef);
            if (input == null || !MetaObject.SUBTYPE_VALUE.equals(input.getSubType())) {
                sink.add(op, ErrorCode.ERR_OPERATION_SHAPE,
                    head + " @inputRef \"" + inputRef + "\" " + objectKind(input) + "; an operation's input is an object.value.");
                return;
            }
        }
        String outputRef = Lifecycles.stringValue(op, ApiConstants.ATTR_OUTPUT_REF);
        if (outputRef != null) {
            MetaData output = Lifecycles.resolveObjectOn(op, outputRef);
            boolean legal = output != null && Arrays.asList(MetaObject.SUBTYPE_ENTITY, MetaObject.SUBTYPE_PROJECTION,
                MetaObject.SUBTYPE_VALUE).contains(output.getSubType());
            if (!legal) {
                sink.add(op, ErrorCode.ERR_OPERATION_SHAPE,
                    head + " @outputRef \"" + outputRef + "\" " + objectKind(output)
                        + "; an operation returns an object.entity, object.projection or object.value.");
                return;
            }
        }

        // O2, O3 — the target.
        Lifecycles.DerivedTarget derivedTarget = Lifecycles.deriveOperationTarget(op);
        MetaData derived = derivedTarget == null ? null : derivedTarget.entity();
        MetaData target = derived;
        String objectRef = Lifecycles.stringValue(op, ApiConstants.ATTR_OBJECT_REF);
        if (objectRef != null) {
            MetaData declared = Lifecycles.resolveObjectOn(op, objectRef);
            if (declared == null || !MetaObject.SUBTYPE_ENTITY.equals(declared.getSubType())) {
                sink.add(op, ErrorCode.ERR_OPERATION_TARGET_UNRESOLVED,
                    head + " @objectRef \"" + objectRef + "\" " + objectKind(declared) + "; an operation acts on an object.entity.");
                return;
            }
            if (derived != null && derived != declared) {
                sink.add(op, ErrorCode.ERR_OPERATION_TARGET_MISMATCH,
                    head + " @objectRef names \"" + declared.getShortName() + "\", but its input and output derive \""
                        + derived.getShortName() + "\"; remove @objectRef or make them agree.");
                return;
            }
            target = declared;
        }
        List<String> transitions = ApiConstants.OPERATION_SUBTYPE_COMMAND.equals(op.getSubType())
            ? Lifecycles.stringList(op, ApiConstants.ATTR_TRANSITIONS) : Collections.emptyList();
        if (!transitions.isEmpty() && target == null) {
            sink.add(op, ErrorCode.ERR_OPERATION_TARGET_UNRESOLVED,
                "operation.command \"" + label(op) + "\" lists @transitions but has no target entity: the @inputRef does not borrow one entity's whole primary key (each key field extended exactly once), no @outputRef has a base entity, and there is no @objectRef.");
            return;
        }

        // O4 — the transitions it may make.
        if (target != null && !transitions.isEmpty()) {
            Set<String> known = new LinkedHashSet<>();
            for (MetaData t : Lifecycles.entityTransitions(target)) known.add(t.getShortName());
            List<String> unknown = new ArrayList<>();
            for (String n : new LinkedHashSet<>(transitions)) if (!known.contains(n)) unknown.add(n);
            if (!unknown.isEmpty()) {
                sink.add(op, ErrorCode.ERR_OPERATION_UNKNOWN_TRANSITION,
                    "operation.command \"" + label(op) + "\" @transitions names " + quoteList(unknown) + ", which "
                        + (unknown.size() == 1 ? "is not a transition" : "are not transitions") + " of \"" + target.getShortName() + "\".");
            }
        }

        // B1 — binding paths.
        // ADR-0039: own — a binding is checked on the operation that declares it.
        for (MetaData b : op.getChildren(MetaData.class, false)) {
            if (!ApiConstants.TYPE_BINDING.equals(b.getType()) || !ApiConstants.BINDING_SUBTYPE_REST.equals(b.getSubType())) continue;
            String path = Lifecycles.stringValue(b, ApiConstants.ATTR_PATH);
            if (path == null) continue;
            List<String> placeholders = new ArrayList<>();
            Matcher m = PLACEHOLDER.matcher(path);
            while (m.find()) placeholders.add(m.group(1));
            List<String> expected = target != null && Lifecycles.operationIsKeyed(op)
                ? Lifecycles.primaryKeyFields(target) : new ArrayList<>();
            List<String> a = new ArrayList<>(placeholders);
            List<String> e = new ArrayList<>(expected);
            Collections.sort(a);
            Collections.sort(e);
            if (!a.equals(e)) {
                sink.add(b, ErrorCode.ERR_BINDING_PATH_MISMATCH,
                    "binding.rest on \"" + label(b) + "\" @path \"" + path + "\" has placeholders [" + quoteList(placeholders) + "]; "
                        + (expected.isEmpty()
                            ? "\"" + label(op) + "\" addresses no row by key, so its path takes none."
                            : "\"" + label(op) + "\" addresses one \"" + target.getShortName()
                                + "\" by key, so its path takes exactly [" + quoteList(expected) + "]."));
            }
        }
    }

    /** ADR-0066 — the rules pass. Runs after reference-bearing validation. */
    static List<MetaDataException> validate(MetaRoot root) {
        Sink sink = new Sink();
        for (MetaData field : declaredFields(root)) checkDeclaredTransitions(field, sink);
        for (MetaData obj : root.getChildren(MetaData.class, true)) {
            if (Lifecycles.isEntity(obj)) checkEntityLifecycles(obj, sink);
        }
        // O6 — keyed by package, then by the name without case.
        Map<String, MetaData> byName = new java.util.HashMap<>();
        for (MetaData api : root.getChildren(MetaData.class, true)) {
            if (!ApiConstants.TYPE_API.equals(api.getType())) continue;
            List<MetaData> ops = new ArrayList<>();
            for (MetaData op : api.getChildren(MetaData.class, true)) {
                if (ApiConstants.TYPE_OPERATION.equals(op.getType())) ops.add(op);
            }
            for (MetaData op : ops) checkOperation(op, sink);
            for (MetaData op : ops) {
                String pkg = References.effectivePackageOf(api);
                String key = pkg + "\u0000" + op.getShortName().toLowerCase(java.util.Locale.ROOT);
                MetaData first = byName.putIfAbsent(key, op);
                if (first != null && first != op && !sameOperation(first, op)) {
                    sink.add(op, ErrorCode.ERR_TRANSITION_NAME_COLLISION,
                        "operation." + op.getSubType() + " \"" + label(op) + "\" has the same name as \"" + label(first)
                            + "\" (names are compared without case) and is not the same operation; the operations of package \"" + pkg
                            + "\" share one namespace (each derives the permission name <package>.<operation>), so rename one, or declare both identically to expose one operation in two APIs.");
                }
            }
            checkApiRoutes(ops, sink);
        }
        return sink.errors;
    }

    /** A reference attr's identity: the node it resolves to, else the raw value. */
    private static Object refIdentity(MetaData op, String attr) {
        String ref = Lifecycles.stringValue(op, attr);
        if (ref == null) return null;
        MetaData node = Lifecycles.resolveObjectOn(op, ref);
        return node != null ? node : ref;
    }

    /** A list attr as a set, for comparison. */
    private static Set<String> setKey(MetaData op, String attr) {
        return new java.util.TreeSet<>(Lifecycles.stringList(op, attr));
    }

    private static boolean flag(MetaData op, String attr) {
        return op.hasMetaAttr(attr) && Boolean.TRUE.equals(op.getMetaAttr(attr).getValue());
    }

    /**
     * Whether two operations of one package in different APIs are one operation exposed twice (a
     * versioned API beside its successor, ADR-0067 section 2): same name and subtype and the same
     * contract. Bindings are per API and are not compared.
     */
    private static boolean sameOperation(MetaData a, MetaData b) {
        if (!a.getShortName().equals(b.getShortName()) || !a.getSubType().equals(b.getSubType())) return false;
        for (String attr : List.of(ApiConstants.ATTR_INPUT_REF, ApiConstants.ATTR_OUTPUT_REF, ApiConstants.ATTR_OBJECT_REF)) {
            Object x = refIdentity(a, attr);
            Object y = refIdentity(b, attr);
            // A resolved node compares by identity, a raw string by value.
            boolean same = x instanceof String xs ? xs.equals(y) : x == y;
            if (!same) return false;
        }
        for (String attr : List.of(ApiConstants.ATTR_TRANSITIONS, ApiConstants.ATTR_ERRORS)) {
            if (!setKey(a, attr).equals(setKey(b, attr))) return false;
        }
        return java.util.Objects.equals(Lifecycles.stringValue(a, ApiConstants.ATTR_PERMISSION),
                Lifecycles.stringValue(b, ApiConstants.ATTR_PERMISSION))
            && flag(a, ApiConstants.ATTR_PUBLIC) == flag(b, ApiConstants.ATTR_PUBLIC)
            && flag(a, ApiConstants.ATTR_MANY) == flag(b, ApiConstants.ATTR_MANY);
    }

    /** B2 across the operations of one API. */
    private static void checkApiRoutes(List<MetaData> ops, Sink sink) {
        Map<String, MetaData> byRoute = new java.util.HashMap<>();
        for (MetaData op : ops) {
            // ADR-0039: own — a binding is checked on the operation that declares it.
            for (MetaData b : op.getChildren(MetaData.class, false)) {
                if (!ApiConstants.TYPE_BINDING.equals(b.getType()) || !ApiConstants.BINDING_SUBTYPE_REST.equals(b.getSubType())) continue;
                String path = Lifecycles.stringValue(b, ApiConstants.ATTR_PATH);
                if (path == null) continue;
                // The effective method: the declared one, else the derived (ADR-0066 section 1).
                String declared = Lifecycles.stringValue(b, ApiConstants.ATTR_METHOD);
                String method = declared != null ? declared
                    : ApiConstants.OPERATION_SUBTYPE_COMMAND.equals(op.getSubType()) ? "POST" : "GET";
                String route = method + " " + PLACEHOLDER.matcher(path).replaceAll("{}");
                MetaData other = byRoute.putIfAbsent(route, b);
                if (other != null) {
                    sink.add(b, ErrorCode.ERR_BINDING_PATH_MISMATCH,
                        "binding.rest on \"" + label(b) + "\" declares " + method + " \"" + path
                            + "\", the same route as the binding on \"" + label(other)
                            + "\"; two operations cannot share a method and path.");
                }
            }
        }
    }
}

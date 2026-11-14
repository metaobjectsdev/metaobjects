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
package com.metaobjects.api;

import com.metaobjects.MetaData;
import com.metaobjects.field.EnumField;
import com.metaobjects.field.MetaField;
import com.metaobjects.identity.MetaIdentity;
import com.metaobjects.loader.References;
import com.metaobjects.object.MetaObject;
import com.metaobjects.transition.TransitionConstants;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Lifecycle and operation-target derivation (ADR-0063), shared by the loader's rules pass
 * and the {@code verify} rules gate. Everything here is DERIVED: a lifecycle, its states,
 * its initial and terminal states and an operation's target entity have no vocabulary of
 * their own. Mirrors the TypeScript {@code core/transition/lifecycle.ts}.
 *
 * <p>Reads are RESOLVING (ADR-0039): a transition declared on a base entity's field is a
 * transition of every entity that extends it.</p>
 */
public final class Lifecycles {

    private Lifecycles() {
    }

    /** One lifecycle of an entity: an enum field with at least one transition. */
    public record Lifecycle(MetaData field, List<String> states, String initial, List<MetaData> transitions) {
    }

    /** How an operation's target was derived: {@code viaInput} means the input borrows the target's key. */
    public record DerivedTarget(MetaData entity, boolean viaInput) {
    }

    /** A string-array attr read resolving; a bare string is ONE element. */
    public static List<String> stringList(MetaData node, String attr) {
        List<String> out = new ArrayList<>();
        if (!node.hasMetaAttr(attr)) return out;
        Object v = node.getMetaAttr(attr).getValue();
        if (v instanceof List<?> list) {
            for (Object item : list) if (item instanceof String s) out.add(s);
        } else if (v instanceof String s) {
            out.add(s);
        }
        return out;
    }

    /** A string attr read resolving, or {@code null}. */
    public static String stringValue(MetaData node, String attr) {
        if (!node.hasMetaAttr(attr)) return null;
        return node.getMetaAttr(attr).getValue() instanceof String s ? s : null;
    }

    /** True when the node's own {@code isAbstract} flag is set (abstractness is never inherited). */
    public static boolean isAbstract(MetaData node) {
        // ADR-0039: own — abstractness describes the declaration itself.
        return node.hasMetaAttr(MetaData.ATTR_IS_ABSTRACT, false)
            && Boolean.TRUE.equals(node.getMetaAttr(MetaData.ATTR_IS_ABSTRACT, false).getValue());
    }

    /**
     * Whether an entity's lifecycles are live: it declares or inherits a source (read resolving).
     * A lifecycle on an entity with no source loads and is inert (ADR-0063 section 2).
     */
    public static boolean lifecycleIsLive(MetaData entity) {
        for (MetaData c : entity.getChildren(MetaData.class, true)) {
            if (com.metaobjects.source.MetaSource.TYPE_SOURCE.equals(c.getType())) return true;
        }
        return false;
    }

    /** True for an {@code object.entity}. */
    public static boolean isEntity(MetaData node) {
        return node != null && MetaObject.TYPE_OBJECT.equals(node.getType())
            && MetaObject.SUBTYPE_ENTITY.equals(node.getSubType());
    }

    /** The {@code transition.action} children of a field, resolving. */
    public static List<MetaData> transitionsOf(MetaData field) {
        List<MetaData> out = new ArrayList<>();
        for (MetaData c : field.getChildren(MetaData.class, true)) {
            if (TransitionConstants.TYPE_TRANSITION.equals(c.getType())
                    && TransitionConstants.SUBTYPE_ACTION.equals(c.getSubType())) out.add(c);
        }
        return out;
    }

    /** An entity and every entity it extends, nearest first. */
    public static List<MetaData> entityLineage(MetaData entity) {
        List<MetaData> out = new ArrayList<>();
        for (MetaData e = entity; e != null && !containsIdentity(out, e); e = e.hasSuperData() ? e.getSuperData() : null) out.add(e);
        return out;
    }

    /** Identity membership: nodes are compared by reference, never by equals. */
    public static boolean containsIdentity(List<MetaData> list, MetaData node) {
        for (MetaData x : list) if (x == node) return true;
        return false;
    }

    /**
     * The transitions a field gives an entity: those declared on a field of the entity itself or of
     * an entity it extends. A transition reached only through the field's own {@code extends} of
     * another entity's field is not one (ADR-0063 section 2).
     */
    public static List<MetaData> lifecycleTransitionsOf(MetaData entity, MetaData field) {
        List<MetaData> lineage = entityLineage(entity);
        List<MetaData> out = new ArrayList<>();
        for (MetaData t : transitionsOf(field)) {
            MetaData owner = t.getParent() == null ? null : t.getParent().getParent();
            if (owner != null && containsIdentity(lineage, owner)) out.add(t);
        }
        return out;
    }

    /** The lifecycles of an object, in effective field order. Only an {@code object.entity} has any. */
    public static List<Lifecycle> lifecyclesOf(MetaData obj) {
        List<Lifecycle> out = new ArrayList<>();
        if (!isEntity(obj)) return out;
        for (MetaData field : obj.getChildren(MetaData.class, true)) {
            if (!MetaField.TYPE_FIELD.equals(field.getType()) || !EnumField.SUBTYPE_ENUM.equals(field.getSubType())) continue;
            List<MetaData> transitions = lifecycleTransitionsOf(obj, field);
            if (transitions.isEmpty()) continue;
            out.add(new Lifecycle(field, stringList(field, EnumField.ATTR_VALUES),
                stringValue(field, MetaField.ATTR_DEFAULT), transitions));
        }
        return out;
    }

    /** Every transition of an entity, across all its lifecycles. */
    public static List<MetaData> entityTransitions(MetaData obj) {
        List<MetaData> out = new ArrayList<>();
        for (Lifecycle l : lifecyclesOf(obj)) out.addAll(l.transitions());
        return out;
    }

    /** A transition's {@code @from} (resolving). */
    public static List<String> transitionFrom(MetaData t) {
        return stringList(t, TransitionConstants.ATTR_FROM);
    }

    /** A transition's {@code @to} (resolving), or {@code null}. */
    public static String transitionTo(MetaData t) {
        return stringValue(t, TransitionConstants.ATTR_TO);
    }

    /** The states reachable from the initial state, following every transition. */
    public static Set<String> reachableStates(Lifecycle l) {
        Set<String> seen = new HashSet<>();
        if (l.initial() == null) return seen;
        List<String> queue = new ArrayList<>();
        queue.add(l.initial());
        seen.add(l.initial());
        for (int i = 0; i < queue.size(); i++) {
            String s = queue.get(i);
            for (MetaData t : l.transitions()) {
                String to = transitionTo(t);
                if (to != null && transitionFrom(t).contains(s) && seen.add(to)) queue.add(to);
            }
        }
        return seen;
    }

    /** The members no transition leaves (a self-transition counts as leaving). */
    public static List<String> terminalStates(Lifecycle l) {
        Set<String> leaving = new HashSet<>();
        for (MetaData t : l.transitions()) leaving.addAll(transitionFrom(t));
        List<String> out = new ArrayList<>();
        for (String s : l.states()) if (!leaving.contains(s)) out.add(s);
        return out;
    }

    /** The primary key field names of an entity: its effective {@code identity.primary @fields}. */
    public static List<String> primaryKeyFields(MetaData entity) {
        for (MetaData c : entity.getChildren(MetaData.class, true)) {
            if (MetaIdentity.TYPE_IDENTITY.equals(c.getType()) && MetaIdentity.SUBTYPE_PRIMARY.equals(c.getSubType())) {
                return stringList(c, "fields");
            }
        }
        return new ArrayList<>();
    }

    /** The package a node's references resolve in: its top-level node's effective package. */
    public static String referrerPackageOf(MetaData node) {
        return References.effectivePackageOf(node);
    }

    /** Resolve an object reference written on {@code node} (owner part only); {@code null} when it names nothing. */
    public static MetaData resolveObjectOn(MetaData node, String ref) {
        MetaData root = References.topLevelRoot(node);
        if (root == null) return null;
        return References.resolveObjectRef(root, References.splitChildTail(ref).owner(), referrerPackageOf(node)).node();
    }

    private record Extended(MetaData owner, String member) {
    }

    /**
     * The object a field's {@code extends} NAMES, and the member it names there. {@code id extends
     * PurchaseRequest.id} names PurchaseRequest even when PurchaseRequest inherits {@code id}
     * from an abstract base, which is where the resolved super node physically lives.
     */
    private static Extended extendedMember(MetaData f) {
        String ref = f.getAuthoredSuperRef();
        MetaData sup = f.hasSuperData() ? f.getSuperData() : null;
        if (ref == null || sup == null) return null;
        int lastSep = ref.lastIndexOf(MetaData.PKG_SEPARATOR);
        int segStart = lastSep == -1 ? 0 : lastSep + MetaData.PKG_SEPARATOR.length();
        int dot = ref.indexOf('.', segStart);
        if (dot > segStart) {
            MetaData root = References.topLevelRoot(f);
            if (root != null) {
                MetaData named = References.resolveObjectRef(root, ref.substring(0, dot), referrerPackageOf(f)).node();
                if (named != null) return new Extended(named, sup.getShortName());
            }
        }
        MetaData parent = sup.getParent();
        return parent != null && MetaObject.TYPE_OBJECT.equals(parent.getType())
            ? new Extended(parent, sup.getShortName()) : null;
    }

    /**
     * The entities whose whole primary key a value object borrows, once: every primary key field of
     * the entity is extended by exactly one field of the value. Part of a composite key, or one key
     * field borrowed twice, borrows nothing from it.
     */
    private static List<MetaData> borrowedKeyEntities(MetaData value) {
        List<MetaData> owners = new ArrayList<>();
        List<Map<String, Integer>> counts = new ArrayList<>();
        for (MetaData f : value.getChildren(MetaData.class, true)) {
            if (!MetaField.TYPE_FIELD.equals(f.getType())) continue;
            Extended ext = extendedMember(f);
            if (ext == null || !isEntity(ext.owner())) continue;
            if (!primaryKeyFields(ext.owner()).contains(ext.member())) continue;
            int i = -1;
            for (int k = 0; k < owners.size(); k++) if (owners.get(k) == ext.owner()) i = k;
            if (i < 0) {
                owners.add(ext.owner());
                counts.add(new java.util.HashMap<>());
                i = owners.size() - 1;
            }
            counts.get(i).merge(ext.member(), 1, Integer::sum);
        }
        List<MetaData> out = new ArrayList<>();
        for (int i = 0; i < owners.size(); i++) {
            boolean whole = true;
            for (String k : primaryKeyFields(owners.get(i))) if (!Integer.valueOf(1).equals(counts.get(i).get(k))) whole = false;
            if (whole) out.add(owners.get(i));
        }
        return out;
    }

    /**
     * The base entity of a projection: the entity its extended identity names, else the one
     * entity its extended fields name. {@code null} when there is none or more than one.
     */
    public static MetaData projectionBaseEntity(MetaData projection) {
        for (MetaData id : projection.getChildren(MetaData.class, true)) {
            if (!MetaIdentity.TYPE_IDENTITY.equals(id.getType())) continue;
            Extended ext = extendedMember(id);
            if (ext != null && isEntity(ext.owner())) return ext.owner();
        }
        List<MetaData> owners = new ArrayList<>();
        for (MetaData f : projection.getChildren(MetaData.class, true)) {
            if (!MetaField.TYPE_FIELD.equals(f.getType())) continue;
            Extended ext = extendedMember(f);
            if (ext != null && isEntity(ext.owner()) && !owners.contains(ext.owner())) owners.add(ext.owner());
        }
        return owners.size() == 1 ? owners.get(0) : null;
    }

    /**
     * The target entity derived from an operation's shapes, or {@code null}: the one entity whose
     * whole primary key the {@code @inputRef} value borrows (each key field once); else the {@code @outputRef}
     * (an entity is its own target, a projection its base entity).
     */
    public static DerivedTarget deriveOperationTarget(MetaData op) {
        String inputRef = stringValue(op, ApiConstants.ATTR_INPUT_REF);
        if (inputRef != null) {
            MetaData input = resolveObjectOn(op, inputRef);
            if (input != null && MetaObject.SUBTYPE_VALUE.equals(input.getSubType())) {
                List<MetaData> borrowed = borrowedKeyEntities(input);
                if (borrowed.size() == 1) return new DerivedTarget(borrowed.get(0), true);
            }
        }
        String outputRef = stringValue(op, ApiConstants.ATTR_OUTPUT_REF);
        if (outputRef != null) {
            MetaData output = resolveObjectOn(op, outputRef);
            if (output != null && MetaObject.SUBTYPE_ENTITY.equals(output.getSubType())) return new DerivedTarget(output, false);
            if (output != null && MetaObject.SUBTYPE_PROJECTION.equals(output.getSubType())) {
                MetaData base = projectionBaseEntity(output);
                if (base != null) return new DerivedTarget(base, false);
            }
        }
        return null;
    }

    /** The operation's target: the declared {@code @objectRef} when it names an entity, else the derived one. */
    public static MetaData operationTarget(MetaData op) {
        String declared = stringValue(op, ApiConstants.ATTR_OBJECT_REF);
        if (declared != null) {
            MetaData node = resolveObjectOn(op, declared);
            return isEntity(node) ? node : null;
        }
        DerivedTarget d = deriveOperationTarget(op);
        return d == null ? null : d.entity();
    }

    /**
     * Whether the operation addresses one row of its target by key: its input borrows the
     * target's key, or it is a query with no input and no {@code @many} whose target comes from
     * its output (a get by key).
     */
    public static boolean operationIsKeyed(MetaData op) {
        DerivedTarget derived = deriveOperationTarget(op);
        if (derived == null) return false;
        if (derived.viaInput()) return true;
        return ApiConstants.OPERATION_SUBTYPE_QUERY.equals(op.getSubType())
            && stringValue(op, ApiConstants.ATTR_INPUT_REF) == null
            && !Boolean.TRUE.equals(op.hasMetaAttr(ApiConstants.ATTR_MANY) ? op.getMetaAttr(ApiConstants.ATTR_MANY).getValue() : null);
    }
}

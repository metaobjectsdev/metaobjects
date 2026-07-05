/*
 * Copyright 2003 Doug Mealing LLC dba Meta Objects
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
package com.metaobjects.relationship;

import com.metaobjects.MetaData;
import com.metaobjects.MetaRoot;
import com.metaobjects.identity.MetaIdentity;
import com.metaobjects.object.MetaObject;

import java.util.ArrayList;
import java.util.List;

/**
 * M:N junction FK derivation — the single source of truth for which junction
 * columns are the SOURCE side and the TARGET side of a many-to-many relationship.
 *
 * <p>Java port of the TS reference {@code derive-m2m-fields.ts}. A M:N relationship
 * ({@code @cardinality: "many"}, {@code @objectRef: <target>}, {@code @through: <junction>})
 * does NOT restate its FK columns. They are derived from the junction entity's two
 * {@code identity.reference} children — one resolving to the source entity, one to the
 * target — exactly as 1:N FK direction is declared.</p>
 *
 * <p>Three modes (see the FR-017 design):</p>
 * <ol>
 *   <li><b>Hetero</b> (source != target): the reference resolving to the source entity
 *       gives {@code sourceField}; the one resolving to the target gives {@code targetField}.</li>
 *   <li><b>Directed self-join</b> (source == target, {@code @sourceRefField} set): both
 *       references resolve to the same entity, so {@code @sourceRefField} names the
 *       source-side FK field; the OTHER reference is the target side.</li>
 *   <li><b>Symmetric self-join</b> (source == target, {@code @symmetric: true}): undirected;
 *       the two references are taken in declaration order ({@code sourceField} = first,
 *       {@code targetField} = second). Resolution unions both at read time.</li>
 * </ol>
 * Ambiguous (source == target, neither {@code @sourceRefField} nor {@code @symmetric}) → throw.
 *
 * <p>This carries the same semantics as the loader-phase M:N validation
 * ({@code ValidationPhase.validateRelationshipsM2M}); the validation pass guarantees a
 * well-formed junction (exactly two references, matching {@code @sourceRefField}) before
 * a downstream consumer (runtime resolver / codegen) calls {@link #derive}.</p>
 */
public final class M2MFields {

    /** The junction FK field holding the source-entity key. */
    public final String sourceField;
    /** The junction FK field holding the target-entity key. */
    public final String targetField;

    private M2MFields(String sourceField, String targetField) {
        this.sourceField = sourceField;
        this.targetField = targetField;
    }

    public String getSourceField() {
        return sourceField;
    }

    public String getTargetField() {
        return targetField;
    }

    /** Thrown when a M:N relationship's junction FK fields cannot be derived. */
    public static final class M2MDerivationException extends RuntimeException {
        public M2MDerivationException(String message) {
            super(message);
        }
    }

    /**
     * Derive the source/target junction FK fields for a M:N relationship.
     *
     * @param rel    the M:N relationship (carries {@code @objectRef} + {@code @through}
     *               + optional {@code @sourceRefField} / {@code @symmetric})
     * @param source the entity declaring {@code rel}
     * @param root   the loaded model root (to find the junction entity)
     * @return the derived source/target junction FK fields
     * @throws M2MDerivationException when the junction is missing/malformed or the
     *         self-join is ambiguous.
     */
    public static M2MFields derive(MetaRelationship rel, MetaObject source, MetaRoot root) {
        String throughName = rel.getThrough();
        if (throughName == null || throughName.isEmpty()) {
            throw new M2MDerivationException(
                "relationship \"" + source.getShortName() + "." + rel.getShortName()
                    + "\" is missing @through (required for M:N derivation)");
        }
        MetaObject junction = findObject(root, throughName);
        if (junction == null) {
            throw new M2MDerivationException(
                "relationship \"" + source.getShortName() + "." + rel.getShortName()
                    + "\" @through \"" + throughName + "\" does not resolve to an entity");
        }

        String targetName = rel.getObjectRef();
        if (targetName == null || targetName.isEmpty()) {
            throw new M2MDerivationException(
                "relationship \"" + source.getShortName() + "." + rel.getShortName()
                    + "\" is missing @objectRef (the M:N target)");
        }
        MetaObject target = findObject(root, targetName);

        List<MetaIdentity> refs = referenceIdentities(junction);
        if (refs.size() != 2) {
            throw new M2MDerivationException(
                "junction \"" + throughName + "\" for relationship \"" + source.getShortName()
                    + "." + rel.getShortName() + "\" must declare exactly two"
                    + " identity.reference children (found " + refs.size() + ")");
        }

        // ADR-0041: classify the self-join by RESOLVED object identity (FQN-exact),
        // never a stripped bare tail. A cross-package hetero M:N whose target shares
        // a bare name with the source (or an unrelated entity) must NOT be mis-read
        // as a self-join, and an FQN @objectRef must bind the correct package. Falls
        // back to a bare-name compare only when @objectRef is unresolvable (defensive
        // — loader validation normally guarantees resolution before derive runs).
        boolean isSelfJoin = (target != null)
            ? target.getName().equals(source.getName())
            : stripPackage(targetName).equals(source.getShortName());

        if (!isSelfJoin) {
            // Hetero: match each reference by the ENTITY OBJECT its @references
            // resolves to (FQN-exact), so a same-bare-name cross-package reference
            // binds the correct package rather than the first bare-tail match.
            MetaIdentity sourceRef = findRefToObject(root, refs, source);
            MetaIdentity targetRef = findRefToObject(root, refs, target);
            String sourceField = sourceRef != null ? refFkField(sourceRef) : null;
            String targetField = targetRef != null ? refFkField(targetRef) : null;
            if (sourceField == null || targetField == null) {
                throw new M2MDerivationException(
                    "junction \"" + throughName + "\" for relationship \"" + source.getShortName()
                        + "." + rel.getShortName() + "\" must declare one identity.reference to \""
                        + source.getShortName() + "\" and one to \"" + stripPackage(targetName) + "\"");
            }
            return new M2MFields(sourceField, targetField);
        }

        // Self-join: both references resolve to the same entity.
        if (rel.isSymmetric()) {
            // Undirected: take references in declaration order; union happens at read time.
            String a = refFkField(refs.get(0));
            String b = refFkField(refs.get(1));
            if (a == null || b == null) {
                throw new M2MDerivationException(
                    "symmetric junction \"" + throughName + "\" for \"" + source.getShortName()
                        + "." + rel.getShortName() + "\" has a reference with no @fields");
            }
            return new M2MFields(a, b);
        }

        String sourceRefField = rel.getSourceRefField();
        if (sourceRefField == null || sourceRefField.isEmpty()) {
            throw new M2MDerivationException(
                "self-join relationship \"" + source.getShortName() + "." + rel.getShortName()
                    + "\" through \"" + throughName + "\" is ambiguous: set @sourceRefField"
                    + " (directed) or @symmetric (undirected)");
        }

        // Directed self-join: @sourceRefField names the source-side FK; the other ref is the target.
        MetaIdentity sourceRef = null;
        for (MetaIdentity ref : refs) {
            if (sourceRefField.equals(refFkField(ref))) {
                sourceRef = ref;
                break;
            }
        }
        if (sourceRef == null) {
            throw new M2MDerivationException(
                "@sourceRefField \"" + sourceRefField + "\" on \"" + source.getShortName() + "."
                    + rel.getShortName() + "\" does not match any identity.reference FK field on"
                    + " junction \"" + throughName + "\"");
        }
        String targetField = null;
        for (MetaIdentity ref : refs) {
            if (ref != sourceRef) {
                targetField = refFkField(ref);
                break;
            }
        }
        if (targetField == null) {
            throw new M2MDerivationException(
                "junction \"" + throughName + "\" for \"" + source.getShortName() + "."
                    + rel.getShortName() + "\" has no distinct target-side reference");
        }
        return new M2MFields(sourceRefField, targetField);
    }

    // --- helpers -----------------------------------------------------------

    /**
     * A junction's {@code identity.reference} children, in declaration order.
     * ADR-0039: identities are inheritable — a junction may inherit an
     * {@code identity.reference} via extends. RESOLVE via getIdentities() (the
     * no-arg form defaults includeParentData=true), matching the TS reference's
     * {@code junction.referenceIdentities()} which builds on the resolving
     * {@code identities()}. Own-only would drop an inherited reference and
     * mis-derive the M:N FK direction.
     */
    private static List<MetaIdentity> referenceIdentities(MetaObject junction) {
        List<MetaIdentity> out = new ArrayList<>();
        for (MetaIdentity child : junction.getIdentities()) {
            if (MetaIdentity.SUBTYPE_REFERENCE.equals(child.getSubType())) {
                out.add(child);
            }
        }
        return out;
    }

    /** First {@code @fields} entry of a reference (the physical FK column on the junction). */
    private static String refFkField(MetaIdentity ref) {
        List<String> fields = ref.getFields();
        return fields.isEmpty() ? null : fields.get(0);
    }

    /**
     * The entity object a reference's {@code @references} resolves to (FQN-exact),
     * or {@code null}. ADR-0041: resolve to an actual object and compare identity —
     * a bare-tail string compare mis-binds a same-named cross-package target.
     */
    private static MetaObject refTargetObject(MetaRoot root, MetaIdentity ref) {
        // ADR-0039: @references is an inheritable effective identity attr — RESOLVE
        // (default includeParentData=true); own-only would miss an inherited target.
        if (!ref.hasMetaAttr(MetaIdentity.ATTR_REFERENCES)) return null;
        String v = ref.getMetaAttr(MetaIdentity.ATTR_REFERENCES).getValueAsString();
        if (v == null || v.isEmpty()) return null;
        // @references may carry a dotted Entity.field form — the entity is the head
        // segment (packages use "::", never ".", so the first "." splits it off).
        int dot = v.indexOf('.');
        String entity = dot >= 0 ? v.substring(0, dot) : v;
        return findObject(root, entity);
    }

    /**
     * The reference whose {@code @references} resolves to {@code entity} (compared by
     * FQN identity), or {@code null}. ADR-0041: identity compare, never a stripped
     * bare tail — two junction references to same-bare-name entities in different
     * packages must be distinguished by their full package-qualified name.
     */
    private static MetaIdentity findRefToObject(MetaRoot root, List<MetaIdentity> refs, MetaObject entity) {
        if (entity == null) return null;
        for (MetaIdentity ref : refs) {
            MetaObject t = refTargetObject(root, ref);
            if (t != null && t.getName().equals(entity.getName())) return ref;
        }
        return null;
    }

    private static MetaObject findObject(MetaRoot root, String name) {
        if (name == null) return null;
        // ADR-0041: a FULLY-QUALIFIED ref (contains "::") resolves EXACTLY on the
        // object's package-qualified name — never a bare-tail fallback (the closed
        // bug: an FQN @objectRef / @through binding a same-named object in the WRONG
        // package). A bare ref matches the object's short name (first match wins; the
        // same-package preference for a bare collision is the deferred follow-up,
        // issue #174, mirroring SpringM2mSupport.findEntity and the TS residual note).
        boolean fqn = name.contains(MetaData.PKG_SEPARATOR);
        // ADR-0039: root-level scan — root is never extended, so own children is correct.
        for (MetaData child : root.getChildren(MetaData.class, false)) {
            if (child instanceof MetaObject) {
                MetaObject mo = (MetaObject) child;
                if (fqn ? name.equals(mo.getName()) : stripPackage(name).equals(mo.getShortName())) {
                    return mo;
                }
            }
        }
        return null;
    }

    private static String stripPackage(String name) {
        if (name == null) return null;
        int idx = name.lastIndexOf(MetaData.PKG_SEPARATOR);
        return (idx >= 0) ? name.substring(idx + MetaData.PKG_SEPARATOR.length()) : name;
    }
}

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
import com.metaobjects.validation.SymbolTable;

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
 * <p>"source" above means the relationship's SUBJECT, and under {@code extends} there are
 * two legitimate names for it. Every caller walks the RESOLVING {@code getRelationships()}
 * (SpringM2mSupport and KotlinM2mSupport for codegen, omdb's M2MResolver at run time) and
 * passes the entity it is ITERATING, which for an inherited relationship is not the one
 * that declared it. So the DECLARING entity is resolved here from {@code rel.getParent()}
 * (same shape as the #368 loader fix in {@code ValidationPhase}), and the passed
 * {@code source} is kept alongside it rather than discarded: a junction FK usually
 * references the CONCRETE entity, because the abstract base has no table, while
 * {@code @objectRef} on an inherited self-join names the base. Both are accepted, for the
 * self-join classification and the hetero reference match alike. {@code source} is also the
 * fallback when {@code rel} has no entity parent, which keeps the signature unchanged. Not
 * covered: a junction reference naming an entity strictly BETWEEN the base and the
 * navigating entity in a deeper hierarchy.</p>
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
     * @param source the entity the caller is navigating from. Accepted alongside
     *               {@code rel.getParent()} as a name for the relationship's subject,
     *               and used as the declaring entity when {@code rel} has no parent
     * @param root   the loaded model root (to find the junction entity)
     * @return the derived source/target junction FK fields
     * @throws M2MDerivationException when the junction is missing/malformed or the
     *         self-join is ambiguous.
     */
    public static M2MFields derive(MetaRelationship rel, MetaObject source, MetaRoot root) {
        // The entity that DECLARES `rel` — see the class note. getParent() is the
        // owning entity for both an own declaration and an inherited one (an
        // unmodified inherited child is the SAME node object; an override is a
        // different node whose parent is the overriding entity, also correct).
        MetaData relParent = rel.getParent();
        MetaObject declaring = (relParent instanceof MetaObject) ? (MetaObject) relParent : source;

        // ADR-0041/0042 — resolve @through / @objectRef through the SAME package-local
        // matcher the loader's M:N validation rule uses for @through
        // (ValidationPhase.resolveRootObject: an FQN resolves exactly on its resolution
        // key, a bare name resolves in the REFERRER's package). Both here delegate to
        // SymbolTable — the loader's own reusable ADR-0042 resolver (RegisteredValidation
        // already builds one per load) — so the loader and this derivation read the
        // identical resolution and cannot silently disagree about which junction/target a
        // bare name binds to.
        //
        // This used to be a root.getChildren() scan matching a bare name against the
        // FIRST same-short-name object found (issue #174), which took whichever entity
        // loaded first rather than the one in the referrer's own package — the same class
        // of defect the TS reference closed in findEntity/junction resolution.
        SymbolTable symbols = SymbolTable.build(root);
        String referrerPkg = declaring.getPackage() == null ? "" : declaring.getPackage();

        String throughName = rel.getThrough();
        if (throughName == null || throughName.isEmpty()) {
            throw new M2MDerivationException(
                "relationship \"" + declaring.getShortName() + "." + rel.getShortName()
                    + "\" is missing @through (required for M:N derivation)");
        }
        MetaObject junction = findObject(symbols, throughName, referrerPkg);
        if (junction == null) {
            throw new M2MDerivationException(
                "relationship \"" + declaring.getShortName() + "." + rel.getShortName()
                    + "\" @through \"" + throughName + "\" does not resolve to an entity");
        }

        String targetName = rel.getObjectRef();
        if (targetName == null || targetName.isEmpty()) {
            throw new M2MDerivationException(
                "relationship \"" + declaring.getShortName() + "." + rel.getShortName()
                    + "\" is missing @objectRef (the M:N target)");
        }
        MetaObject target = findObject(symbols, targetName, referrerPkg);

        List<MetaIdentity> refs = referenceIdentities(junction);
        if (refs.size() != 2) {
            throw new M2MDerivationException(
                "junction \"" + throughName + "\" for relationship \"" + declaring.getShortName()
                    + "." + rel.getShortName() + "\" must declare exactly two"
                    + " identity.reference children (found " + refs.size() + ")");
        }

        // The relationship's SUBJECT — the entity the M:N hangs off. Under `extends`
        // there are two legitimate names for it and BOTH occur in real models: the
        // DECLARING entity (what @objectRef names for a self-join declared on an
        // abstract base, and what a junction reference names when the FK points at
        // the base type), and the NAVIGATING entity (`source`, the concrete entity
        // the caller is iterating — usually what a junction FK references, because
        // that is the entity with the physical table). Accepting either is what
        // makes derivation independent of which entity's effective view reached the
        // relationship. Not covered: a junction reference naming an entity strictly
        // BETWEEN the base and the navigating entity in a deeper hierarchy.
        //
        // ADR-0041: classify by RESOLVED object identity (FQN-exact), never a
        // stripped bare tail. A cross-package hetero M:N whose target shares a bare
        // name with the subject must NOT be mis-read as a self-join, and an FQN
        // @objectRef must bind the correct package. Falls back to a bare-name
        // compare only when @objectRef is unresolvable (defensive — loader
        // validation normally guarantees resolution before derive runs).
        boolean isSelfJoin = (target != null)
            ? isSubject(target, declaring, source)
            : (stripPackage(targetName).equals(declaring.getShortName())
                || stripPackage(targetName).equals(source.getShortName()));

        if (!isSelfJoin) {
            // Hetero: match each reference by the ENTITY OBJECT its @references
            // resolves to (FQN-exact), so a same-bare-name cross-package reference
            // binds the correct package rather than the first bare-tail match.
            // The junction OWNS its references' @references names, so those resolve
            // in the JUNCTION's package — the relationship's own @through/@objectRef
            // resolve in the DECLARING entity's. Under `extends` across packages
            // these differ; using declaring's package for both is what bound a bare
            // @references to the wrong same-named entity.
            String junctionPkg = junction.getPackage() == null ? "" : junction.getPackage();
            MetaIdentity sourceRef = findRefToSubject(symbols, junctionPkg, refs, declaring, source);
            MetaIdentity targetRef = findRefToObject(symbols, junctionPkg, refs, target);
            String sourceField = sourceRef != null ? refFkField(sourceRef) : null;
            String targetField = targetRef != null ? refFkField(targetRef) : null;
            if (sourceField == null || targetField == null) {
                String subjectLabel = declaring.getName().equals(source.getName())
                    ? "\"" + declaring.getShortName() + "\""
                    : "\"" + declaring.getShortName() + "\" or \"" + source.getShortName() + "\"";
                throw new M2MDerivationException(
                    "junction \"" + throughName + "\" for relationship \"" + declaring.getShortName()
                        + "." + rel.getShortName() + "\" must declare one identity.reference to "
                        + subjectLabel + " and one to \"" + stripPackage(targetName) + "\"");
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
                    "symmetric junction \"" + throughName + "\" for \"" + declaring.getShortName()
                        + "." + rel.getShortName() + "\" has a reference with no @fields");
            }
            return new M2MFields(a, b);
        }

        String sourceRefField = rel.getSourceRefField();
        if (sourceRefField == null || sourceRefField.isEmpty()) {
            throw new M2MDerivationException(
                "self-join relationship \"" + declaring.getShortName() + "." + rel.getShortName()
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
                "@sourceRefField \"" + sourceRefField + "\" on \"" + declaring.getShortName() + "."
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
                "junction \"" + throughName + "\" for \"" + declaring.getShortName() + "."
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

    // refFkField / stripPackage moved to the package-private ReferenceFkUtil (fix
    // round 1, finding 5) — they were byte-for-byte duplicates of
    // RelationshipReferences' own private copies, and both classes live in this
    // same package.
    private static String refFkField(MetaIdentity ref) {
        return ReferenceFkUtil.refFkField(ref);
    }

    /**
     * The entity object a reference's {@code @references} resolves to, or {@code null}.
     * ADR-0041/0042: resolve through the SAME package-local {@link SymbolTable} matcher
     * as the junction/target lookups in {@link #derive} — an FQN resolves exactly on its
     * resolution key, a bare name resolves in the REFERRER's package ({@code referrerPkg},
     * the JUNCTION's package — see the call site in {@link #derive}).
     */
    private static MetaObject refTargetObject(SymbolTable symbols, String referrerPkg, MetaIdentity ref) {
        // ADR-0039: @references is an inheritable effective identity attr — RESOLVE
        // (default includeParentData=true); own-only would miss an inherited target.
        if (!ref.hasMetaAttr(MetaIdentity.ATTR_REFERENCES)) return null;
        String v = ref.getMetaAttr(MetaIdentity.ATTR_REFERENCES).getValueAsString();
        if (v == null || v.isEmpty()) return null;
        // @references may carry a dotted Entity.field form — the entity is the head
        // segment (packages use "::", never ".", so the first "." splits it off).
        int dot = v.indexOf('.');
        String entity = dot >= 0 ? v.substring(0, dot) : v;
        return findObject(symbols, entity, referrerPkg);
    }

    /**
     * True when {@code candidate} is one of the relationship's SUBJECT entities —
     * the declaring entity or the entity the caller is navigating from. Compared by
     * package-qualified name (ADR-0041 identity), never a bare tail.
     */
    private static boolean isSubject(MetaObject candidate, MetaObject declaring, MetaObject source) {
        if (candidate == null) return false;
        return candidate.getName().equals(declaring.getName())
            || candidate.getName().equals(source.getName());
    }

    /** The junction reference resolving to either subject entity, or {@code null}. */
    private static MetaIdentity findRefToSubject(SymbolTable symbols, String junctionPkg,
                                                 List<MetaIdentity> refs,
                                                 MetaObject declaring, MetaObject source) {
        for (MetaIdentity ref : refs) {
            if (isSubject(refTargetObject(symbols, junctionPkg, ref), declaring, source)) return ref;
        }
        return null;
    }

    private static MetaIdentity findRefToObject(SymbolTable symbols, String junctionPkg,
                                                List<MetaIdentity> refs, MetaObject entity) {
        if (entity == null) return null;
        for (MetaIdentity ref : refs) {
            MetaObject t = refTargetObject(symbols, junctionPkg, ref);
            if (t != null && t.getName().equals(entity.getName())) return ref;
        }
        return null;
    }

    /**
     * ADR-0041/0042 — resolve a name to a top-level {@link MetaObject} through the
     * package-local {@link SymbolTable} matcher: an FQN (contains {@code ::}) resolves
     * EXACTLY on its resolution key; a bare name resolves in {@code referrerPkg}, else a
     * root-level (empty-package) object whose key IS the bare name. No bare-tail
     * first-match-wins fallback.
     *
     * <p>This used to scan {@code root.getChildren()} matching a bare name against the
     * FIRST same-short-name object found regardless of package (issue #174) — the same
     * defect class the TS reference (and {@code ValidationPhase.resolveRootObject}, which
     * the loader's own M:N validation rule uses for {@code @through}) closed by resolving
     * package-locally. Sharing {@link SymbolTable} — rather than reimplementing the rule a
     * second time here — is what keeps the loader and this derivation from disagreeing
     * about which object a bare name binds to.
     */
    private static MetaObject findObject(SymbolTable symbols, String name, String referrerPkg) {
        if (name == null || name.isEmpty()) return null;
        return symbols.resolveObject(name, referrerPkg);
    }

    private static String stripPackage(String name) {
        return ReferenceFkUtil.stripPackage(name);
    }
}

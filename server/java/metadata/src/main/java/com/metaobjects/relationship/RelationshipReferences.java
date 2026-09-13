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
import com.metaobjects.identity.MetaIdentity;
import com.metaobjects.identity.ReferenceIdentity;
import com.metaobjects.object.MetaObject;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * Association -&gt; identity.reference resolution (issue #368).
 *
 * <p>An entity may declare more than one identity.reference onto the SAME target
 * entity (Match.homeTeamRef and Match.awayTeamRef both -&gt; Team). A
 * {@code @cardinality: one} relationship names only its target, so when two
 * references match, the target alone cannot say which FK the navigation uses.
 * Taking the first match emits a join on the wrong column that typechecks, has
 * correct DDL and passes verify — so the ladder below resolves it explicitly or
 * not at all. ADR-0029 §5: ambiguity is a load error naming the candidates.</p>
 *
 * <p>Ported 1:1 from
 * {@code typescript/packages/metadata/src/core/relationship/resolve-relationship-reference.ts}
 * (see also the Python port, {@code relationship_references.py}, and the C# port,
 * {@code MetaObjects.Core.Relationship.RelationshipReferences}) — that file is the
 * authoritative spec; this class mirrors it exactly (same suffix list, same order,
 * same "candidate side only" stripping).</p>
 */
public final class RelationshipReferences {

    private RelationshipReferences() {
        // static utility class
    }

    /**
     * Trailing suffixes stripped from a CANDIDATE's name/FK field when building its
     * pairing keys. Ordered — first match wins, so "reference" is tested before
     * "ref". Never applied to the relationship name (see {@link #referencePairingKeys}).
     */
    private static final List<String> PAIRING_SUFFIXES = List.of("reference", "ref", "id", "key");

    private static String stripOneSuffix(String value) {
        for (String suffix : PAIRING_SUFFIXES) {
            if (value.length() > suffix.length() && value.endsWith(suffix)) {
                return value.substring(0, value.length() - suffix.length());
            }
        }
        return value;
    }

    /** The FK field a reference is anchored on (first field; composite FKs pair on their
     *  first column), or {@code null} when the reference declares no {@code @fields}. */
    private static String refFkField(ReferenceIdentity ref) {
        List<String> fields = ref.getFields();
        return fields.isEmpty() ? null : fields.get(0);
    }

    /** Last {@code ::}-segment of a (possibly package-qualified, possibly null/empty) name. */
    private static String stripPackage(String name) {
        if (name == null || name.isEmpty()) return "";
        int idx = name.lastIndexOf(MetaData.PKG_SEPARATOR);
        return idx < 0 ? name : name.substring(idx + MetaData.PKG_SEPARATOR.length());
    }

    /**
     * The set of lowercased names a candidate reference answers to: its own name
     * (short name — a reference is never itself package-qualified) and its FK
     * field, each with and without one stripped suffix.
     *
     * <p>{@code toLowerCase(Locale.ROOT)} — never the no-arg {@code toLowerCase()} — so
     * behaviour does not depend on the JVM's default locale (a Turkish-locale JVM lower-
     * cases {@code "I"} to {@code "ı"}, not {@code "i"}).</p>
     */
    public static Set<String> referencePairingKeys(ReferenceIdentity ref) {
        Set<String> keys = new HashSet<>();
        addPairingKey(keys, ref.getShortName());
        addPairingKey(keys, refFkField(ref));
        return keys;
    }

    private static void addPairingKey(Set<String> keys, String value) {
        if (value == null || value.isEmpty()) return;
        String lower = value.toLowerCase(Locale.ROOT);
        keys.add(lower);
        keys.add(stripOneSuffix(lower));
    }

    /**
     * Every {@code identity.reference} on {@code holder} whose {@code @references} targets
     * {@code targetEntity}. Package-insensitive on both sides: {@code @references} and
     * {@code @objectRef} may each be bare or fully qualified.
     *
     * <p>ADR-0039: resolving — {@code holder.getIdentities()} (no-arg, includeParentData
     * defaulting true) honors references inherited via extends.</p>
     */
    public static List<ReferenceIdentity> referenceCandidatesFor(MetaObject holder, String targetEntity) {
        String target = stripPackage(targetEntity);
        List<ReferenceIdentity> out = new ArrayList<>();
        for (MetaIdentity id : holder.getIdentities()) {
            if (!(id instanceof ReferenceIdentity)) continue;
            ReferenceIdentity ref = (ReferenceIdentity) id;
            if (!target.equals(stripPackage(ref.getTargetEntity()))) continue;
            if (refFkField(ref) == null) continue;
            out.add(ref);
        }
        return out;
    }

    /**
     * Which identity.reference does this {@code @cardinality: one} relationship navigate
     * through? The ladder, in order:
     * <ol>
     *   <li>exactly one candidate -&gt; that one (the common case; unchanged behaviour)</li>
     *   <li>{@code @sourceRefField} declared -&gt; the candidate whose FK field it names,
     *       SHORT-CIRCUITING (does not fall through to name-pairing on a miss)</li>
     *   <li>exactly one candidate name-pairs -&gt; that one</li>
     *   <li>otherwise -&gt; {@code null} (caller reports the ambiguity)</li>
     * </ol>
     * Returns {@code null} for "no candidate" and "cannot choose" alike; callers that need
     * to tell them apart use {@link #referenceCandidatesFor}.
     *
     * @param holder the entity whose effective reference set is searched
     * @param relationshipName the relationship's own (short) name, used for name-pairing
     * @param targetEntity the relationship's {@code @objectRef}
     * @param sourceRefField the relationship's declared {@code @sourceRefField}, or
     *                        {@code null}/empty when absent
     */
    public static ReferenceIdentity resolveRelationshipReference(
            MetaObject holder, String relationshipName, String targetEntity, String sourceRefField) {
        List<ReferenceIdentity> candidates = referenceCandidatesFor(holder, targetEntity);
        if (candidates.isEmpty()) return null;
        if (candidates.size() == 1) return candidates.get(0);

        if (sourceRefField != null && !sourceRefField.isEmpty()) {
            for (ReferenceIdentity ref : candidates) {
                if (sourceRefField.equals(refFkField(ref))) return ref;
            }
            return null;
        }

        String wanted = relationshipName.toLowerCase(Locale.ROOT);
        List<ReferenceIdentity> paired = new ArrayList<>();
        for (ReferenceIdentity ref : candidates) {
            if (referencePairingKeys(ref).contains(wanted)) paired.add(ref);
        }
        return paired.size() == 1 ? paired.get(0) : null;
    }

    /** Overload for the common case with no declared {@code @sourceRefField}. */
    public static ReferenceIdentity resolveRelationshipReference(
            MetaObject holder, String relationshipName, String targetEntity) {
        return resolveRelationshipReference(holder, relationshipName, targetEntity, null);
    }
}

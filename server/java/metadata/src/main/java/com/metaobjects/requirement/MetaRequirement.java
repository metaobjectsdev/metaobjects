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
package com.metaobjects.requirement;

import com.metaobjects.MetaData;
import com.metaobjects.attr.MetaAttribute;
import com.metaobjects.attr.StringArrayAttribute;
import com.metaobjects.attr.StringAttribute;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;

/**
 * Abstract base class for requirement nodes ({@code type = "requirement"}).
 *
 * <p>{@code requirement.*} is REGISTERED metamodel vocabulary (requirements-as-metadata
 * ruling, Amendment 3): the capability ledger IS a metadata model, so it is declared in
 * {@code metaobjects/} beside the entities it describes and validated by the loader like
 * everything else — never hand-parsed from a side file.</p>
 *
 * <p>The subtype axis is the CHECK POLARITY, a genuine behaviour difference and therefore
 * a subtype under ADR-0037 §2:</p>
 * <ul>
 *   <li>{@link FunctionalRequirement} ({@code requirement.functional}) — EXISTENCE:
 *       it fails when NOTHING implements it.</li>
 *   <li>{@link ArchitecturalRequirement} ({@code requirement.architectural}) —
 *       UNIVERSALITY: it fails when something VIOLATES it (the opposite polarity).</li>
 * </ul>
 *
 * <p>Hierarchy is NESTING, not a parent attr: an L1 solution CONTAINS its L2 segments as
 * child {@code requirement} nodes, so regrouping moves a node rather than editing a string
 * and a requirement is addressable by the same dotted child-name path as every other
 * node.</p>
 *
 * <p>Accessors are RESOLVING (ADR-0039) — they read through {@code getMetaAttr} so a
 * requirement that {@code extends} an abstract parent inherits its properties. Never
 * {@code own}-mode here.</p>
 */
public abstract class MetaRequirement extends MetaData {

    /** The canonical type name for all requirement nodes. */
    public static final String TYPE_REQUIREMENT = "requirement";

    /** What the product does for a user — checked by EXISTENCE. */
    public static final String SUBTYPE_FUNCTIONAL = "functional";

    /** How the system is built — checked by UNIVERSALITY (the opposite polarity). */
    public static final String SUBTYPE_ARCHITECTURAL = "architectural";

    // ------------------------------------------------------------------
    // Attrs
    // ------------------------------------------------------------------

    /** 1 solution · 2 segment (application/library) · 3 service · 4 object · 5 member. */
    public static final String ATTR_LEVEL = "level";

    /** Lifecycle state — a closed enum ({@link #STATUSES}). */
    public static final String ATTR_STATUS = "status";

    /** What was DECIDED about the outstanding work -- a different question from
     *  whether the work is done, which is what {@code @status} answers. ABSENT means
     *  UNDECIDED, a real state and the one a review exists to find. */
    public static final String ATTR_DISPOSITION = "disposition";

    /** Issue/ticket references for outstanding work. Free-form and NEVER resolved:
     *  verify has no network, so unlike {@code @verifiedBy} nothing here is checked
     *  to exist. Its job is to stop a deferred gap becoming invisible. */
    public static final String ATTR_TRACKED_BY = "trackedBy";

    /** What the capability / policy is, in one sentence. */
    public static final String ATTR_STATEMENT = "statement";

    /** What breaking it looks like — a requirement MUST be violable. */
    public static final String ATTR_VIOLATION = "violation";

    /** FQN references to the model nodes realising this requirement. */
    public static final String ATTR_IMPLEMENTED_BY = "implementedBy";

    /** Names of the tests proving the behaviour. */
    public static final String ATTR_VERIFIED_BY = "verifiedBy";

    /** The requirement that replaced this one. Expected on {@code status=superseded}. */
    public static final String ATTR_SUPERSEDED_BY = "supersededBy";

    // ------------------------------------------------------------------
    // Status — a closed enum, enforced by the registry via allowedValues.
    // ------------------------------------------------------------------

    /** Implemented and in use. */
    /** Intended but not built. Its references may legitimately dangle, and it never
     *  contributes to object coverage -- planning a capability must not silence the
     *  warning that nothing implements it. */
    public static final String STATUS_PLANNED = "planned";

    public static final String STATUS_LIVE = "live";

    /** Implemented with known gaps. */
    public static final String STATUS_PARTIAL = "partial";

    /** Built, then deliberately retired. */
    public static final String STATUS_ABANDONED = "abandoned";

    /** Replaced by a different mechanism. */
    public static final String STATUS_SUPERSEDED = "superseded";

    /** The closed status set, in declaration order (load-bearing — the manifest emits it). */
    public static final List<String> STATUSES = Collections.unmodifiableList(
            Arrays.asList(STATUS_PLANNED, STATUS_LIVE, STATUS_PARTIAL, STATUS_ABANDONED, STATUS_SUPERSEDED));

    /**
     * Statuses whose implementing nodes are supposed to STILL EXIST. A dangling
     * {@code @implementedBy} on one of these means the model moved and the requirement is
     * stale; on the other two the nodes are supposed to be GONE, which is the whole point
     * of the entry. The asymmetry inverts as a pair.
     */
    public static final List<String> STATUSES_REQUIRING_LIVE_NODES =
            Collections.unmodifiableList(Arrays.asList(STATUS_LIVE, STATUS_PARTIAL));

    /** Statuses with outstanding work, so a {@code @disposition} is meaningful on
     *  them. On any other status the decision IS the status, and recording a second
     *  one can only agree with it or contradict it. */
    public static final List<String> STATUSES_WITH_OUTSTANDING_WORK =
            Collections.unmodifiableList(Arrays.asList(STATUS_PLANNED, STATUS_PARTIAL));

    /** Disposition -- what was DECIDED about the outstanding work. Orthogonal to
     *  status, which says whether the work is done. Declaration order is contractual
     *  (the manifest emits allowedValues in this order, never sorted). */
    public static final String DISPOSITION_ACCEPTED = "accepted";

    public static final String DISPOSITION_DEFERRED = "deferred";

    public static final List<String> DISPOSITIONS =
            Collections.unmodifiableList(Arrays.asList(DISPOSITION_ACCEPTED, DISPOSITION_DEFERRED));

    // ------------------------------------------------------------------
    // Levels — organisational above the link floor, model-referencing at or below.
    // ------------------------------------------------------------------

    public static final int LEVEL_SOLUTION = 1;
    public static final int LEVEL_SEGMENT = 2;
    public static final int LEVEL_SERVICE = 3;
    public static final int LEVEL_OBJECT = 4;
    public static final int LEVEL_MEMBER = 5;

    /**
     * The lowest level that may reference the model. L1-L3 are organisational and
     * carrying {@code @implementedBy} there is an error.
     */
    public static final int LINK_FLOOR_LEVEL = LEVEL_OBJECT;

    public static final int MIN_LEVEL = LEVEL_SOLUTION;
    public static final int MAX_LEVEL = LEVEL_MEMBER;

    protected MetaRequirement(String subType, String name) {
        super(TYPE_REQUIREMENT, subType, name);
    }

    /**
     * Permit NESTED {@code requirement} children.
     *
     * <p>{@link MetaData#checkValidChild} blanket-refuses a child of the SAME type as its
     * parent — a rule that predates any self-nesting type in the metamodel. Requirement
     * hierarchy IS nesting (an L1 solution CONTAINS its L2 segments), which is exactly
     * what {@code spec/metamodel/requirement.json} declares as
     * {@code requirement.functional}'s structural child, so that blanket refusal has to
     * be lifted here or the declared child rule is unreachable.</p>
     *
     * <p>WHICH subtypes may nest stays the registry's decision, not this method's: the
     * spec declares the nested-{@code requirement} child rule on BOTH subtypes -- a
     * functional tree nests by capability, an architectural one may nest under a quality
     * taxonomy -- and {@code applyStrictStructuralChildren} is what puts that rule on the
     * type definition. Every other same-type combination still hits the base refusal.</p>
     */
    @Override
    protected void checkValidChild(MetaData data) {
        if (data != null && TYPE_REQUIREMENT.equals(data.getType())) {
            return;
        }
        super.checkValidChild(data);
    }

    // ------------------------------------------------------------------
    // Accessors — RESOLVING (ADR-0039), never own-only.
    // ------------------------------------------------------------------

    /** What the product does for a user — checked by EXISTENCE. */
    public boolean isFunctional() {
        return SUBTYPE_FUNCTIONAL.equals(getSubType());
    }

    /** How the system is built — checked by UNIVERSALITY (the opposite polarity). */
    public boolean isArchitectural() {
        return SUBTYPE_ARCHITECTURAL.equals(getSubType());
    }

    /**
     * 1 solution · 2 segment · 3 service · 4 object · 5 member. Architectural
     * requirements carry none — they are object-independent by definition.
     *
     * @return the declared/inherited level, or {@code null} when absent
     */
    public Integer getLevel() {
        if (!hasMetaAttr(ATTR_LEVEL)) {
            return null;
        }
        Object value = getMetaAttr(ATTR_LEVEL).getValue();
        if (value instanceof Number) {
            return ((Number) value).intValue();
        }
        String raw = getMetaAttr(ATTR_LEVEL).getValueAsString();
        if (raw == null || raw.trim().isEmpty()) {
            return null;
        }
        try {
            return Integer.valueOf(raw.trim());
        } catch (NumberFormatException e) {
            return null;
        }
    }

    /** The lifecycle status, or {@code null} when absent. */
    public String getStatus() {
        return hasMetaAttr(ATTR_STATUS) ? getMetaAttr(ATTR_STATUS).getValueAsString() : null;
    }

    /** What the capability / policy is, in one sentence, or {@code null} when absent. */
    public String getStatement() {
        return hasMetaAttr(ATTR_STATEMENT) ? getMetaAttr(ATTR_STATEMENT).getValueAsString() : null;
    }

    /** What breaking it looks like, in one sentence, or {@code null} when absent. */
    public String getViolation() {
        return hasMetaAttr(ATTR_VIOLATION) ? getMetaAttr(ATTR_VIOLATION).getValueAsString() : null;
    }

    /** FQN references to the model nodes realising this requirement; empty when absent. */
    public List<String> getImplementedBy() {
        return stringList(ATTR_IMPLEMENTED_BY);
    }

    /** Names of the tests proving the behaviour; empty when absent. */
    public List<String> getVerifiedBy() {
        return stringList(ATTR_VERIFIED_BY);
    }

    /** What was DECIDED about the outstanding work; {@code null} means UNDECIDED. */
    public String getDisposition() {
        return hasMetaAttr(ATTR_DISPOSITION) ? getMetaAttr(ATTR_DISPOSITION).getValueAsString() : null;
    }

    /** Issue/ticket references for outstanding work. Never resolved. */
    public List<String> getTrackedBy() {
        return stringList(ATTR_TRACKED_BY);
    }

    /** Intended but not built -- exempt from the checks that assume a built thing. */
    public boolean isPlanned() {
        return STATUS_PLANNED.equals(getStatus());
    }

    /** True when there is outstanding work, so a {@code @disposition} says something. */
    public boolean hasOutstandingWork() {
        return STATUSES_WITH_OUTSTANDING_WORK.contains(getStatus());
    }

    /** The requirement that replaced this one, or {@code null} when absent. */
    public String getSupersededBy() {
        return hasMetaAttr(ATTR_SUPERSEDED_BY)
                ? getMetaAttr(ATTR_SUPERSEDED_BY).getValueAsString() : null;
    }

    /** The NESTED child requirements (hierarchy IS nesting). */
    public List<MetaRequirement> getChildRequirements() {
        // ADR-0039: resolving accessor — a requirement that `extends` an abstract
        // parent must see the parent's nested children too.
        return getChildren(MetaRequirement.class, true);
    }

    /**
     * True when this requirement is permitted to reference the model at all.
     *
     * <p>An UNLEVELLED architectural requirement always may -- its claim set is the whole
     * point, and that is the original flat form. Once a level is PRESENT the node has
     * opted into a tree, and the link floor applies to it exactly as it does to a
     * functional one, so an "ISO 25010 Security" grouping node cannot quietly start
     * naming entities. Levelling is the opt-in; enforcing the floor unconditionally would
     * have broken every existing flat policy.</p>
     */
    public boolean mayReferenceModel() {
        Integer level = getLevel();
        if (level == null) {
            return isArchitectural();
        }
        return level >= LINK_FLOOR_LEVEL;
    }

    /**
     * True when a dangling {@code @implementedBy} is an ERROR rather than expected.
     * An abandoned or superseded requirement's nodes are supposed to be gone.
     */
    public boolean requiresLiveNodes() {
        String status = getStatus();
        return status != null && STATUSES_REQUIRING_LIVE_NODES.contains(status);
    }

    /**
     * Read a string-array attr, tolerating both the {@link StringArrayAttribute} shape
     * and the {@link StringAttribute}-with-{@code @isArray} comma-delimited shape (the
     * same dual handling {@code MetaIdentity.getFields()} / {@code Index.getFields()}
     * carry).
     */
    private List<String> stringList(String attrName) {
        if (!hasMetaAttr(attrName)) {
            return new ArrayList<>();
        }
        MetaAttribute<?> attr = getMetaAttr(attrName);

        if (attr instanceof StringArrayAttribute) {
            List<String> value = ((StringArrayAttribute) attr).getValue();
            return value != null ? value : new ArrayList<>();
        }
        if (attr instanceof StringAttribute) {
            String value = attr.getValueAsString();
            if (value == null || value.trim().isEmpty()) {
                return new ArrayList<>();
            }
            List<String> out = new ArrayList<>();
            for (String part : value.split(",")) {
                String trimmed = part.trim();
                if (!trimmed.isEmpty()) {
                    out.add(trimmed);
                }
            }
            return out;
        }
        return new ArrayList<>();
    }

    @Override
    public String toString() {
        return String.format("%s[%s:%s]{%s}",
            getClass().getSimpleName(), getType(), getSubType(), getName());
    }
}

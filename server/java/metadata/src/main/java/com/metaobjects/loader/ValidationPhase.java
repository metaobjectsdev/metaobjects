/*
 * Copyright 2003 Doug Mealing LLC dba Meta Objects. All Rights Reserved.
 *
 * This software is the proprietary information of Doug Mealing LLC dba Meta Objects.
 * Use is subject to license terms.
 */
package com.metaobjects.loader;

import com.metaobjects.ErrorCode;
import com.metaobjects.MetaData;
import com.metaobjects.MetaDataException;
import com.metaobjects.MetaRoot;
import com.metaobjects.attr.MetaAttribute;
import com.metaobjects.field.EnumField;
import com.metaobjects.object.MetaObject;
import com.metaobjects.relationship.MetaRelationship;
import com.metaobjects.source.MetaSource;
import com.metaobjects.util.ErrorMessageConstants;

/**
 * Post-load validation phase — runs after all sources are parsed and before the
 * loader transitions to INITIALIZED.
 *
 * <p>Mirrors the C# {@code ValidationPasses} orchestrator in style (stateless static
 * methods, a single public entry point) while preserving Java's eager-throw semantics:
 * the first validation error raises {@link MetaDataException} immediately rather than
 * collecting all errors into a list.</p>
 *
 * <p>In this phase only enum {@code @values} content validation is wired here. Other
 * validation passes will be migrated incrementally.</p>
 *
 * <p>Ordering: {@code extends:} super resolution happens eagerly at parse time, so by
 * the time this phase runs {@link MetaData#getSuperData()} is already set. The own-only
 * validation contract (validate the node's own attributes, not inherited ones) means we
 * do not need effective/resolved attribute access.</p>
 *
 * @since 6.1.0
 */
public final class ValidationPhase {

    private ValidationPhase() {
        // Utility class — not instantiated
    }

    /**
     * Run all post-load validation passes over the fully-merged metadata tree.
     *
     * <p>Currently runs:</p>
     * <ol>
     *   <li>{@link #validateEnumValues(MetaRoot)} — enum {@code @values} content rules.</li>
     *   <li>{@link #validateSourceAttrs(MetaRoot)} — {@code source.*} {@code @kind}/{@code @role}
     *       enum-membership rules.</li>
     *   <li>{@link #validateOnePrimarySource(MetaRoot)} — exactly one {@code role=primary} source
     *       per object that declares any sources.</li>
     *   <li>{@link #validateRelationshipReferentialActions(MetaRoot)} — {@code relationship.*}
     *       {@code @onDelete}/{@code @onUpdate} enum-membership rules.</li>
     * </ol>
     *
     * @param root the fully-loaded {@link MetaRoot}; must not be {@code null}
     * @throws MetaDataException on the first validation error found (eager-throw)
     */
    public static void run(MetaRoot root) {
        if (root == null) return;
        validateEnumValues(root);
        validateSourceAttrs(root);
        validateOnePrimarySource(root);
        validateRelationshipReferentialActions(root);
    }

    // =========================================================================
    // Enum @values validation
    //
    // Three content rules applied to every field.enum node that declares its OWN
    // @values (own-only; inherited values are validated on the base node).
    //
    //   1. Non-empty list  → ERR_BAD_ATTR_VALUE
    //   2. Identifier-safe member (^[A-Za-z_][A-Za-z0-9_]*$) → ERR_BAD_ATTR_VALUE
    //   3. No duplicates   → ERR_BAD_ATTR_VALUE
    //
    // A concrete field.enum with no own @values but a valid super reference is exempt
    // from content validation (the base is validated on its own node).
    // A concrete field.enum with no own @values AND no super reference is flagged as
    // missing a required attribute → ERR_MISSING_REQUIRED_ATTR.
    //
    // This pass relies only on getSuperData() for the required-check exemption, and
    // getSuperData() is set eagerly by the parser when a valid "extends" is found
    // (at parse time, before this validation phase runs).
    // =========================================================================

    /**
     * Walk the full tree and validate every {@code field.enum} node.
     *
     * @param root the root node to walk
     * @throws MetaDataException on the first error found
     */
    static void validateEnumValues(MetaRoot root) {
        walkEnumValues(root);
    }

    private static void walkEnumValues(MetaData node) {
        validateEnumNode(node);
        // Recurse into own children only (includeParentData=false) — inherited children
        // are validated on their own declaring nodes, so we must not double-visit them.
        for (MetaData child : node.getChildren(MetaData.class, false)) {
            walkEnumValues(child);
        }
    }

    /**
     * Validate a single node if it is a {@code field.enum}.
     *
     * <p>Applies the own-only contract:</p>
     * <ul>
     *   <li>If the node has its own {@code @values}, enforce content rules.</li>
     *   <li>If it has no own {@code @values} and no super reference, report
     *       {@code ERR_MISSING_REQUIRED_ATTR}.</li>
     *   <li>If it has no own {@code @values} but has a super reference, it is exempt.</li>
     * </ul>
     *
     * @param node the node to inspect
     * @throws MetaDataException on validation error
     */
    private static void validateEnumNode(MetaData node) {
        if (!EnumField.TYPE_FIELD.equals(node.getType())
                || !EnumField.SUBTYPE_ENUM.equals(node.getSubType())) {
            return;
        }

        // --- Own @values content check ---
        if (node.hasMetaAttr(EnumField.ATTR_VALUES, false)) {
            MetaAttribute<?> valuesAttr = node.getMetaAttr(EnumField.ATTR_VALUES, false);
            if (!EnumField.validateEnumValues(valuesAttr.getValue())) {
                throw new MetaDataException(
                    ErrorMessageConstants.ERR_BAD_ATTR_VALUE
                        + ": field.enum '" + node.getName()
                        + "' @values must be a non-empty list of identifier-safe, unique members"
                        + " (e.g. [\"DRAFT\",\"PUBLISHED\"])",
                    ErrorCode.ERR_BAD_ATTR_VALUE);
            }
            // Own @values present and valid — required check not needed.
            return;
        }

        // --- Required check ---
        // No own @values. Valid only if there is a super reference (inheriting @values).
        if (node.getSuperData() == null) {
            throw new MetaDataException(
                ErrorMessageConstants.ERR_MISSING_REQUIRED_ATTR
                    + ": field.enum '" + node.getName()
                    + "' is missing required @values attribute",
                ErrorCode.ERR_MISSING_REQUIRED_ATTR);
        }
        // Has a super — inherits @values from the super, which is validated on its own node.
    }

    // =========================================================================
    // Source @kind / @role enum validation
    //
    // Applied to every source.* node after the full tree is built (attrs are set
    // post-placement, so we cannot validate at addChild time via the constraint
    // framework — same reason field.enum uses a post-load pass).
    //
    //   @kind must be one of: table / view / materializedView / storedProc / tableFunction
    //   @role must be one of: primary / replica / index / cache / publish / mirror
    //
    // Missing attrs are fine (defaults apply); only explicitly-set bad values fail.
    // =========================================================================

    /**
     * Walk the full tree and validate {@code @kind} and {@code @role} on every
     * {@code source.*} node.
     *
     * @param root the root node to walk
     * @throws MetaDataException on the first error found
     */
    static void validateSourceAttrs(MetaRoot root) {
        walkSourceAttrs(root);
    }

    private static void walkSourceAttrs(MetaData node) {
        validateSourceNode(node);
        for (MetaData child : node.getChildren(MetaData.class, false)) {
            walkSourceAttrs(child);
        }
    }

    /**
     * Validate {@code @kind} and {@code @role} on a single node if it is a {@code source.*}.
     *
     * @param node the node to inspect
     * @throws MetaDataException if {@code @kind} or {@code @role} is set to an invalid value
     */
    private static void validateSourceNode(MetaData node) {
        if (!MetaSource.TYPE_SOURCE.equals(node.getType())) {
            return;
        }
        // Only validate on instances of MetaSource (skip the abstract base type itself at
        // registration time — it will never appear in a loaded document tree).
        if (!(node instanceof MetaSource)) {
            return;
        }
        MetaSource src = (MetaSource) node;

        // Validate @kind (own attribute only — defaults are fine)
        if (node.hasMetaAttr(MetaSource.ATTR_KIND, false)) {
            String kind = src.getEffectiveKind();
            if (!MetaSource.KIND_TABLE.equals(kind)
                    && !MetaSource.KIND_VIEW.equals(kind)
                    && !MetaSource.KIND_MATERIALIZED_VIEW.equals(kind)
                    && !MetaSource.KIND_STORED_PROC.equals(kind)
                    && !MetaSource.KIND_TABLE_FUNCTION.equals(kind)) {
                throw new MetaDataException(
                    ErrorMessageConstants.ERR_BAD_ATTR_VALUE
                        + ": source '" + node.getName()
                        + "' @kind '" + kind
                        + "' is not a valid value; allowed: table, view, materializedView,"
                        + " storedProc, tableFunction",
                    ErrorCode.ERR_BAD_ATTR_VALUE);
            }
        }

        // Validate @role (own attribute only — defaults are fine)
        if (node.hasMetaAttr(MetaSource.ATTR_ROLE, false)) {
            String role = src.getRole();
            if (!MetaSource.ROLE_PRIMARY.equals(role)
                    && !MetaSource.ROLE_REPLICA.equals(role)
                    && !MetaSource.ROLE_INDEX.equals(role)
                    && !MetaSource.ROLE_CACHE.equals(role)
                    && !MetaSource.ROLE_PUBLISH.equals(role)
                    && !MetaSource.ROLE_MIRROR.equals(role)) {
                throw new MetaDataException(
                    ErrorMessageConstants.ERR_BAD_ATTR_VALUE
                        + ": source '" + node.getName()
                        + "' @role '" + role
                        + "' is not a valid value; allowed: primary, replica, index, cache, publish, mirror",
                    ErrorCode.ERR_BAD_ATTR_VALUE);
            }
        }
    }

    // =========================================================================
    // One-primary multi-source validation
    //
    // An object (entity or value) that declares ≥1 source.* children MUST have
    // exactly one whose effective role is "primary":
    //
    //   0 sources          → OK (object is not persisted)
    //   1+ sources, 1 primary → OK
    //   1+ sources, 0 primary → ERR_SOURCE_NO_PRIMARY
    //   1+ sources, 2+ primary → ERR_SOURCE_MULTIPLE_PRIMARY
    //
    // Own-only: only direct MetaSource children of the object are counted.
    // Validation is eager-throw: first violation terminates the pass.
    // =========================================================================

    /**
     * Walk every {@code object.*} in the root tree and enforce the one-primary rule:
     * if an object declares any sources, exactly one must have an effective role of
     * {@code "primary"}.
     *
     * @param root the root node to walk
     * @throws MetaDataException on the first violation found
     */
    static void validateOnePrimarySource(MetaRoot root) {
        for (MetaData child : root.getChildren(MetaData.class, false)) {
            walkOnePrimarySource(child);
        }
    }

    private static void walkOnePrimarySource(MetaData node) {
        if (node instanceof MetaObject) {
            validateObjectPrimarySource((MetaObject) node);
        }
        // Recurse into own children — handles nested objects (value objects inside entities, etc.)
        for (MetaData child : node.getChildren(MetaData.class, false)) {
            walkOnePrimarySource(child);
        }
    }

    /**
     * Enforce the one-primary rule on a single {@code MetaObject} node.
     *
     * <p>Counts own {@code MetaSource} children whose effective role is {@code "primary"}.
     * Objects with zero source children are exempt.</p>
     *
     * @param obj the object node to inspect
     * @throws MetaDataException if the one-primary rule is violated
     */
    private static void validateObjectPrimarySource(MetaObject obj) {
        // Collect own MetaSource children (own-only, includeParentData=false).
        java.util.List<MetaSource> sources = new java.util.ArrayList<>();
        for (MetaData child : obj.getChildren(MetaData.class, false)) {
            if (child instanceof MetaSource) {
                sources.add((MetaSource) child);
            }
        }

        if (sources.isEmpty()) {
            // No sources declared — object is not persisted; no rule to enforce.
            return;
        }

        long primaryCount = sources.stream()
            .filter(s -> MetaSource.ROLE_PRIMARY.equals(s.getRole()))
            .count();

        if (primaryCount == 0) {
            throw new MetaDataException(
                ErrorMessageConstants.ERR_SOURCE_NO_PRIMARY
                    + ": object '" + obj.getName()
                    + "' declares " + sources.size()
                    + " source(s) but none has role \"" + MetaSource.ROLE_PRIMARY + "\"",
                ErrorCode.ERR_SOURCE_NO_PRIMARY);
        }

        if (primaryCount > 1) {
            throw new MetaDataException(
                ErrorMessageConstants.ERR_SOURCE_MULTIPLE_PRIMARY
                    + ": object '" + obj.getName()
                    + "' declares " + primaryCount
                    + " sources with role \"" + MetaSource.ROLE_PRIMARY
                    + "\"; exactly one is required",
                ErrorCode.ERR_SOURCE_MULTIPLE_PRIMARY);
        }
    }

    // =========================================================================
    // Relationship @onDelete / @onUpdate enum validation
    //
    // Applied to every relationship.* node after the full tree is built.
    // The .withEnum() constraint registered on relationship.base does not fire
    // eagerly at addChild time (the CustomConstraint applicability test checks
    // the container node's own type/subtype, which is attr.string for the attr
    // child, not relationship.base) — so we use this post-load pass instead,
    // mirroring the pattern for source @kind/@role.
    //
    //   @onDelete must be one of: cascade / set-null / restrict / no-action
    //   @onUpdate must be one of: cascade / set-null / restrict / no-action
    //
    // Missing attrs are fine (defaults apply per subtype in consumer code);
    // only explicitly-set bad values fail.
    // =========================================================================

    /**
     * Walk the full tree and validate {@code @onDelete} and {@code @onUpdate} on every
     * {@code relationship.*} node.
     *
     * @param root the root node to walk
     * @throws MetaDataException on the first error found
     */
    static void validateRelationshipReferentialActions(MetaRoot root) {
        walkRelationshipReferentialActions(root);
    }

    private static void walkRelationshipReferentialActions(MetaData node) {
        validateRelationshipNode(node);
        for (MetaData child : node.getChildren(MetaData.class, false)) {
            walkRelationshipReferentialActions(child);
        }
    }

    /**
     * Validate {@code @onDelete} and {@code @onUpdate} on a single node if it is a
     * {@code relationship.*} instance.
     *
     * @param node the node to inspect
     * @throws MetaDataException if {@code @onDelete} or {@code @onUpdate} is set to an
     *         invalid value (not in {@link MetaRelationship#REFERENTIAL_ACTIONS})
     */
    private static void validateRelationshipNode(MetaData node) {
        if (!MetaRelationship.TYPE_RELATIONSHIP.equals(node.getType())) {
            return;
        }
        // Only validate concrete MetaRelationship instances — skip the abstract base type
        // itself at registration time; it will never appear in a loaded document tree.
        if (!(node instanceof MetaRelationship)) {
            return;
        }
        MetaRelationship rel = (MetaRelationship) node;

        // Validate @onDelete (own attribute only — absent is fine)
        if (node.hasMetaAttr(MetaRelationship.ATTR_ON_DELETE, false)) {
            String onDelete = rel.getOnDeleteRaw();
            if (!MetaRelationship.REFERENTIAL_ACTIONS.contains(onDelete)) {
                throw new MetaDataException(
                    ErrorMessageConstants.ERR_BAD_ATTR_VALUE
                        + ": relationship '" + node.getName()
                        + "' @onDelete '" + onDelete
                        + "' is not a valid value; allowed: cascade, set-null, restrict, no-action",
                    ErrorCode.ERR_BAD_ATTR_VALUE);
            }
        }

        // Validate @onUpdate (own attribute only — absent is fine)
        if (node.hasMetaAttr(MetaRelationship.ATTR_ON_UPDATE, false)) {
            String onUpdate = rel.getOnUpdateRaw();
            if (!MetaRelationship.REFERENTIAL_ACTIONS.contains(onUpdate)) {
                throw new MetaDataException(
                    ErrorMessageConstants.ERR_BAD_ATTR_VALUE
                        + ": relationship '" + node.getName()
                        + "' @onUpdate '" + onUpdate
                        + "' is not a valid value; allowed: cascade, set-null, restrict, no-action",
                    ErrorCode.ERR_BAD_ATTR_VALUE);
            }
        }
    }

}

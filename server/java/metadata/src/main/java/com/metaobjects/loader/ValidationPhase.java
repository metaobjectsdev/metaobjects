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
 * <p>Ordering: this phase runs <em>after</em> {@code extends:} super resolution, so
 * {@link MetaData#getSuperData()} is already set. The own-only validation contract
 * (validate the node's own attributes, not inherited ones) means we do not need
 * effective/resolved attribute access.</p>
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
     * </ol>
     *
     * @param root the fully-loaded {@link MetaRoot}; must not be {@code null}
     * @throws MetaDataException on the first validation error found (eager-throw)
     */
    public static void run(MetaRoot root) {
        if (root == null) return;
        validateEnumValues(root);
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
    // This pass is safe to run before super resolution because it relies only on
    // getSuperData() for the required-check exemption, and getSuperData() is set by
    // the parser when a valid "extends" is found (before the validation phase runs).
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
            @SuppressWarnings("unchecked")
            MetaAttribute<?> valuesAttr = (MetaAttribute<?>) node.getMetaAttr(EnumField.ATTR_VALUES, false);
            if (valuesAttr == null || !EnumField.validateEnumValues(valuesAttr.getValue())) {
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

}

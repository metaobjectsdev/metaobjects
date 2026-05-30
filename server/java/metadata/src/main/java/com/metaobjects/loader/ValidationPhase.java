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
import com.metaobjects.field.BooleanField;
import com.metaobjects.field.CurrencyField;
import com.metaobjects.field.DateField;
import com.metaobjects.field.DecimalField;
import com.metaobjects.field.DoubleField;
import com.metaobjects.field.EnumField;
import com.metaobjects.field.FloatField;
import com.metaobjects.field.IntegerField;
import com.metaobjects.field.LongField;
import com.metaobjects.field.MetaField;
import com.metaobjects.field.ObjectField;
import com.metaobjects.field.TimeField;
import com.metaobjects.field.TimestampField;
import com.metaobjects.layout.DataGridLayout;
import com.metaobjects.layout.MetaLayout;
import com.metaobjects.identity.MetaIdentity;
import com.metaobjects.object.MetaObject;
import com.metaobjects.origin.AggregateOrigin;
import com.metaobjects.origin.CollectionOrigin;
import com.metaobjects.origin.MetaOrigin;
import com.metaobjects.origin.PassthroughOrigin;
import com.metaobjects.relationship.MetaRelationship;
import com.metaobjects.attr.MetaAttribute;
import com.metaobjects.registry.ChildRequirement;
import com.metaobjects.registry.MetaDataRegistry;
import com.metaobjects.registry.TypeDefinition;
import com.metaobjects.source.MetaSource;
import com.metaobjects.source.ResolvedSource;
import com.metaobjects.template.MetaTemplate;
import com.metaobjects.template.OutputTemplate;
import com.metaobjects.template.PromptTemplate;
import com.metaobjects.template.TemplateConstants;
import com.metaobjects.util.ErrorMessageConstants;

import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

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
     *   <li>{@link #validateOrigins(MetaRoot)} — {@code origin.*} required-attr +
     *       {@code @from}/{@code @of} reference resolution + {@code @via} path traversal
     *       through declared relationships.</li>
     *   <li>{@link #validateEntityHasPrimaryIdentity(MetaRoot, MetaDataLoader)} — non-fatal
     *       advisory: every concrete {@code object.entity} with at least one field child
     *       SHOULD have a primary identity (unless {@code @isAbstract: true}). Records
     *       a warning via the loader's warning surface; does not throw.</li>
     * </ol>
     *
     * @param root the fully-loaded {@link MetaRoot}; must not be {@code null}
     * @param loader the loader that produced {@code root}; may be {@code null} to
     *               skip warning collection (legacy callers)
     * @throws MetaDataException on the first validation error found (eager-throw)
     */
    public static void run(MetaRoot root, MetaDataLoader loader) {
        if (root == null) return;
        // Generic required-attr pass runs first: any node whose registered schema
        // declares required:true attrs that are absent on the node fires
        // ERR_MISSING_REQUIRED_ATTR. Mirrors TS attr-schema-validate / C#
        // ValidateAttrSchemaNode / Python validate_attr_schema. This collapses
        // per-subtype "missing @X" blocks (previously R1 for template.prompt,
        // R1b for template.toolcall) into a single cross-port-aligned pass.
        validateRequiredAttrs(root, loader);
        validateEnumValues(root);
        validateSourceAttrs(root);
        validateOnePrimarySource(root);
        validateRelationshipReferentialActions(root);
        validateOrigins(root);
        validateObjectFieldStorage(root);
        validateIdentityFieldsAndGeneration(root);
        validateDataGridLayouts(root);
        validateTemplates(root);
        validateEntityHasPrimaryIdentity(root, loader);
        warnFilterableWithoutIndex(root, loader);
    }

    /**
     * Legacy entry point retained for callers that do not have a loader handle.
     * Delegates to {@link #run(MetaRoot, MetaDataLoader)} with a {@code null}
     * loader, which skips warning collection but still runs all error-throwing
     * passes.
     *
     * @param root the fully-loaded {@link MetaRoot}; must not be {@code null}
     * @throws MetaDataException on the first validation error found (eager-throw)
     */
    public static void run(MetaRoot root) {
        run(root, null);
    }

    // =========================================================================
    // Generic required-attr validation pass (cross-port parity)
    //
    // Walks every loaded node and, for each one registered in the type registry,
    // emits ERR_MISSING_REQUIRED_ATTR for every required:true attr declared on
    // its (type, subType) schema that the node does not carry.
    //
    // "Has the attr" is checked against effective attrs (own + inherited via
    // extends:) — a node that legitimately inherits a required attr from its
    // super is NOT flagged. Mirrors TS attr-schema-validate.ts Check 1 (uses
    // node.attrs()) and C# ValidationPasses.ValidateAttrSchemaNode (uses
    // node.Attrs()).
    //
    // Both DIRECT and INHERITED childRequirements are considered. Per
    // TypeDefinition.populateInheritedRequirements, a direct requirement
    // shadows the inherited one of the same key, so a subtype can promote an
    // inherited optional attr to required without conflict.
    //
    // Only requirements whose expectedType is "attr" are enforced here. Other
    // required-child kinds (fields / identities) have their own bespoke checks
    // already (validateEnumValues, validateIdentityFieldsAndGeneration) that
    // carry semantic context this pass does not.
    //
    // Loader nullness: when the loader handle is unavailable (legacy two-arg
    // entry point that passes null), this pass is a no-op — the registry
    // is reached via the loader, and absent that handle there is nowhere
    // safe to look up TypeDefinitions. The downstream subtype passes
    // (validateEnumValues, validateIdentityFieldsAndGeneration) continue to
    // run regardless and catch the previously-enforced cases.
    // =========================================================================

    static void validateRequiredAttrs(MetaRoot root, MetaDataLoader loader) {
        if (loader == null) return;
        MetaDataRegistry registry = loader.getTypeRegistry();
        if (registry == null) return;
        walkRequiredAttrs(root, registry);
    }

    private static void walkRequiredAttrs(MetaData node, MetaDataRegistry registry) {
        validateRequiredAttrsNode(node, registry);
        for (MetaData child : node.getChildren(MetaData.class, false)) {
            walkRequiredAttrs(child, registry);
        }
    }

    private static void validateRequiredAttrsNode(MetaData node, MetaDataRegistry registry) {
        String type = node.getType();
        String subType = node.getSubType();
        // The MetaRoot node has type/subType = "metadata"/"root" and is registered;
        // looking it up still works and just yields no required attrs.
        if (type == null || subType == null) return;
        TypeDefinition def = registry.getTypeDefinition(type, subType);
        if (def == null) return; // unregistered (test scaffold etc.) — skip silently

        // Collect required ATTR requirements: direct first (wins on name
        // collision), then inherited for names not directly declared.
        Map<String, ChildRequirement> requiredAttrs = new java.util.LinkedHashMap<>();
        for (ChildRequirement req : def.getDirectChildRequirements()) {
            if (!req.isRequired()) continue;
            if (!MetaAttribute.TYPE_ATTR.equals(req.getExpectedType())) continue;
            if (req.isWildcard()) continue; // wildcards have no specific name to check
            requiredAttrs.put(req.getName(), req);
        }
        for (Map.Entry<String, ChildRequirement> e
                : def.getInheritedChildRequirements().entrySet()) {
            ChildRequirement req = e.getValue();
            if (!req.isRequired()) continue;
            if (!MetaAttribute.TYPE_ATTR.equals(req.getExpectedType())) continue;
            if (req.isWildcard()) continue;
            requiredAttrs.putIfAbsent(req.getName(), req);
        }

        if (requiredAttrs.isEmpty()) return;

        for (ChildRequirement req : requiredAttrs.values()) {
            // Effective lookup (includeParentData=true) — a node that inherits
            // the attr via extends: counts as having it. Matches TS/C#/Python.
            if (!node.hasMetaAttr(req.getName(), true)) {
                throw new MetaDataException(
                    ErrorMessageConstants.ERR_MISSING_REQUIRED_ATTR
                        + ": " + type + "." + subType
                        + (node.getName() != null && !node.getName().isEmpty()
                            ? " '" + node.getName() + "'" : "")
                        + " is missing required attribute '@" + req.getName() + "'",
                    ErrorCode.ERR_MISSING_REQUIRED_ATTR, node.getSource());
            }
        }
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
                    ErrorCode.ERR_BAD_ATTR_VALUE, node.getSource());
            }
            // Own @values present and valid — required check not needed.
            validateEnumFr011Attrs(node);
            return;
        }

        // --- Required check ---
        // No own @values. Valid only if there is a super reference (inheriting @values).
        if (node.getSuperData() == null) {
            throw new MetaDataException(
                ErrorMessageConstants.ERR_MISSING_REQUIRED_ATTR
                    + ": field.enum '" + node.getName()
                    + "' is missing required @values attribute",
                ErrorCode.ERR_MISSING_REQUIRED_ATTR, node.getSource());
        }
        // Has a super — inherits @values from the super, which is validated on its own node.
        // FR-011 own-attr checks still apply (a concrete enum can own @coerceDefault while
        // inheriting @values).
        validateEnumFr011Attrs(node);
    }

    /**
     * FR-011 own-attr validation for a {@code field.enum} node:
     * <ul>
     *   <li>{@code @coerceDefault} (own) must be a member of the EFFECTIVE {@code @values}
     *       (own or inherited via {@code extends:}) → {@code ERR_BAD_ATTR_VALUE}.</li>
     *   <li>{@code @normalize} (own) must be one of {@code none|collapse|strip}
     *       → {@code ERR_BAD_ATTR_VALUE} (belt-and-braces with the registered withEnum).</li>
     * </ul>
     *
     * <p>Own-only policy: only checks attrs declared on THIS node, matching the {@code @values}
     * pass above. The {@code @values} membership set is read effectively so an enum that owns
     * {@code @coerceDefault} and inherits {@code @values} validates correctly.</p>
     */
    private static void validateEnumFr011Attrs(MetaData node) {
        // @coerceDefault membership against effective @values.
        if (node.hasMetaAttr(EnumField.ATTR_COERCE_DEFAULT, false)) {
            String coerceDefault = node.getMetaAttr(EnumField.ATTR_COERCE_DEFAULT, false)
                                       .getValueAsString();
            List<String> effective = effectiveEnumValues(node);
            if (coerceDefault != null && !effective.contains(coerceDefault)) {
                throw new MetaDataException(
                    ErrorMessageConstants.ERR_BAD_ATTR_VALUE
                        + ": field.enum '" + node.getName()
                        + "' @" + EnumField.ATTR_COERCE_DEFAULT + " '" + coerceDefault
                        + "' is not one of @" + EnumField.ATTR_VALUES + ": " + effective,
                    ErrorCode.ERR_BAD_ATTR_VALUE, node.getSource());
            }
        }

        // @default (absent-fill member) membership against effective @values.
        if (node.hasMetaAttr(EnumField.ATTR_DEFAULT, false)) {
            String def = node.getMetaAttr(EnumField.ATTR_DEFAULT, false).getValueAsString();
            List<String> effective = effectiveEnumValues(node);
            if (def != null && !effective.contains(def)) {
                throw new MetaDataException(
                    ErrorMessageConstants.ERR_BAD_ATTR_VALUE
                        + ": field.enum '" + node.getName()
                        + "' @" + EnumField.ATTR_DEFAULT + " '" + def
                        + "' is not one of @" + EnumField.ATTR_VALUES + ": " + effective,
                    ErrorCode.ERR_BAD_ATTR_VALUE, node.getSource());
            }
        }

        // @normalize closed-enum membership.
        if (node.hasMetaAttr(EnumField.ATTR_NORMALIZE, false)) {
            String mode = node.getMetaAttr(EnumField.ATTR_NORMALIZE, false).getValueAsString();
            if (mode != null && !EnumField.NORMALIZE_MODES.contains(mode)) {
                throw new MetaDataException(
                    ErrorMessageConstants.ERR_BAD_ATTR_VALUE
                        + ": field.enum '" + node.getName()
                        + "' @" + EnumField.ATTR_NORMALIZE + " '" + mode
                        + "' is not a valid value; allowed: none, collapse, strip",
                    ErrorCode.ERR_BAD_ATTR_VALUE, node.getSource());
            }
        }
    }

    /**
     * The effective {@code @values} members of an enum node (own or inherited via
     * {@code extends:}). Returns an empty list when absent. The attribute is a string-array
     * ({@code StringAttribute.asArray}), so its value is a {@code List}.
     */
    private static List<String> effectiveEnumValues(MetaData node) {
        if (!node.hasMetaAttr(EnumField.ATTR_VALUES, true)) return List.of();
        Object v = node.getMetaAttr(EnumField.ATTR_VALUES, true).getValue();
        if (v instanceof List) {
            List<String> out = new java.util.ArrayList<>();
            for (Object o : (List<?>) v) if (o != null) out.add(o.toString());
            return out;
        }
        if (v instanceof String) {
            List<String> out = new java.util.ArrayList<>();
            for (String s : ((String) v).split(",")) {
                String t = s.trim();
                if (!t.isEmpty()) out.add(t);
            }
            return out;
        }
        return List.of();
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
            if (!MetaSource.VALID_KINDS.contains(kind)) {
                throw new MetaDataException(
                    ErrorMessageConstants.ERR_BAD_ATTR_VALUE
                        + ": source '" + node.getName()
                        + "' @kind '" + kind
                        + "' is not a valid value; allowed: table, view, materializedView,"
                        + " storedProc, tableFunction",
                    ErrorCode.ERR_BAD_ATTR_VALUE, node.getSource());
            }
        }

        // Validate @role (own attribute only — defaults are fine)
        if (node.hasMetaAttr(MetaSource.ATTR_ROLE, false)) {
            String role = src.getRole();
            if (!MetaSource.VALID_ROLES.contains(role)) {
                throw new MetaDataException(
                    ErrorMessageConstants.ERR_BAD_ATTR_VALUE
                        + ": source '" + node.getName()
                        + "' @role '" + role
                        + "' is not a valid value; allowed: primary, replica, index, cache, publish, mirror",
                    ErrorCode.ERR_BAD_ATTR_VALUE, node.getSource());
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
        // Own-only MetaSource children — delegates to MetaObject.getSources() to avoid
        // duplicating the child-collection logic here.
        java.util.Collection<MetaSource> sources = obj.getSources();

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
                ErrorCode.ERR_SOURCE_NO_PRIMARY, obj.getSource());
        }

        if (primaryCount > 1) {
            throw new MetaDataException(
                ErrorMessageConstants.ERR_SOURCE_MULTIPLE_PRIMARY
                    + ": object '" + obj.getName()
                    + "' declares " + primaryCount
                    + " sources with role \"" + MetaSource.ROLE_PRIMARY
                    + "\"; exactly one is required",
                ErrorCode.ERR_SOURCE_MULTIPLE_PRIMARY, obj.getSource());
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
                    ErrorCode.ERR_BAD_ATTR_VALUE, node.getSource());
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
                    ErrorCode.ERR_BAD_ATTR_VALUE, node.getSource());
            }
        }
    }

    // =========================================================================
    // field.object @storage validation
    //
    // Two rules, matching the cross-port spec:
    //   1. @storage="flattened" + isArray → ERR_STORAGE_FLATTENED_ARRAY
    //      (flattened storage materialises one column-per-field; arrays would
    //       require a side table, which is what @storage="jsonb" is for.)
    //   2. @storage set without @objectRef → ERR_STORAGE_WITHOUT_OBJECT_REF
    //      (storage shape only makes sense when there IS a referenced object).
    //
    // Only field.object nodes are inspected; @storage on other field subtypes is
    // already rejected by the constraint phase.
    // =========================================================================

    static void validateObjectFieldStorage(MetaRoot root) {
        walkObjectFieldStorage(root);
    }

    private static void walkObjectFieldStorage(MetaData node) {
        validateObjectFieldStorageNode(node);
        for (MetaData child : node.getChildren(MetaData.class, false)) {
            walkObjectFieldStorage(child);
        }
    }

    private static void validateObjectFieldStorageNode(MetaData node) {
        if (!(node instanceof ObjectField)) return;
        if (!node.hasMetaAttr(ObjectField.ATTR_STORAGE, false)) return;

        ObjectField field = (ObjectField) node;

        if (!node.hasMetaAttr(ObjectField.ATTR_OBJECTREF, false)) {
            throw new MetaDataException(
                ErrorMessageConstants.ERR_STORAGE_WITHOUT_OBJECT_REF
                    + ": field.object '" + field.getName()
                    + "' has @storage but no @objectRef — @storage shape only applies to referenced objects",
                ErrorCode.ERR_STORAGE_WITHOUT_OBJECT_REF, field.getSource());
        }

        Object storageVal = node.getMetaAttr(ObjectField.ATTR_STORAGE, false).getValue();
        if ("flattened".equals(String.valueOf(storageVal)) && field.isArrayType()) {
            throw new MetaDataException(
                ErrorMessageConstants.ERR_STORAGE_FLATTENED_ARRAY
                    + ": field.object '" + field.getName()
                    + "' @storage=\"flattened\" cannot be combined with isArray=true"
                    + " (use @storage=\"jsonb\" for owned-array storage)",
                ErrorCode.ERR_STORAGE_FLATTENED_ARRAY, field.getSource());
        }
    }

    // =========================================================================
    // Origin validation (passthrough / aggregate / collection)
    //
    // Mirrors the TS validateOriginPaths pass (server/typescript/packages/metadata/
    // src/loader/validation-passes.ts). Walks every object's own field children
    // looking for origin.* children, then per-subtype:
    //
    //   passthrough:
    //     - @from is required (ERR_INVALID_ORIGIN if missing)
    //     - @from resolves: "Entity.field" form, entity exists at root, field
    //       exists on entity (inherited fields included)
    //     - if @via is present, it resolves through declared relationships
    //
    //   aggregate:
    //     - @agg is enum-validated at registration time (.withEnum) — also
    //       enforced here for fixtures whose @agg slips past constraint phase
    //     - @of is required and resolves like passthrough's @from
    //     - @via is required and traverses real relationships entity-by-entity
    //
    //   collection:
    //     - @via required-check is enforced (matches the per-subtype spec);
    //       full path traversal is intentionally NOT enforced here, mirroring
    //       TS which only validates passthrough + aggregate paths.
    //
    // Aggregate function vocabulary uses ERR_BAD_ATTR_VALUE (matches the
    // expected-errors.json for error-origin-bad-aggregate-fn); structural /
    // referential origin errors use ERR_INVALID_ORIGIN (matches
    // error-origin-bad-via-path and the cross-language ERROR-CODES registry).
    // =========================================================================

    /**
     * Walk every {@code object.*} and validate {@code origin.*} children on its
     * fields.
     *
     * @param root the root node to walk
     * @throws MetaDataException on the first error found (eager-throw)
     */
    static void validateOrigins(MetaRoot root) {
        for (MetaData rootChild : root.getChildren(MetaData.class, false)) {
            walkOriginsOnObject(root, rootChild);
        }
    }

    private static void walkOriginsOnObject(MetaRoot root, MetaData node) {
        if (!(node instanceof MetaObject)) return; // only objects carry origins (via their fields)
        MetaObject obj = (MetaObject) node;
        for (MetaData child : obj.getChildren(MetaData.class, false)) {
            if (child instanceof MetaField) {
                MetaField<?> field = (MetaField<?>) child;
                for (MetaData originChild : field.getChildren(MetaData.class, false)) {
                    if (originChild instanceof MetaOrigin) {
                        validateOriginNode(root, obj, field, (MetaOrigin) originChild);
                    }
                }
            } else if (child instanceof MetaObject) {
                walkOriginsOnObject(root, child); // nested object (composition)
            }
            // identity/source/attr/etc. children are skipped — they don't carry origins
        }
    }

    private static void validateOriginNode(MetaRoot root, MetaObject obj,
                                           MetaField<?> field, MetaOrigin origin) {
        String subType = origin.getSubType();

        if (PassthroughOrigin.SUBTYPE_PASSTHROUGH.equals(subType)) {
            String from = origin.getFrom();
            if (from == null || from.isEmpty()) {
                throw new MetaDataException(
                    ErrorMessageConstants.ERR_INVALID_ORIGIN
                        + ": origin.passthrough on " + obj.getName() + "." + field.getName()
                        + ": missing @from.",
                    ErrorCode.ERR_INVALID_ORIGIN, origin.getSource());
            }
            validateFromOrOfPath(from, root, obj, field.getName(),
                "origin.passthrough.@from", origin.getSource());
            String via = origin.getVia();
            if (via != null && !via.isEmpty()) {
                validateViaPath(via, root, obj, field.getName(), origin.getSource());
            }
            return;
        }

        if (AggregateOrigin.SUBTYPE_AGGREGATE.equals(subType)) {
            // Re-check @agg vocabulary — the .withEnum constraint on the base
            // can be subverted by inline attribute parsing paths; mirror the
            // belt-and-braces approach used for relationship referential actions.
            String agg = origin.getAgg();
            if (agg != null && !agg.isEmpty() && !MetaOrigin.AGGREGATE_FUNCTIONS.contains(agg)) {
                throw new MetaDataException(
                    ErrorMessageConstants.ERR_BAD_ATTR_VALUE
                        + ": origin.aggregate on " + obj.getName() + "." + field.getName()
                        + " @agg '" + agg + "' is not a valid value; allowed: "
                        + "count, sum, avg, min, max",
                    ErrorCode.ERR_BAD_ATTR_VALUE, origin.getSource());
            }

            String of = origin.getOf();
            if (of == null || of.isEmpty()) {
                throw new MetaDataException(
                    ErrorMessageConstants.ERR_INVALID_ORIGIN
                        + ": origin.aggregate on " + obj.getName() + "." + field.getName()
                        + ": missing @of.",
                    ErrorCode.ERR_INVALID_ORIGIN, origin.getSource());
            }
            validateFromOrOfPath(of, root, obj, field.getName(),
                "origin.aggregate.@of", origin.getSource());

            String via = origin.getVia();
            if (via == null || via.isEmpty()) {
                throw new MetaDataException(
                    ErrorMessageConstants.ERR_INVALID_ORIGIN
                        + ": origin.aggregate on " + obj.getName() + "." + field.getName()
                        + ": missing @via (aggregates require a relationship path).",
                    ErrorCode.ERR_INVALID_ORIGIN, origin.getSource());
            }
            validateViaPath(via, root, obj, field.getName(), origin.getSource());
            return;
        }

        // origin.collection — required-check only on @via; full path traversal
        // is intentionally not enforced here (mirrors TS validateOriginPaths,
        // which only validates passthrough + aggregate).
        if (CollectionOrigin.SUBTYPE_COLLECTION.equals(subType)) {
            String via = origin.getVia();
            if (via == null || via.isEmpty()) {
                throw new MetaDataException(
                    ErrorMessageConstants.ERR_INVALID_ORIGIN
                        + ": origin.collection on " + obj.getName() + "." + field.getName()
                        + ": missing @via.",
                    ErrorCode.ERR_INVALID_ORIGIN, origin.getSource());
            }
        }
    }

    // =========================================================================
    // Entity-has-primary-identity advisory (non-fatal)
    //
    // Mirrors the TS subtype-rules.ts / C# ValidationPasses.ValidateSubtypeRules
    // warning path: every concrete object.entity with at least one field child
    // SHOULD have a primary identity child. When it doesn't (and isn't marked
    // @isAbstract: true), record a warning on the loader. This is advisory —
    // we never throw.
    //
    // Edge cases (mirror TS/C#):
    //   - Abstract entity (@isAbstract: true)       → no warning
    //   - Entity with no fields at all              → no warning
    //   - Entity that inherits a primary identity   → no warning
    //     (uses effective children — includeParentData=true — for the identity
    //      lookup so an extends-an-abstract-base-with-identity entity is silent)
    //   - object.value or object.base subtypes      → no warning
    //
    // Warning text is byte-identical to the TS/C# / Python ports:
    //   entity object '<shortName>' has no primary identity
    //   (add an identity child or mark @isAbstract: true)
    // =========================================================================

    /**
     * Walk every {@code object.entity} in the tree and record a non-fatal warning
     * for any concrete one (i.e. not {@code @isAbstract: true}) that has at least
     * one field child but no primary identity (own or inherited).
     *
     * @param root the root node to walk
     * @param loader the loader to receive warnings; may be {@code null} (then this
     *               pass is a no-op — there is nowhere to record findings)
     */
    static void validateEntityHasPrimaryIdentity(MetaRoot root, MetaDataLoader loader) {
        if (loader == null) return;
        walkEntityIdentityCheck(root, loader);
    }

    private static void walkEntityIdentityCheck(MetaData node, MetaDataLoader loader) {
        if (node instanceof MetaObject) {
            checkObjectIdentity((MetaObject) node, loader);
        }
        // Recurse into own children only (matches the walk style used elsewhere
        // in this class — inherited nodes are validated on their declaring node).
        for (MetaData child : node.getChildren(MetaData.class, false)) {
            walkEntityIdentityCheck(child, loader);
        }
    }

    private static void checkObjectIdentity(MetaObject obj, MetaDataLoader loader) {
        // Only entity-subtype objects warrant the warning.
        if (!MetaObject.SUBTYPE_ENTITY.equals(obj.getSubType())) {
            return;
        }
        // Abstract entities are templates / supers — no warning.
        if (isAbstract(obj)) {
            return;
        }

        // Effective children (includeParentData=true) so an entity that extends
        // an abstract base providing the identity does NOT warn — matches the
        // TS/C# behaviour of `model.children()` in their walks.
        List<MetaData> effective = obj.getChildren(MetaData.class, true);

        for (MetaData child : effective) {
            if (MetaIdentity.TYPE_IDENTITY.equals(child.getType())
                    && MetaIdentity.SUBTYPE_PRIMARY.equals(child.getSubType())) {
                return; // has a primary identity (own or inherited) — no warning
            }
        }
        // Concrete entity, no primary identity (own or inherited) — warn.
        // Matches TS subtype-rules / C# ValidationPasses (no "has any field" guard).

        // Bare entity name (no package prefix) — matches what other ports emit
        // (TS / C# fqn() falls back to name when no own package is set on the
        // entity node, since `package` lives on metadata.root).
        String shortName = obj.getShortName();
        if (shortName == null || shortName.isEmpty()) {
            shortName = obj.getName();
        }

        loader.addWarning(
            "entity object '" + shortName + "' has no primary identity "
                + "(add an identity child or mark @isAbstract: true)");
    }

    // =========================================================================
    // Identity @fields (required) + @generation (enum) validation
    //
    // The unified registry exposes withEnum() but the runtime doesn't currently
    // walk those constraints post-load (only validators with side-effect passes
    // do). For cross-port parity (TS / C# both throw on these shapes) we run a
    // dedicated pass here.
    //
    //   @fields  is required on every identity.* node → ERR_MISSING_REQUIRED_ATTR
    //   @generation, if present, must be one of increment / uuid / assigned →
    //       ERR_BAD_ATTR_VALUE
    // =========================================================================

    static void validateIdentityFieldsAndGeneration(MetaRoot root) {
        walkIdentityFieldsAndGeneration(root);
    }

    private static void walkIdentityFieldsAndGeneration(MetaData node) {
        if (node instanceof MetaIdentity) {
            validateIdentityNode((MetaIdentity) node);
        }
        for (MetaData child : node.getChildren(MetaData.class, false)) {
            walkIdentityFieldsAndGeneration(child);
        }
    }

    private static final java.util.Set<String> VALID_IDENTITY_GENERATIONS =
        java.util.Set.of("increment", "uuid", "assigned");

    private static void validateIdentityNode(MetaIdentity identity) {
        if (!identity.hasMetaAttr(MetaIdentity.ATTR_FIELDS, false)) {
            throw new MetaDataException(
                ErrorMessageConstants.ERR_MISSING_REQUIRED_ATTR
                    + ": identity '" + identity.getName()
                    + "' is missing required @fields attribute",
                ErrorCode.ERR_MISSING_REQUIRED_ATTR, identity.getSource());
        }
        if (identity.hasMetaAttr(MetaIdentity.ATTR_GENERATION, false)) {
            Object v = identity.getMetaAttr(MetaIdentity.ATTR_GENERATION, false).getValue();
            String gen = v == null ? null : v.toString();
            if (gen != null && !VALID_IDENTITY_GENERATIONS.contains(gen)) {
                throw new MetaDataException(
                    ErrorMessageConstants.ERR_BAD_ATTR_VALUE
                        + ": identity '" + identity.getName()
                        + "' @generation '" + gen + "' is not a valid value;"
                        + " allowed: increment, uuid, assigned",
                    ErrorCode.ERR_BAD_ATTR_VALUE, identity.getSource());
            }
        }
    }

    // =========================================================================
    // layout.dataGrid validation
    //
    //   @defaultSortField must name a real field on the owning entity
    //       → ERR_BAD_DEFAULT_SORT_FIELD
    //   @filter keys must reference fields declared @filterable: true
    //       → ERR_BAD_ATTR_FILTER
    //   @filter ops must be compatible with the target field's subtype
    //       → ERR_BAD_ATTR_FILTER (boolean only supports eq/ne/isNull;
    //         numeric/date support equality + ordering; string supports
    //         equality + like + isNull + in)
    //
    // Cross-port: mirrors TS validation-passes.ts (validateDataGridLayout).
    // =========================================================================

    private static final String ATTR_FILTERABLE = "filterable";
    private static final String ATTR_DB_INDEXED = "db.indexed";

    private static final java.util.Set<String> OPS_FOR_BOOLEAN =
        java.util.Set.of("eq", "ne", "isNull");
    private static final java.util.Set<String> OPS_FOR_NUMERIC =
        java.util.Set.of("eq", "ne", "gt", "gte", "lt", "lte", "in", "isNull");
    private static final java.util.Set<String> OPS_FOR_DATE =
        java.util.Set.of("eq", "ne", "gt", "gte", "lt", "lte", "in", "isNull");
    private static final java.util.Set<String> OPS_FOR_STRING =
        java.util.Set.of("eq", "ne", "in", "like", "isNull");

    static void validateDataGridLayouts(MetaRoot root) {
        for (MetaData rootChild : root.getChildren(MetaData.class, false)) {
            if (rootChild instanceof MetaObject) {
                MetaObject obj = (MetaObject) rootChild;
                for (MetaData c : obj.getChildren(MetaData.class, false)) {
                    if (c instanceof DataGridLayout) {
                        validateDataGridLayout(obj, (DataGridLayout) c);
                    }
                }
            }
        }
    }

    private static void validateDataGridLayout(MetaObject obj, DataGridLayout grid) {
        java.util.Map<String, MetaField> fieldsByName = new java.util.HashMap<>();
        java.util.Set<String> filterable = new java.util.HashSet<>();
        for (MetaField f : obj.getChildren(MetaField.class, true)) {
            fieldsByName.put(f.getShortName(), f);
            if (f.hasMetaAttr(ATTR_FILTERABLE, false)) {
                Object v = f.getMetaAttr(ATTR_FILTERABLE, false).getValue();
                boolean isFilterable =
                    (v instanceof Boolean) ? (Boolean) v
                    : (v instanceof String) ? "true".equalsIgnoreCase((String) v)
                    : false;
                if (isFilterable) filterable.add(f.getShortName());
            }
        }

        // @defaultSortField
        if (grid.hasMetaAttr(DataGridLayout.ATTR_DEFAULT_SORT_FIELD, false)) {
            Object v = grid.getMetaAttr(DataGridLayout.ATTR_DEFAULT_SORT_FIELD, false).getValue();
            String sortField = v == null ? null : v.toString();
            if (sortField != null && !sortField.isEmpty() && !fieldsByName.containsKey(sortField)) {
                throw new MetaDataException(
                    ErrorMessageConstants.ERR_BAD_DEFAULT_SORT_FIELD
                        + ": layout.dataGrid '" + grid.getShortName()
                        + "' on '" + obj.getShortName()
                        + "' @defaultSortField '" + sortField + "' does not reference a real field",
                    ErrorCode.ERR_BAD_DEFAULT_SORT_FIELD, grid.getSource());
            }
        }

        // @filter
        if (grid.hasMetaAttr(DataGridLayout.ATTR_FILTER, false)) {
            Object raw = grid.getMetaAttr(DataGridLayout.ATTR_FILTER, false).getValue();
            if (raw instanceof java.util.Map) {
                validateFilterClause(obj, grid, (java.util.Map<?, ?>) raw, fieldsByName, filterable);
            }
        }
    }

    @SuppressWarnings("unchecked")
    private static void validateFilterClause(MetaObject obj, DataGridLayout grid,
                                              java.util.Map<?, ?> filter,
                                              java.util.Map<String, MetaField> fieldsByName,
                                              java.util.Set<String> filterable) {
        for (java.util.Map.Entry<?, ?> e : filter.entrySet()) {
            String key = e.getKey() == null ? "" : e.getKey().toString();
            if ("and".equals(key) || "or".equals(key)) {
                if (e.getValue() instanceof Iterable) {
                    for (Object sub : (Iterable<?>) e.getValue()) {
                        if (sub instanceof java.util.Map) {
                            validateFilterClause(obj, grid, (java.util.Map<?, ?>) sub,
                                fieldsByName, filterable);
                        }
                    }
                }
                continue;
            }
            MetaField field = fieldsByName.get(key);
            if (field == null || !filterable.contains(key)) {
                throw new MetaDataException(
                    ErrorMessageConstants.ERR_BAD_ATTR_FILTER
                        + ": layout.dataGrid '" + grid.getShortName()
                        + "' on '" + obj.getShortName()
                        + "' @filter references '" + key + "' which is not a @filterable field",
                    ErrorCode.ERR_BAD_ATTR_FILTER, grid.getSource());
            }
            if (e.getValue() instanceof java.util.Map) {
                java.util.Set<String> allowed = allowedOpsFor(field);
                for (Object opKey : ((java.util.Map<?, ?>) e.getValue()).keySet()) {
                    String op = opKey == null ? "" : opKey.toString();
                    if (!allowed.contains(op)) {
                        throw new MetaDataException(
                            ErrorMessageConstants.ERR_BAD_ATTR_FILTER
                                + ": layout.dataGrid '" + grid.getShortName()
                                + "' on '" + obj.getShortName()
                                + "' @filter op '" + op + "' is not valid for field '" + key
                                + "' (subtype " + field.getSubType() + "); allowed: " + allowed,
                            ErrorCode.ERR_BAD_ATTR_FILTER, grid.getSource());
                    }
                }
            }
        }
    }

    private static java.util.Set<String> allowedOpsFor(MetaField field) {
        String st = field.getSubType();
        if (BooleanField.SUBTYPE_BOOLEAN.equals(st)) return OPS_FOR_BOOLEAN;
        if (DateField.SUBTYPE_DATE.equals(st)
                || TimeField.SUBTYPE_TIME.equals(st)
                || TimestampField.SUBTYPE_TIMESTAMP.equals(st)) {
            return OPS_FOR_DATE;
        }
        if (IntegerField.SUBTYPE_INT.equals(st)
                || LongField.SUBTYPE_LONG.equals(st)
                || DoubleField.SUBTYPE_DOUBLE.equals(st)
                || FloatField.SUBTYPE_FLOAT.equals(st)
                || DecimalField.SUBTYPE_DECIMAL.equals(st)
                || CurrencyField.SUBTYPE_CURRENCY.equals(st)) {
            return OPS_FOR_NUMERIC;
        }
        // string / enum / others fall through to string-shape ops.
        return OPS_FOR_STRING;
    }

    // =========================================================================
     // @filterable without backing index — warning pass
    //
    // Mirrors TS validation-passes.ts (filterable-without-index). For every
    // field carrying @filterable: true that is NOT a member of any identity
    // on its owning object (primary or secondary), emit a warning. Authors
    // should either remove @filterable or add a backing index (a secondary
    // identity / @db.indexed).
    //
    // Warning text MUST match the cross-port string exactly so fixtures'
    // expected-warnings.json compare byte-equal.
    // =========================================================================

    static void warnFilterableWithoutIndex(MetaRoot root, MetaDataLoader loader) {
        if (loader == null) return;
        for (MetaData rootChild : root.getChildren(MetaData.class, false)) {
            if (rootChild instanceof MetaObject) {
                checkFilterableFields((MetaObject) rootChild, loader);
            }
        }
    }

    private static void checkFilterableFields(MetaObject obj, MetaDataLoader loader) {
        // Use effective (includes inherited via extends:/super:) so a child
        // entity inheriting a @filterable field via BaseEntity is also gated.
        // Mirrors TS validation-passes.ts:140 (`const effective = obj.children()`).
        List<MetaField> fields = obj.getChildren(MetaField.class, true);
        java.util.Set<String> indexed = new java.util.HashSet<>();
        for (MetaData child : obj.getChildren(MetaData.class, true)) {
            if (!(child instanceof MetaIdentity)) continue;
            MetaIdentity identity = (MetaIdentity) child;
            if (!identity.hasMetaAttr(MetaIdentity.ATTR_FIELDS, false)) continue;
            Object raw = identity.getMetaAttr(MetaIdentity.ATTR_FIELDS, false).getValue();
            collectIdentityFields(raw, indexed);
        }

        for (MetaField field : fields) {
            if (!field.hasMetaAttr(ATTR_FILTERABLE, false)) continue;
            Object v = field.getMetaAttr(ATTR_FILTERABLE, false).getValue();
            boolean filterable =
                (v instanceof Boolean) ? (Boolean) v
                : (v instanceof String) ? "true".equalsIgnoreCase((String) v)
                : false;
            if (!filterable) continue;
            // @db.indexed: true is an explicit escape hatch — author asserts a
            // backing index exists (or will, when supported). Mirrors TS
            // validation-passes.ts:155.
            if (field.hasMetaAttr(ATTR_DB_INDEXED, false)) {
                Object iv = field.getMetaAttr(ATTR_DB_INDEXED, false).getValue();
                boolean dbIndexed =
                    (iv instanceof Boolean) ? (Boolean) iv
                    : (iv instanceof String) ? "true".equalsIgnoreCase((String) iv)
                    : false;
                if (dbIndexed) continue;
            }
            if (indexed.contains(field.getShortName())) continue;
            String objName = obj.getShortName() != null ? obj.getShortName() : obj.getName();
            loader.addWarning(
                "[filterable-without-index] field \"" + objName + "." + field.getShortName()
                    + "\" has @filterable: true but is not part of any identity."
                    + " Filtering on this field will sequential-scan."
                    + " Add @db.indexed: true to the field (when supported),"
                    + " or remove @filterable: true.");
        }
    }

    private static void collectIdentityFields(Object raw, java.util.Set<String> out) {
        if (raw == null) return;
        if (raw instanceof String) {
            for (String s : ((String) raw).split(",")) {
                String t = s.trim();
                if (!t.isEmpty()) out.add(t);
            }
        } else if (raw instanceof Iterable<?>) {
            for (Object o : (Iterable<?>) raw) {
                if (o != null) out.add(o.toString());
            }
        }
    }

    /**
     * True if the node has an own {@code @isAbstract} attribute set to
     * boolean-true. Reads only the own attribute (not effective) — matches the
     * own-only validation contract used throughout this class.
     */
    private static boolean isAbstract(MetaData node) {
        if (!node.hasMetaAttr(MetaData.ATTR_IS_ABSTRACT, false)) {
            return false;
        }
        Object v = node.getMetaAttr(MetaData.ATTR_IS_ABSTRACT, false).getValue();
        if (v instanceof Boolean) return (Boolean) v;
        if (v instanceof String) return "true".equalsIgnoreCase((String) v);
        return false;
    }

    // =========================================================================
    // Template validation (FR-004 — cross-language prompt construction)
    //
    // Two rules, own-only, eager-throw — mirrors TS validateTemplates and
    // C# TemplateValidator. Required-attr enforcement (formerly R1 for
    // template.prompt's @payloadRef and R1b for template.toolcall's @toolName +
    // @payloadRef) now lives in the generic validateRequiredAttrs pass above.
    //
    //   R2: @payloadRef (if present on any template) must resolve to an
    //       object.value at root → ERR_INVALID_TEMPLATE
    //   R3: template.prompt @requiredSlots members must each be a field on the
    //       resolved payload VO → ERR_INVALID_TEMPLATE
    //   R4: @format (if present) must be a member of TemplateConstants.ALLOWED_FORMATS
    //       → ERR_BAD_ATTR_VALUE
    //
    // Templates always live at the document root. We walk root children only.
    // =========================================================================

    /**
     * Validate every {@code template.*} child of the root.
     *
     * @param root the fully-loaded root
     * @throws MetaDataException on the first template validation failure
     */
    static void validateTemplates(MetaRoot root) {
        for (MetaData child : root.getChildren(MetaData.class, false)) {
            if (!(child instanceof MetaTemplate)) continue;
            validateTemplateNode(root, (MetaTemplate) child);
        }
    }

    private static void validateTemplateNode(MetaRoot root, MetaTemplate template) {
        String subType = template.getSubType();
        String payloadRef = template.getPayloadRef();

        // R4 — @format (if present) must be in the closed allowed set
        // (text|html|xml|csv|json|markdown|spreadsheet). Own-only — absent is fine.
        if (template.hasMetaAttr(TemplateConstants.ATTR_FORMAT, false)) {
            String fmt = template.getMetaAttr(TemplateConstants.ATTR_FORMAT, false).getValueAsString();
            if (fmt != null && !TemplateConstants.ALLOWED_FORMATS.contains(fmt)) {
                throw new MetaDataException(
                    ErrorMessageConstants.ERR_BAD_ATTR_VALUE
                        + ": template '" + template.getName()
                        + "' @format '" + fmt
                        + "' is not a valid value; allowed: "
                        + TemplateConstants.ALLOWED_FORMATS,
                    ErrorCode.ERR_BAD_ATTR_VALUE, template.getSource());
            }
        }

        // R5 — @promptStyle (template.output only, FR-010) must be in the closed
        // set (guide|inline|exampleOnly). Own-only — absent is fine; default is "guide".
        if (template.hasMetaAttr(TemplateConstants.ATTR_PROMPT_STYLE, false)) {
            String style = template.getMetaAttr(TemplateConstants.ATTR_PROMPT_STYLE, false)
                                   .getValueAsString();
            if (style != null && !TemplateConstants.ALLOWED_PROMPT_STYLES.contains(style)) {
                throw new MetaDataException(
                    ErrorMessageConstants.ERR_BAD_ATTR_VALUE
                        + ": template '" + template.getName()
                        + "' @promptStyle '" + style
                        + "' is not a valid value; allowed: "
                        + TemplateConstants.ALLOWED_PROMPT_STYLES,
                    ErrorCode.ERR_BAD_ATTR_VALUE, template.getSource());
            }
        }

        // R2 + R3 only apply if @payloadRef is set. Missing @payloadRef on
        // subtypes that require it (template.prompt, template.toolcall) has
        // already been caught by validateRequiredAttrs above; if we get here
        // with payloadRef==null, the node's schema treats it as optional
        // (e.g. template.output may carry no payloadRef — TS marks it required
        // on output too but Java's base declares it optional and no override
        // has been added on the output subtype). Skip R2/R3 silently.
        if (payloadRef == null || payloadRef.isEmpty()) return;

        MetaObject payloadVo = findRootObject(root, payloadRef);
        if (payloadVo == null || !MetaObject.SUBTYPE_VALUE.equals(payloadVo.getSubType())) {
            // FR5d — @payloadRef is a reference; emit format=resolved with
            // referrer=template bare (short) name to match TS/C#/Python (the
            // reference contract does not propagate the root `package:` to
            // root-level objects); target=the unresolved payloadRef string.
            throw new MetaDataException(
                ErrorMessageConstants.ERR_INVALID_TEMPLATE
                    + ": template '" + template.getName() + "' @payloadRef '" + payloadRef
                    + "' does not resolve to an object.value at root",
                ErrorCode.ERR_INVALID_TEMPLATE,
                ResolvedSource.from(template.getSource(), template.getShortName(), payloadRef));
        }

        // R3 — every @requiredSlots member must be a field on the payload VO
        if (!(template instanceof PromptTemplate prompt)) return;
        List<String> required = prompt.getRequiredSlots();
        if (required == null || required.isEmpty()) return;

        Set<String> available = collectPayloadFieldNames(payloadVo);
        for (String slot : required) {
            if (slot == null || slot.isEmpty()) continue;
            if (!available.contains(slot)) {
                // FR5d — @requiredSlots is a field-on-payload reference; emit
                // format=resolved with referrer=template bare (short) name to
                // match TS/C#/Python; target=`payloadRef.slot` (the dotted ref
                // that did not resolve to a payload field).
                throw new MetaDataException(
                    ErrorMessageConstants.ERR_INVALID_TEMPLATE
                        + ": template.prompt '" + template.getName()
                        + "' @requiredSlots includes '" + slot
                        + "' which is not a field on payload '" + payloadRef + "'",
                    ErrorCode.ERR_INVALID_TEMPLATE,
                    ResolvedSource.from(template.getSource(), template.getShortName(),
                        payloadRef + "." + slot));
            }
        }
    }

    /**
     * Collect the short names of every {@code field.*} child of a payload VO.
     * Walks effective children (includeParentData=true) so an extends-based
     * payload contributes inherited fields too.
     */
    private static Set<String> collectPayloadFieldNames(MetaObject payloadVo) {
        Set<String> out = new HashSet<>();
        for (MetaData child : payloadVo.getChildren(MetaData.class, true)) {
            if (child instanceof MetaField) out.add(shortNameOf(child));
        }
        return out;
    }

    /**
     * Validate a dotted "Entity.field" reference (used by passthrough's @from
     * and aggregate's @of). The entity must exist at the root, and the field
     * must exist on that entity (inherited fields are included via the standard
     * children() traversal).
     *
     * <p>FR5d: emits {@code format=resolved} envelopes for every throw. The
     * referrer FQN format is {@code "<projection-FQN>::<fieldName>"} (mirrors
     * the TS {@code _validateFromPath} contract); the target is the bad ref
     * string itself.</p>
     *
     * @param projection the projection node that owns the field carrying the origin
     */
    private static void validateFromOrOfPath(String pathAttr, MetaRoot root,
                                             MetaObject projection, String fieldName,
                                             String label,
                                             com.metaobjects.source.ErrorSource envelope) {
        // FR5d — referrer is `<projection-bare-name>::<fieldName>` (the canonical
        // "where the broken reference lives" identifier). Matches TS/C#/Python:
        // the reference contract does not propagate the root `package:` to
        // root-level objects, so the bare entity name is used.
        String projectionName = projection.getName();
        String referrer = projection.getShortName() + "::" + fieldName;
        int dotIdx = pathAttr.indexOf('.');
        if (dotIdx < 1 || dotIdx == pathAttr.length() - 1) {
            // Malformed shape (not "Entity.field") — not a reference resolution
            // failure per se, but emit format=resolved with target=the bad string
            // so consumers see the same envelope shape across all FR5d sites.
            throw new MetaDataException(
                ErrorMessageConstants.ERR_INVALID_ORIGIN
                    + ": " + label + " \"" + pathAttr + "\" on "
                    + projectionName + "." + fieldName
                    + ": must be of form \"Entity.field\".",
                ErrorCode.ERR_INVALID_ORIGIN,
                ResolvedSource.from(envelope, referrer, pathAttr));
        }
        String entityName = pathAttr.substring(0, dotIdx);
        String targetFieldName = pathAttr.substring(dotIdx + 1);

        MetaObject sourceObj = findRootObject(root, entityName);
        if (sourceObj == null) {
            // FR5d — entity half of the ref didn't resolve. target = full ref.
            throw new MetaDataException(
                ErrorMessageConstants.ERR_INVALID_ORIGIN
                    + ": " + label + " \"" + pathAttr + "\" on "
                    + projectionName + "." + fieldName
                    + ": no such entity \"" + entityName + "\".",
                ErrorCode.ERR_INVALID_ORIGIN,
                ResolvedSource.from(envelope, referrer, pathAttr));
        }

        // Inherited fields included — getChildren(..., true) walks super data.
        boolean fieldExists = false;
        for (MetaData child : sourceObj.getChildren(MetaData.class, true)) {
            if (child instanceof MetaField && nameMatches(child, targetFieldName)) {
                fieldExists = true;
                break;
            }
        }
        if (!fieldExists) {
            // FR5d — entity resolved, field on it did not. target = full ref.
            throw new MetaDataException(
                ErrorMessageConstants.ERR_INVALID_ORIGIN
                    + ": " + label + " \"" + pathAttr + "\" on "
                    + projectionName + "." + fieldName
                    + ": no such field \"" + targetFieldName
                    + "\" on " + entityName + ".",
                ErrorCode.ERR_INVALID_ORIGIN,
                ResolvedSource.from(envelope, referrer, pathAttr));
        }
    }

    /**
     * Validate a dotted relationship path of the form
     * {@code "Entity.relationship[.relationship...]"}. The leading entity must
     * exist at root; each relationship segment must exist on the current entity
     * and carry a {@code @objectRef} that resolves to another entity at root,
     * which becomes the next hop's current entity.
     */
    private static void validateViaPath(String viaAttr, MetaRoot root,
                                        MetaObject projection, String fieldName,
                                        com.metaobjects.source.ErrorSource envelope) {
        // FR5d — referrer is `<projection-bare-name>::<fieldName>` (matches
        // TS/C#/Python: bare entity name, not package-qualified).
        String projectionName = projection.getName();
        String referrer = projection.getShortName() + "::" + fieldName;
        String[] segments = viaAttr.split("\\.");
        if (segments.length < 2) {
            throw new MetaDataException(
                ErrorMessageConstants.ERR_INVALID_ORIGIN
                    + ": origin.@via \"" + viaAttr + "\" on "
                    + projectionName + "." + fieldName
                    + ": must be of form \"Entity.relationship[.relationship...]\".",
                ErrorCode.ERR_INVALID_ORIGIN,
                ResolvedSource.from(envelope, referrer, viaAttr));
        }
        String entityName = segments[0];
        MetaObject currentObj = findRootObject(root, entityName);
        if (currentObj == null) {
            throw new MetaDataException(
                ErrorMessageConstants.ERR_INVALID_ORIGIN
                    + ": origin.@via \"" + viaAttr + "\" on "
                    + projectionName + "." + fieldName
                    + ": no such entity \"" + entityName + "\".",
                ErrorCode.ERR_INVALID_ORIGIN,
                ResolvedSource.from(envelope, referrer, viaAttr));
        }
        // FR5d — track the deepest-valid-prefix as we walk. The prefix grows
        // segment-by-segment; on a hop failure the error message names the prefix
        // that DID resolve, so authors can fix multi-hop typos quickly. After the
        // entity lookup above, the deepest valid prefix is just the entity name;
        // each successful relationship hop appends a segment.
        java.util.List<String> validSegments = new java.util.ArrayList<>();
        validSegments.add(entityName);
        for (int i = 1; i < segments.length; i++) {
            String relName = segments[i];
            MetaRelationship rel = findRelationship(currentObj, relName);
            if (rel == null) {
                String prefix = String.join(".", validSegments);
                throw new MetaDataException(
                    ErrorMessageConstants.ERR_INVALID_ORIGIN
                        + ": origin.@via \"" + viaAttr + "\" on "
                        + projectionName + "." + fieldName
                        + ": no such relationship \"" + relName
                        + "\" on " + currentObj.getName() + ". "
                        + "Deepest valid prefix was \"" + prefix + "\".",
                    ErrorCode.ERR_INVALID_ORIGIN,
                    ResolvedSource.from(envelope, referrer, viaAttr));
            }
            String refTarget = rel.hasMetaAttr(MetaRelationship.ATTR_OBJECT_REF)
                ? rel.getMetaAttr(MetaRelationship.ATTR_OBJECT_REF).getValueAsString()
                : null;
            if (refTarget == null || refTarget.isEmpty()) {
                throw new MetaDataException(
                    ErrorMessageConstants.ERR_INVALID_ORIGIN
                        + ": origin.@via \"" + viaAttr + "\" on "
                        + projectionName + "." + fieldName
                        + ": relationship \"" + relName + "\" on "
                        + currentObj.getName() + " is missing @objectRef.",
                    ErrorCode.ERR_INVALID_ORIGIN,
                    ResolvedSource.from(envelope, referrer, viaAttr));
            }
            MetaObject nextObj = findRootObject(root, refTarget);
            if (nextObj == null) {
                // FR5d — relationship's @objectRef points at a missing entity. This
                // is the @objectRef-resolution edge of the via-path walk (the "5th
                // site" in FR5d's scope list for @objectRef references encountered
                // transitively). Target = the @objectRef value (the missing entity name).
                throw new MetaDataException(
                    ErrorMessageConstants.ERR_INVALID_ORIGIN
                        + ": origin.@via \"" + viaAttr + "\" on "
                        + projectionName + "." + fieldName
                        + ": relationship \"" + relName
                        + "\" points to non-existent entity \"" + refTarget + "\".",
                    ErrorCode.ERR_INVALID_ORIGIN,
                    ResolvedSource.from(envelope, referrer, refTarget));
            }
            validSegments.add(relName);
            currentObj = nextObj;
        }
    }

    /**
     * Find a top-level MetaObject child of the root whose bare entity name
     * matches. Origin reference paths ({@code @from}, {@code @of}, {@code @via})
     * use bare entity names (e.g. {@code "Program.title"}, not
     * {@code "acme::commerce::Program.title"}), so we compare against the
     * package-stripped short name. Falls back to a tail-segment compare on the
     * full name in case getShortName() is unset on some path.
     */
    private static MetaObject findRootObject(MetaRoot root, String name) {
        for (MetaData child : root.getChildren(MetaData.class, false)) {
            if (child instanceof MetaObject && nameMatches(child, name)) {
                return (MetaObject) child;
            }
        }
        return null;
    }

    /**
     * Find a relationship child on an object by name. Walks inherited children
     * (relationships declared on supers are visible to projections that extend
     * the base entity).
     *
     * <p>Matches by getShortName() with a tail-segment fallback (consistent with
     * {@link #findRootObject}), since relationships may be stored with the
     * package prefix attached to {@code getName()}.</p>
     */
    private static MetaRelationship findRelationship(MetaObject obj, String name) {
        for (MetaData child : obj.getChildren(MetaData.class, true)) {
            if (!(child instanceof MetaRelationship)) continue;
            if (nameMatches(child, name)) {
                return (MetaRelationship) child;
            }
        }
        return null;
    }

    /**
     * True if {@code child}'s bare name matches {@code name}. Compares against
     * {@code getShortName()} first, then falls back to deriving the tail
     * segment from {@code getName()} (after the last {@code "::"}).
     */
    private static boolean nameMatches(MetaData child, String name) {
        String bare = shortNameOf(child);
        return bare != null && name.equals(bare);
    }

    /**
     * Bare name for {@code child}: prefers {@code getShortName()}, falls back
     * to the tail segment of {@code getName()} (after the last {@code "::"}).
     * Returns {@code null} only when both are unavailable.
     */
    private static String shortNameOf(MetaData child) {
        String shortName = child.getShortName();
        if (shortName != null && !shortName.isEmpty()) return shortName;
        String full = child.getName();
        if (full == null) return null;
        int idx = full.lastIndexOf(MetaData.PKG_SEPARATOR);
        return (idx >= 0) ? full.substring(idx + MetaData.PKG_SEPARATOR.length()) : full;
    }

}

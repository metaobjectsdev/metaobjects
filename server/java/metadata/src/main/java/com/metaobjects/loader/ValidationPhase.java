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
package com.metaobjects.loader;

import com.metaobjects.ErrorCode;
import com.metaobjects.MetaData;
import com.metaobjects.MetaDataException;
import com.metaobjects.MetaRoot;
import com.metaobjects.attr.MetaAttribute;
import com.metaobjects.database.CoreDBMetaDataProvider;
import com.metaobjects.field.BooleanField;
import com.metaobjects.field.CurrencyField;
import com.metaobjects.field.DecimalField;
import com.metaobjects.field.DoubleField;
import com.metaobjects.field.EnumField;
import com.metaobjects.field.FloatField;
import com.metaobjects.field.IntegerField;
import com.metaobjects.field.LongField;
import com.metaobjects.field.MetaField;
import com.metaobjects.field.ObjectField;
import com.metaobjects.field.StringField;
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
import com.metaobjects.source.RdbSource;
import com.metaobjects.source.LoaderWarning;
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
        // Generic singleton-cardinality pass: any parent declaring more children
        // of a registered maxOccurs==1 type.subType than allowed fires
        // ERR_TOO_MANY_OCCURRENCES (e.g. two identity.primary on one object).
        validateMaxOccurs(root, loader);
        validateEnumValues(root);
        validateFieldDefaults(root);
        validateDbColumnType(root);
        validateSourceAttrs(root);
        validateSourcePhysicalNames(root, loader);
        // FR-013 — field-level @readOnly cross-attribute rules.
        validateFieldReadOnly(root, loader);
        // FR-014 — TPH discriminator cross-attribute rules.
        validateDiscriminator(root);
        // FR-015 — source.rdb @parameterRef typed-input rules.
        validateSourceParameterRef(root);
        validateOnePrimarySource(root);
        validateRelationshipReferentialActions(root);
        validateRelationshipsM2M(root);
        // Phase 2 — validation DERIVED FROM THE TYPE REGISTRY: each node's TypeDefinition
        // carries its reference descriptors + imperative validator (relationship @objectRef,
        // identity.reference @references for core; a downstream provider's type carries its
        // own). One recursive walk over a built-once symbol table, collected then eager-
        // thrown (first error) to preserve cross-port behavior. Needs the registry, so it is
        // skipped on the legacy null-loader path (like validateRequiredAttrs/MaxOccurs).
        if (loader != null && loader.getTypeRegistry() != null) {
            java.util.List<com.metaobjects.validation.ValidationError> refErrors =
                com.metaobjects.loader.validation.RegisteredValidation.run(root, loader.getTypeRegistry());
            if (refErrors.size() == 1) {
                // Single finding: throw the plain exception (byte-identical to before — the
                // single-error conformance fixtures depend on this exact shape).
                com.metaobjects.validation.ValidationError e = refErrors.get(0);
                throw new MetaDataException(e.message(), ErrorCode.valueOf(e.code()), e.source());
            } else if (refErrors.size() > 1) {
                // Multiple findings: surface them ALL (drift UX). The aggregated exception
                // IS-A MetaDataException carrying the first error's code/envelope for back-compat.
                throw new com.metaobjects.validation.MetaDataValidationException(refErrors);
            }
        }
        validateOrigins(root);
        validateObjectFieldStorage(root);
        validateIdentityFieldsAndGeneration(root);
        validateDataGridLayouts(root);
        validateTemplates(root);
        validateEntityHasPrimaryIdentity(root, loader);
        validateFilterableHasSupportedOps(root);
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
    // Generic singleton-cardinality validation (maxOccurs)
    //
    // Walks every node and, per parent, groups its OWN children by (type, subType).
    // For each group whose registered TypeDefinition declares maxOccurs >= 1, a
    // count exceeding maxOccurs fires ERR_TOO_MANY_OCCURRENCES. This is the generic
    // enforcement backing the config-driven default-name rule: identity.primary
    // (maxOccurs==1, defaultName=="primary") is the first consumer — two name-less
    // primaries would both default to "primary" and collide, so the cardinality
    // cap catches it deterministically before the collision becomes silent.
    //
    // maxOccurs==0 means unbounded (the default) — skipped. Own-children only
    // (includeParentData=false), matching every other pass here. Loader nullness:
    // when the loader handle is absent (legacy two-arg entry), the registry is
    // unreachable, so this pass is a no-op (like validateRequiredAttrs).
    // =========================================================================

    static void validateMaxOccurs(MetaRoot root, MetaDataLoader loader) {
        if (loader == null) return;
        MetaDataRegistry registry = loader.getTypeRegistry();
        if (registry == null) return;
        walkMaxOccurs(root, registry);
    }

    private static void walkMaxOccurs(MetaData node, MetaDataRegistry registry) {
        validateMaxOccursNode(node, registry);
        for (MetaData child : node.getChildren(MetaData.class, false)) {
            walkMaxOccurs(child, registry);
        }
    }

    private static void validateMaxOccursNode(MetaData parent, MetaDataRegistry registry) {
        // Tally own children per (type.subType) in declaration order; the moment a
        // group exceeds its registered maxOccurs, throw against the OFFENDING child's
        // source so the cross-port envelope jsonPath points at that node (matching
        // the shared error fixture, which targets the second identity.primary).
        Map<String, Integer> counts = new java.util.HashMap<>();
        for (MetaData child : parent.getChildren(MetaData.class, false)) {
            String type = child.getType();
            String subType = child.getSubType();
            if (type == null || subType == null) continue;
            TypeDefinition def = registry.getTypeDefinition(type, subType);
            if (def == null) continue;
            int maxOccurs = def.getMaxOccurs();
            if (maxOccurs < 1) continue; // 0 = unbounded
            String key = type + "." + subType;
            int seen = counts.merge(key, 1, Integer::sum);
            if (seen > maxOccurs) {
                throw new MetaDataException(
                    ErrorMessageConstants.ERR_TOO_MANY_OCCURRENCES
                        + ": "
                        + (parent.getName() != null && !parent.getName().isEmpty()
                            ? "'" + parent.getName() + "' " : "")
                        + "declares more than " + maxOccurs + " " + key
                        + " child" + (maxOccurs == 1 ? "" : "ren")
                        + "; at most " + maxOccurs + " is allowed",
                    ErrorCode.ERR_TOO_MANY_OCCURRENCES, child.getSource());
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
    // Generalized @default per-type validation (Phase B)
    //
    // The @default attribute is registered on the field base (MetaField.ATTR_DEFAULT) so any
    // field subtype may declare it. Its string value must coerce to the field's type:
    //   - int / long / currency  → integer parse
    //   - double / float / decimal → number parse
    //   - boolean                → true|false (exact)
    //   - enum                   → member of @values (handled by validateEnumFr011Attrs)
    //   - string / date / time / others → any (no validation)
    // A violation emits ERR_BAD_ATTR_VALUE, mirroring the enum @default membership check.
    //
    // Own-only: validates @default declared on THIS node (includeParentData=false), matching
    // the @values / FR-011 own-attr passes.
    // =========================================================================

    static void validateFieldDefaults(MetaRoot root) {
        walkFieldDefaults(root);
    }

    private static void walkFieldDefaults(MetaData node) {
        validateFieldDefaultNode(node);
        for (MetaData child : node.getChildren(MetaData.class, false)) {
            walkFieldDefaults(child);
        }
    }

    private static void validateFieldDefaultNode(MetaData node) {
        if (!MetaField.TYPE_FIELD.equals(node.getType())) return;
        // Enum @default membership is validated by validateEnumFr011Attrs.
        if (EnumField.SUBTYPE_ENUM.equals(node.getSubType())) return;
        if (!node.hasMetaAttr(MetaField.ATTR_DEFAULT, false)) return;

        String def = node.getMetaAttr(MetaField.ATTR_DEFAULT, false).getValueAsString();
        if (def == null) return;

        String subType = node.getSubType();
        boolean ok;
        if (IntegerField.SUBTYPE_INT.equals(subType)
                || LongField.SUBTYPE_LONG.equals(subType)
                || CurrencyField.SUBTYPE_CURRENCY.equals(subType)) {
            ok = parsesAsLong(def);
        } else if (DoubleField.SUBTYPE_DOUBLE.equals(subType)
                || FloatField.SUBTYPE_FLOAT.equals(subType)
                || DecimalField.SUBTYPE_DECIMAL.equals(subType)) {
            ok = parsesAsFiniteNumber(def);
        } else if (BooleanField.SUBTYPE_BOOLEAN.equals(subType)) {
            ok = "true".equals(def) || "false".equals(def);
        } else {
            ok = true;   // string / date / time / object / others — any value allowed
        }

        if (!ok) {
            throw new MetaDataException(
                ErrorMessageConstants.ERR_BAD_ATTR_VALUE
                    + ": field." + subType + " '" + node.getName()
                    + "' @" + MetaField.ATTR_DEFAULT + " '" + def
                    + "' is not coercible to the field's type",
                ErrorCode.ERR_BAD_ATTR_VALUE, node.getSource());
        }
    }

    private static boolean parsesAsLong(String s) {
        String t = s.trim();
        try { Long.parseLong(t); return true; }
        catch (NumberFormatException e) {
            // accept a finite decimal that truncates to an integer value (matches the engine's
            // Coerce.scalar INT/LONG fallback)
            try { return Double.isFinite(Double.parseDouble(t)); }
            catch (NumberFormatException e2) { return false; }
        }
    }

    private static boolean parsesAsFiniteNumber(String s) {
        try { return Double.isFinite(Double.parseDouble(s.trim())); }
        catch (NumberFormatException e) { return false; }
    }

    // =========================================================================
    // @dbColumnType physical column-type validation (R6 Plan 2b, ADR-0013)
    //
    // Own-only: validates the @dbColumnType attribute declared on THIS field node
    // (not inherited), mirroring the field.enum @values pass. Two rules:
    //
    //   1. The value must be one of the closed set uuid|jsonb|timestamp_with_tz
    //      → ERR_BAD_ATTR_VALUE otherwise.
    //   2. The value's legal (subtype × dbColumnType) pairing must hold:
    //        uuid              → field.string
    //        jsonb             → field.string
    //        timestamp_with_tz → field.timestamp
    //      → ERR_BAD_ATTR_VALUE on an illegal pairing.
    //
    // The error message names the field, the value, and the legal set — matching
    // the field.enum ERR_BAD_ATTR_VALUE precedent. Cross-port: TS/C#/Python run
    // the identical own-only pairing check (the dbProvider validation in ADR-0013 §3).
    // =========================================================================

    static void validateDbColumnType(MetaRoot root) {
        walkDbColumnType(root);
    }

    private static void walkDbColumnType(MetaData node) {
        validateDbColumnTypeNode(node);
        for (MetaData child : node.getChildren(MetaData.class, false)) {
            walkDbColumnType(child);
        }
    }

    private static void validateDbColumnTypeNode(MetaData node) {
        if (!MetaField.TYPE_FIELD.equals(node.getType())) {
            return;
        }
        // Own-only: only validate @dbColumnType declared on this node.
        if (!node.hasMetaAttr(CoreDBMetaDataProvider.DB_COLUMN_TYPE, false)) {
            return;
        }
        String value = node.getMetaAttr(CoreDBMetaDataProvider.DB_COLUMN_TYPE, false)
                           .getValueAsString();

        // Rule 1: recognized value.
        if (value == null || !CoreDBMetaDataProvider.VALID_DB_COLUMN_TYPES.contains(value)) {
            throw new MetaDataException(
                ErrorMessageConstants.ERR_BAD_ATTR_VALUE
                    + ": field '" + node.getName()
                    + "' @" + CoreDBMetaDataProvider.DB_COLUMN_TYPE + " '" + value
                    + "' is not a valid value; allowed: "
                    + CoreDBMetaDataProvider.VALID_DB_COLUMN_TYPES,
                ErrorCode.ERR_BAD_ATTR_VALUE, node.getSource());
        }

        // Rule 2: legal (subtype × value) pairing.
        String subType = node.getSubType();
        String requiredSubType = switch (value) {
            case CoreDBMetaDataProvider.DB_COLUMN_TYPE_UUID,
                 CoreDBMetaDataProvider.DB_COLUMN_TYPE_JSONB -> StringField.SUBTYPE_STRING;
            case CoreDBMetaDataProvider.DB_COLUMN_TYPE_TIMESTAMP_TZ -> TimestampField.SUBTYPE_TIMESTAMP;
            default -> null; // unreachable — Rule 1 already rejected unknown values
        };
        if (requiredSubType != null && !requiredSubType.equals(subType)) {
            throw new MetaDataException(
                ErrorMessageConstants.ERR_BAD_ATTR_VALUE
                    + ": field '" + node.getName()
                    + "' @" + CoreDBMetaDataProvider.DB_COLUMN_TYPE + " '" + value
                    + "' is not valid on field." + subType
                    + " (requires field." + requiredSubType + "); allowed pairings: "
                    + "uuid→field.string, jsonb→field.string, timestamp_with_tz→field.timestamp",
                ErrorCode.ERR_BAD_ATTR_VALUE, node.getSource());
        }
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
    // FR-016 / ADR-0018 — per-kind physical-name alias validation
    //
    // Each source.rdb may declare at most one of @table / @view /
    // @materializedView / @proc / @function. The chosen alias must match the
    // source's @kind, with one pre-1.0 legacy exception: @table is also
    // accepted for non-table kinds (e.g. @kind: "storedProc" + @table:
    // "fn_x"), which emits WARN_LEGACY_PHYSICAL_NAME_ALIAS.
    //
    // Codes:
    //   ERR_PHYSICAL_NAME_MULTIPLE       — ≥2 kind-aware aliases on one source.
    //   ERR_PHYSICAL_NAME_KIND_MISMATCH  — alias other than @table set with non-matching @kind.
    //   WARN_LEGACY_PHYSICAL_NAME_ALIAS  — @table set with non-table @kind (legacy spelling).
    //   ERR_BAD_ATTR_VALUE               — explicit empty-string for any physical-name alias.
    // =========================================================================

    static void validateSourcePhysicalNames(MetaRoot root, MetaDataLoader loader) {
        for (MetaData rootChild : root.getChildren(MetaData.class, false)) {
            walkSourcePhysicalNames(rootChild, loader);
        }
    }

    private static void walkSourcePhysicalNames(MetaData node, MetaDataLoader loader) {
        if (node instanceof MetaObject) {
            validateObjectSourcePhysicalNames((MetaObject) node, loader);
        }
        for (MetaData child : node.getChildren(MetaData.class, false)) {
            walkSourcePhysicalNames(child, loader);
        }
    }

    private static void validateObjectSourcePhysicalNames(MetaObject obj, MetaDataLoader loader) {
        for (MetaData child : obj.getChildren(MetaData.class, false)) {
            if (!(child instanceof MetaSource)) continue;
            MetaSource source = (MetaSource) child;
            // Only source.rdb participates in the per-kind alias model.
            if (!com.metaobjects.source.RdbSource.SUBTYPE_RDB.equals(source.getSubType())) continue;

            // Empty-string check first — explicit "" is an authoring error
            // regardless of which alias was used. Runs before the multi/mismatch
            // checks so an explicit empty value can't slip through silently.
            for (String attr : MetaSource.ALL_PHYSICAL_NAME_ALIASES) {
                if (!source.hasMetaAttr(attr, false)) continue;
                String v = source.getMetaAttr(attr, false).getValueAsString();
                if (v != null && v.isEmpty()) {
                    throw new MetaDataException(
                        ErrorMessageConstants.ERR_BAD_ATTR_VALUE
                            + ": source.rdb on object \"" + obj.getName()
                            + "\" sets @" + attr
                            + " to an empty string; physical name attrs require a non-empty value",
                        ErrorCode.ERR_BAD_ATTR_VALUE, source.getSource());
                }
            }

            // Collect non-empty kind-aware aliases.
            java.util.List<String> setAliases = new java.util.ArrayList<>();
            for (String attr : MetaSource.ALL_PHYSICAL_NAME_ALIASES) {
                if (!source.hasMetaAttr(attr, false)) continue;
                String v = source.getMetaAttr(attr, false).getValueAsString();
                if (v != null && !v.isEmpty()) {
                    setAliases.add(attr);
                }
            }

            if (setAliases.size() > 1) {
                StringBuilder names = new StringBuilder();
                for (int i = 0; i < setAliases.size(); i++) {
                    if (i > 0) names.append(", ");
                    names.append("@").append(setAliases.get(i));
                }
                throw new MetaDataException(
                    ErrorMessageConstants.ERR_PHYSICAL_NAME_MULTIPLE
                        + ": source.rdb on object \"" + obj.getName()
                        + "\" declares multiple physical-name aliases ("
                        + names + "); set exactly one",
                    ErrorCode.ERR_PHYSICAL_NAME_MULTIPLE, source.getSource());
            }

            if (setAliases.isEmpty()) continue;

            String chosenAlias = setAliases.get(0);
            String expectedAlias = MetaSource.PHYSICAL_NAME_ATTR_BY_KIND.get(source.getEffectiveKind());

            if (chosenAlias.equals(expectedAlias)) continue;

            // Legacy: @table is permitted for non-table kinds with a warning.
            if (MetaSource.ATTR_TABLE.equals(chosenAlias)) {
                if (loader != null) {
                    String message = "source.rdb on object \"" + obj.getName()
                        + "\" uses @table with @kind: \"" + source.getEffectiveKind()
                        + "\"; prefer the kind-matching alias @" + expectedAlias + " (ADR-0018)";
                    loader.addEnvelopeWarning(new com.metaobjects.source.LoaderWarning(
                        ErrorMessageConstants.WARN_LEGACY_PHYSICAL_NAME_ALIAS,
                        message,
                        source.getSource()));
                }
                continue;
            }

            // Any other mismatch is a hard error.
            String kindForAlias = kindForAlias(chosenAlias);
            throw new MetaDataException(
                ErrorMessageConstants.ERR_PHYSICAL_NAME_KIND_MISMATCH
                    + ": source.rdb on object \"" + obj.getName()
                    + "\" uses @" + chosenAlias + " with @kind: \""
                    + source.getEffectiveKind() + "\"; @" + chosenAlias
                    + " is only valid for @kind: \"" + kindForAlias + "\"",
                ErrorCode.ERR_PHYSICAL_NAME_KIND_MISMATCH, source.getSource());
        }
    }

    private static String kindForAlias(String alias) {
        for (Map.Entry<String, String> e : MetaSource.PHYSICAL_NAME_ATTR_BY_KIND.entrySet()) {
            if (e.getValue().equals(alias)) return e.getKey();
        }
        return "(unknown)";
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
    // FR-017 — M:N relationship validation (slim vocabulary)
    //
    // Deferred-resolution validation (runs after all files load + extends:
    // resolution, like origin paths), enforcing the cross-port M:N contract.
    // Mirrors the TS validateRelationships pass exactly:
    //
    //   (a) @symmetric:true is valid only on a self-join (@objectRef == declaring
    //       entity). Otherwise ERR_BAD_ATTR_VALUE.
    //   (b) @symmetric and @sourceRefField are mutually exclusive → ERR_BAD_ATTR_VALUE.
    //   (c) When @through is present (M:N): the named entity must exist and declare
    //       exactly two identity.reference children; @sourceRefField (if present)
    //       must match one of those references' FK fields → ERR_INVALID_RELATIONSHIP.
    //   (d) @through / @sourceRefField / @symmetric are invalid on a non-M:N
    //       relationship (@cardinality != "many", or no @through) → ERR_INVALID_RELATIONSHIP.
    //
    // Own-relationships only: a relationship is validated on the entity that
    // declares it (matching the own-attrs policy of the other passes). Eager-throw
    // on the first violation, like the rest of this phase. The thrown source is the
    // relationship node's own JsonSource, so the cross-port envelope jsonPath points
    // at the relationship node — matching the shared error fixtures.
    // =========================================================================

    static void validateRelationshipsM2M(MetaRoot root) {
        for (MetaData rootChild : root.getChildren(MetaData.class, false)) {
            walkRelationshipsM2M(root, rootChild);
        }
    }

    private static void walkRelationshipsM2M(MetaRoot root, MetaData node) {
        if (node instanceof MetaObject) {
            validateObjectRelationshipsM2M(root, (MetaObject) node);
        }
        for (MetaData child : node.getChildren(MetaData.class, false)) {
            walkRelationshipsM2M(root, child);
        }
    }

    private static void validateObjectRelationshipsM2M(MetaRoot root, MetaObject obj) {
        for (MetaData child : obj.getChildren(MetaData.class, false)) {
            if (!(child instanceof MetaRelationship)) continue;
            MetaRelationship rel = (MetaRelationship) child;
            validateRelationshipM2MNode(root, obj, rel);
        }
    }

    private static void validateRelationshipM2MNode(MetaRoot root, MetaObject obj,
                                                    MetaRelationship rel) {
        String through = rel.hasMetaAttr(MetaRelationship.ATTR_THROUGH, false)
            ? rel.getMetaAttr(MetaRelationship.ATTR_THROUGH, false).getValueAsString() : null;
        String sourceRefField = rel.hasMetaAttr(MetaRelationship.ATTR_SOURCE_REF_FIELD, false)
            ? rel.getMetaAttr(MetaRelationship.ATTR_SOURCE_REF_FIELD, false).getValueAsString() : null;
        boolean symmetric = rel.isSymmetric();
        String objectRef = rel.getObjectRef();
        // getCardinality() defaults to "one" when absent — matches the TS isMany check.
        String cardinality = rel.getCardinality();

        boolean hasThrough = through != null && !through.isEmpty();
        boolean hasSourceRefField = sourceRefField != null && !sourceRefField.isEmpty();
        boolean isMany = MetaRelationship.CARDINALITY_MANY.equals(cardinality);
        boolean isM2M = hasThrough && isMany;

        // NOTE: @objectRef existence resolution moved to the validation registry
        // (RegisteredValidation.defaultRegistry → a declarative reference descriptor).
        // The M:N slim-vocabulary rules below stay here for now (Phase 3 migrates them).

        // Rule (d): M:N-only attrs on a non-M:N relationship.
        if (!isM2M) {
            if (hasThrough) {
                throw new MetaDataException(
                    ErrorMessageConstants.ERR_INVALID_RELATIONSHIP
                        + ": relationship \"" + obj.getShortName() + "." + rel.getShortName()
                        + "\" sets @" + MetaRelationship.ATTR_THROUGH
                        + " but is not a M:N relationship (requires @"
                        + MetaRelationship.ATTR_CARDINALITY + ": \""
                        + MetaRelationship.CARDINALITY_MANY + "\").",
                    ErrorCode.ERR_INVALID_RELATIONSHIP, rel.getSource());
            }
            if (hasSourceRefField) {
                throw new MetaDataException(
                    ErrorMessageConstants.ERR_INVALID_RELATIONSHIP
                        + ": relationship \"" + obj.getShortName() + "." + rel.getShortName()
                        + "\" sets @" + MetaRelationship.ATTR_SOURCE_REF_FIELD
                        + " but is not a M:N relationship.",
                    ErrorCode.ERR_INVALID_RELATIONSHIP, rel.getSource());
            }
            if (symmetric) {
                throw new MetaDataException(
                    ErrorMessageConstants.ERR_INVALID_RELATIONSHIP
                        + ": relationship \"" + obj.getShortName() + "." + rel.getShortName()
                        + "\" sets @" + MetaRelationship.ATTR_SYMMETRIC
                        + " but is not a M:N relationship.",
                    ErrorCode.ERR_INVALID_RELATIONSHIP, rel.getSource());
            }
            return;
        }

        // Rule (b): @symmetric and @sourceRefField are mutually exclusive.
        if (symmetric && hasSourceRefField) {
            throw new MetaDataException(
                ErrorMessageConstants.ERR_BAD_ATTR_VALUE
                    + ": relationship \"" + obj.getShortName() + "." + rel.getShortName()
                    + "\" sets both @" + MetaRelationship.ATTR_SYMMETRIC + " and @"
                    + MetaRelationship.ATTR_SOURCE_REF_FIELD + "; they are mutually exclusive.",
                ErrorCode.ERR_BAD_ATTR_VALUE, rel.getSource());
        }

        // Rule (a): @symmetric is valid only on a self-join (@objectRef == declaring entity).
        boolean isSelfJoin = objectRef != null
            && stripPackageName(objectRef).equals(obj.getShortName());
        if (symmetric && !isSelfJoin) {
            throw new MetaDataException(
                ErrorMessageConstants.ERR_BAD_ATTR_VALUE
                    + ": relationship \"" + obj.getShortName() + "." + rel.getShortName()
                    + "\" sets @" + MetaRelationship.ATTR_SYMMETRIC + " but @"
                    + MetaRelationship.ATTR_OBJECT_REF + " \"" + objectRef
                    + "\" is not the declaring entity \"" + obj.getShortName()
                    + "\"; @" + MetaRelationship.ATTR_SYMMETRIC + " is self-join-only.",
                ErrorCode.ERR_BAD_ATTR_VALUE, rel.getSource());
        }

        // Rule (c): @through must name an entity declaring exactly two identity.reference children.
        MetaObject junction = findRootObject(root, through);
        if (junction == null) {
            throw new MetaDataException(
                ErrorMessageConstants.ERR_INVALID_RELATIONSHIP
                    + ": relationship \"" + obj.getShortName() + "." + rel.getShortName()
                    + "\" @" + MetaRelationship.ATTR_THROUGH + " \"" + through
                    + "\" does not resolve to an entity.",
                ErrorCode.ERR_INVALID_RELATIONSHIP, rel.getSource());
        }
        int refCount = countJunctionReferences(junction);
        if (refCount != 2) {
            throw new MetaDataException(
                ErrorMessageConstants.ERR_INVALID_RELATIONSHIP
                    + ": relationship \"" + obj.getShortName() + "." + rel.getShortName()
                    + "\" @" + MetaRelationship.ATTR_THROUGH + " \"" + through
                    + "\" must declare exactly two identity.reference children"
                    + " (one per FK side); found " + refCount + ".",
                ErrorCode.ERR_INVALID_RELATIONSHIP, rel.getSource());
        }
        // @sourceRefField (if present) must match one of the junction's reference FK fields.
        if (hasSourceRefField) {
            List<String> fkFields = junctionReferenceFkFields(junction);
            if (!fkFields.contains(sourceRefField)) {
                throw new MetaDataException(
                    ErrorMessageConstants.ERR_INVALID_RELATIONSHIP
                        + ": relationship \"" + obj.getShortName() + "." + rel.getShortName()
                        + "\" @" + MetaRelationship.ATTR_SOURCE_REF_FIELD + " \"" + sourceRefField
                        + "\" does not match any identity.reference FK field on junction \""
                        + through + "\". Available: "
                        + (fkFields.isEmpty() ? "(none)" : String.join(", ", fkFields)) + ".",
                    ErrorCode.ERR_INVALID_RELATIONSHIP, rel.getSource());
            }
        }
    }

    /** Count an entity's own {@code identity.reference} children. */
    private static int countJunctionReferences(MetaObject junction) {
        int n = 0;
        for (MetaData child : junction.getChildren(MetaData.class, false)) {
            if (MetaIdentity.TYPE_IDENTITY.equals(child.getType())
                    && MetaIdentity.SUBTYPE_REFERENCE.equals(child.getSubType())) {
                n++;
            }
        }
        return n;
    }

    /** The first {@code @fields} entry of each {@code identity.reference} child
     *  (the physical FK column on the junction), in declaration order. */
    private static List<String> junctionReferenceFkFields(MetaObject junction) {
        List<String> out = new java.util.ArrayList<>();
        for (MetaData child : junction.getChildren(MetaData.class, false)) {
            if (!(child instanceof MetaIdentity)) continue;
            if (!MetaIdentity.SUBTYPE_REFERENCE.equals(child.getSubType())) continue;
            List<String> fields = ((MetaIdentity) child).getFields();
            if (!fields.isEmpty()) out.add(fields.get(0));
        }
        return out;
    }

    /** Bare name for an {@code @objectRef} value: tail segment after the last {@code "::"}. */
    private static String stripPackageName(String name) {
        if (name == null) return null;
        int idx = name.lastIndexOf(MetaData.PKG_SEPARATOR);
        return (idx >= 0) ? name.substring(idx + MetaData.PKG_SEPARATOR.length()) : name;
    }

    // =========================================================================
    // identity.reference @references resolution
    //
    // Every identity.reference's @references must name an FK target object that
    // exists in the loaded tree — a dangling target is drift between two pieces of
    // metadata. The target entity is the segment before the first dotted field path
    // (packages use "::", never ".", so the first "." splits entity from fields).
    // Own identity children only; eager-throw ERR_INVALID_REFERENCE. Mirrors the TS
    // validateIdentityReferences pass.
    // =========================================================================

    // NOTE: identity.reference @references resolution moved to the validation registry
    // (RegisteredValidation.defaultRegistry → a declarative reference descriptor with
    // dottedFieldPath). See the registry run in run(...).

    // =========================================================================
    // field.object + @storage validation
    //
    // Rules, matching the cross-port spec (ADR-0013):
    //   1. A field.object ALWAYS requires @objectRef → ERR_OBJECT_FIELD_WITHOUT_OBJECT_REF.
    //      A field.object models a typed nested value; without @objectRef it is "an
    //      oxymoron at the logical layer". Open/untyped JSON uses the physical
    //      @dbColumnType: jsonb escape hatch on field.string, NOT a bare object.
    //      This rule subsumes the legacy @storage-without-@objectRef check (@storage
    //      is only meaningful on a field.object), so missing-@objectRef now always
    //      reports this single, clearer error — one error per node (we skip the
    //      flattened/array check when @objectRef is absent).
    //   2. @storage="flattened" + isArray → ERR_STORAGE_FLATTENED_ARRAY
    //      (flattened storage materialises one column-per-field; arrays would
    //       require a side table, which is what @storage="jsonb" is for.)
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

        ObjectField field = (ObjectField) node;

        if (!node.hasMetaAttr(ObjectField.ATTR_OBJECTREF, false)) {
            throw new MetaDataException(
                ErrorMessageConstants.ERR_OBJECT_FIELD_WITHOUT_OBJECT_REF
                    + ": field.object '" + field.getName()
                    + "' has no @objectRef — a field.object requires @objectRef."
                    + " For an open/untyped JSON map use @dbColumnType: jsonb on a"
                    + " field.string instead of a bare object.",
                ErrorCode.ERR_OBJECT_FIELD_WITHOUT_OBJECT_REF, field.getSource());
        }

        if (!node.hasMetaAttr(ObjectField.ATTR_STORAGE, false)) return;

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
        // FR-024 (ADR-0029): an identity with a resolved extends (identity
        // pass-through, e.g. a projection identity extending an entity identity)
        // satisfies @fields through INHERITANCE — the local @fields list is
        // computable from the extends-bound key fields and may be omitted.
        // Check the EFFECTIVE attr view (includeParentData) when a super is
        // present; own-only otherwise (the pre-FR-024 rule, unchanged).
        boolean hasFields = identity.getSuperData() != null
            ? identity.hasMetaAttr(MetaIdentity.ATTR_FIELDS, true)
            : identity.hasMetaAttr(MetaIdentity.ATTR_FIELDS, false);
        if (!hasFields) {
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

    // Canonical per-subtype filter-operator band — single source of truth in
    // com.metaobjects.query.FilterOps. Both this load-validation path and the
    // codegen-spring filter-allowlist generator reference it, so the two cannot
    // drift; the cross-port fixtures/conformance/filter-ops-matrix gate asserts
    // every band byte-identically across the five ports.

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
        java.util.Set<String> band =
            com.metaobjects.query.FilterOps.opsForSubType(field.getSubType());
        // Any subtype without a declared band (already rejected upstream by
        // validateFilterableHasSupportedOps) falls through to the string-shape
        // band, preserving the prior default.
        return band.isEmpty() ? com.metaobjects.query.FilterOps.OPS_STRING : band;
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

    // =========================================================================
    // @filterable on a subtype with no operator band — error pass (SP-H Unit9)
    //
    // A field marked @filterable: true whose subtype has no operator band (e.g.
    // field.object) would silently generate a filter with an empty operator set
    // — a route that rejects every request. Error early.
    // → ERR_FILTERABLE_UNSUPPORTED_SUBTYPE.
    //
    // The op band per subtype is the canonical cross-port set in allowedOpsFor;
    // here we ask the dedicated "supported subtype" predicate so that string/enum
    // fall-through in allowedOpsFor does not mask a genuinely unsupported subtype.
    // =========================================================================

    private static void validateFilterableHasSupportedOps(MetaRoot root) {
        for (MetaData rootChild : root.getChildren(MetaData.class, false)) {
            if (!(rootChild instanceof MetaObject)) continue;
            MetaObject obj = (MetaObject) rootChild;
            // Effective fields (includes inherited via extends:/super:).
            for (MetaField field : obj.getChildren(MetaField.class, true)) {
                if (!field.hasMetaAttr(ATTR_FILTERABLE, false)) continue;
                Object v = field.getMetaAttr(ATTR_FILTERABLE, false).getValue();
                boolean filterable =
                    (v instanceof Boolean) ? (Boolean) v
                    : (v instanceof String) ? "true".equalsIgnoreCase((String) v)
                    : false;
                if (!filterable) continue;
                if (subtypeSupportsFiltering(field.getSubType())) continue;
                String objName = obj.getShortName() != null ? obj.getShortName() : obj.getName();
                throw new MetaDataException(
                    ErrorMessageConstants.ERR_FILTERABLE_UNSUPPORTED_SUBTYPE
                        + ": field \"" + objName + "." + field.getShortName()
                        + "\" has @filterable: true but its subtype \"" + field.getSubType()
                        + "\" has no filter-operator band. Remove @filterable, or use a field"
                        + " subtype that supports filtering"
                        + " (string/enum/uuid/number/currency/date/boolean).",
                    ErrorCode.ERR_FILTERABLE_UNSUPPORTED_SUBTYPE, field.getSource());
            }
        }
    }

    /** True iff {@code subType} has a canonical filter-operator band. */
    private static boolean subtypeSupportsFiltering(String st) {
        return com.metaobjects.query.FilterOps.supportsFiltering(st);
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

        // R6 — @kind (template.output only, Task 1) closed-enum + conditional
        // ref requirements. @kind is a closed set (document|email); an email
        // requires @subjectRef + @htmlBodyRef; a document (or absent @kind)
        // requires @textRef. template.prompt always requires @textRef (its
        // renderable body). Mirrors TS validateTemplatePayloadRefs.
        if (TemplateConstants.SUBTYPE_OUTPUT.equals(subType)) {
            String kind = template.hasMetaAttr(TemplateConstants.ATTR_KIND, false)
                ? template.getMetaAttr(TemplateConstants.ATTR_KIND, false).getValueAsString()
                : null;
            // Closed-enum membership (own-only; absent → default "document").
            if (kind != null && !TemplateConstants.ALLOWED_KINDS.contains(kind)) {
                throw new MetaDataException(
                    ErrorMessageConstants.ERR_BAD_ATTR_VALUE
                        + ": template '" + template.getName()
                        + "' @kind '" + kind
                        + "' is not a valid value; allowed: "
                        + TemplateConstants.ALLOWED_KINDS,
                    ErrorCode.ERR_BAD_ATTR_VALUE, template.getSource());
            }
            if (TemplateConstants.KIND_EMAIL.equals(kind)) {
                if (!template.hasMetaAttr(TemplateConstants.ATTR_SUBJECT_REF, false)) {
                    throw new MetaDataException(
                        ErrorMessageConstants.ERR_INVALID_TEMPLATE
                            + ": template '" + template.getName()
                            + "' @kind 'email' requires @subjectRef",
                        ErrorCode.ERR_INVALID_TEMPLATE, template.getSource());
                }
                if (!template.hasMetaAttr(TemplateConstants.ATTR_HTML_BODY_REF, false)) {
                    throw new MetaDataException(
                        ErrorMessageConstants.ERR_INVALID_TEMPLATE
                            + ": template '" + template.getName()
                            + "' @kind 'email' requires @htmlBodyRef",
                        ErrorCode.ERR_INVALID_TEMPLATE, template.getSource());
                }
            } else {
                // @kind absent or "document" → require @textRef so a document is
                // never bodyless. (An out-of-enum @kind already threw above.)
                if (!template.hasMetaAttr(TemplateConstants.ATTR_TEXT_REF, false)) {
                    throw new MetaDataException(
                        ErrorMessageConstants.ERR_INVALID_TEMPLATE
                            + ": template '" + template.getName()
                            + "' @kind 'document' requires @textRef",
                        ErrorCode.ERR_INVALID_TEMPLATE, template.getSource());
                }
            }
        } else if (TemplateConstants.SUBTYPE_PROMPT.equals(subType)) {
            // template.prompt always carries a renderable body via @textRef.
            if (!template.hasMetaAttr(TemplateConstants.ATTR_TEXT_REF, false)) {
                throw new MetaDataException(
                    ErrorMessageConstants.ERR_INVALID_TEMPLATE
                        + ": template '" + template.getName() + "' requires @textRef",
                    ErrorCode.ERR_INVALID_TEMPLATE, template.getSource());
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
        if (bare == null) return false;
        // FR-032 (ADR-0032): origin/template ref values are FULLY QUALIFIED after
        // the desugar/sweep (e.g. "acme::commerce::Program.title" → entity head
        // "acme::commerce::Program"). Match the ref's tail segment (after the last
        // "::") against the child's bare name — covers a bare ref (tail == whole)
        // AND an FQN ref — and also match the child's full FQN name directly.
        // Mirrors the TS refMatchesObject helper.
        int idx = name.lastIndexOf(MetaData.PKG_SEPARATOR);
        String nameTail = (idx >= 0) ? name.substring(idx + MetaData.PKG_SEPARATOR.length()) : name;
        return nameTail.equals(bare) || name.equals(child.getName());
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

    // =========================================================================
    // FR-013 — field-level @readOnly cross-attribute rules.
    //   ERR_READONLY_ASSIGNED_PRIMARY / ERR_READONLY_DOWNGRADE / WARN_READONLY_VALUE_OBJECT
    // Mirrors TS core/field/validate-field-readonly.ts.
    // =========================================================================

    static void validateFieldReadOnly(MetaRoot root, MetaDataLoader loader) {
        for (MetaData rc : root.getChildren(MetaData.class, false)) {
            if (!(rc instanceof MetaObject)) continue;
            MetaObject obj = (MetaObject) rc;
            boolean isValueObject = MetaObject.SUBTYPE_VALUE.equals(obj.getSubType());

            // 1) WARN_READONLY_VALUE_OBJECT — any @readOnly field child of object.value.
            if (isValueObject) {
                for (MetaField f : ownFieldsRaw(obj)) {
                    if (Boolean.TRUE.equals(readOnlyFlag(f)) && loader != null) {
                        loader.addEnvelopeWarning(new LoaderWarning(
                            ErrorMessageConstants.WARN_READONLY_VALUE_OBJECT,
                            "field \"" + shortNameOf(f) + "\" on object.value \""
                                + shortNameOf(obj) + "\" declares @readOnly: true; "
                                + "value-objects have no persistence semantics so the "
                                + "read-only contract is advisory (codegen may use it "
                                + "for record/struct treatment).",
                            f.getSource()));
                    }
                }
            }

            // 2) ERR_READONLY_DOWNGRADE — only the explicit own @readOnly: false case.
            for (MetaField ownField : ownFieldsRaw(obj)) {
                if (!Boolean.FALSE.equals(readOnlyFlag(ownField))) continue;
                MetaField inherited = inheritedReadOnlyField(obj, shortNameOf(ownField));
                if (inherited != null && Boolean.TRUE.equals(readOnlyFlag(inherited))) {
                    throw new MetaDataException(
                        "ERR_READONLY_DOWNGRADE"
                            + ": field \"" + shortNameOf(ownField) + "\" on \""
                            + shortNameOf(obj) + "\" sets @readOnly: false, but the "
                            + "extends-chain parent declares @readOnly: true. "
                            + "Read-only-ness can only be upgraded, not downgraded (FR-013).",
                        ErrorCode.ERR_READONLY_DOWNGRADE, ownField.getSource());
                }
            }

            // 3) ERR_READONLY_ASSIGNED_PRIMARY — @readOnly: true on a field used in an
            //    identity.primary with @generation: "assigned" (effective tree).
            if (!isValueObject) {
                Set<String> assigned = primaryAssignedFieldNames(obj);
                if (!assigned.isEmpty()) {
                    for (MetaField f : ownFieldsRaw(obj)) {
                        if (!assigned.contains(shortNameOf(f))) continue;
                        if (!Boolean.TRUE.equals(readOnlyFlag(f))) continue;
                        throw new MetaDataException(
                            "ERR_READONLY_ASSIGNED_PRIMARY"
                                + ": field \"" + shortNameOf(f) + "\" on \""
                                + shortNameOf(obj) + "\" is @readOnly: true AND the target "
                                + "of identity.primary with @generation: \"assigned\"; the "
                                + "application has no path to populate the identity value "
                                + "(FR-013).",
                            ErrorCode.ERR_READONLY_ASSIGNED_PRIMARY, f.getSource());
                    }
                }
            }
        }
    }

    /** Raw own-declared field children (authored nodes, original json source) —
     *  NOT the merge-folded {@code getMetaFields()} view, whose source on an
     *  override collapses onto the inherited declaration. Errors emitted against
     *  these carry the subtype's own envelope, matching the conformance corpus. */
    private static List<MetaField> ownFieldsRaw(MetaObject obj) {
        List<MetaField> out = new java.util.ArrayList<>();
        for (MetaData c : obj.getChildren(MetaData.class, false)) {
            if (c instanceof MetaField) out.add((MetaField) c);
        }
        return out;
    }

    /** Explicit own @readOnly value (TRUE/FALSE) or null when absent. */
    private static Boolean readOnlyFlag(MetaField field) {
        if (!field.hasMetaAttr(MetaField.ATTR_READ_ONLY, false)) return null;
        Object v = field.getMetaAttr(MetaField.ATTR_READ_ONLY, false).getValue();
        if (v instanceof Boolean) return (Boolean) v;
        if (v instanceof String) return Boolean.valueOf("true".equalsIgnoreCase((String) v));
        return null;
    }

    /** Walk the extends chain for a field with {@code name}; return its declaring
     *  node (own attrs intact). */
    private static MetaField inheritedReadOnlyField(MetaObject obj, String name) {
        MetaData cursor = obj.getSuperData();
        while (cursor != null) {
            if (cursor instanceof MetaObject) {
                for (MetaField f : ownFieldsRaw((MetaObject) cursor)) {
                    if (name.equals(shortNameOf(f))) return f;
                }
            }
            cursor = cursor.getSuperData();
        }
        return null;
    }

    /** Names of fields in any effective identity.primary with @generation "assigned". */
    private static Set<String> primaryAssignedFieldNames(MetaObject obj) {
        Set<String> out = new HashSet<>();
        for (MetaIdentity id : obj.getChildren(MetaIdentity.class, true)) {
            if (!MetaIdentity.SUBTYPE_PRIMARY.equals(id.getSubType())) continue;
            if (!MetaIdentity.GENERATION_ASSIGNED.equals(id.getGeneration())) continue;
            out.addAll(id.getFields());
        }
        return out;
    }

    // =========================================================================
    // FR-014 — TPH discriminator cross-attribute rules.
    //   ERR_DISCRIMINATOR_FIELD_NOT_FOUND / _VALUE_DUPLICATE / _VALUE_MISSING /
    //   _VALUE_TYPE_MISMATCH. Mirrors TS core/object/validate-discriminator.ts.
    // =========================================================================

    private static final Set<String> NUMERIC_DISCRIMINATOR_SUBTYPES = Set.of(
        IntegerField.SUBTYPE_INT, LongField.SUBTYPE_LONG);

    static void validateDiscriminator(MetaRoot root) {
        List<MetaObject> entities = new java.util.ArrayList<>();
        for (MetaData rc : root.getChildren(MetaData.class, false)) {
            if (rc instanceof MetaObject && MetaObject.SUBTYPE_ENTITY.equals(rc.getSubType())) {
                entities.add((MetaObject) rc);
            }
        }

        // Pass 1: @discriminator name resolution (own + inherited fields).
        for (MetaObject obj : entities) {
            String disc = ownAttrString(obj, MetaObject.ATTR_DISCRIMINATOR);
            if (disc == null || disc.isEmpty()) continue;
            if (findFieldOnEntity(obj, disc) == null) {
                throw new MetaDataException(
                    "ERR_DISCRIMINATOR_FIELD_NOT_FOUND"
                        + ": object.entity \"" + shortNameOf(obj) + "\" @discriminator: \""
                        + disc + "\" does not name a field on this entity (checked own "
                        + "children and the extends chain)",
                    ErrorCode.ERR_DISCRIMINATOR_FIELD_NOT_FOUND, obj.getSource());
            }
        }

        // Pass 2: @discriminatorValue type-check + collect bindings per root.
        Map<MetaObject, List<Object[]>> bindingsByRoot = new java.util.LinkedHashMap<>();
        for (MetaObject obj : entities) {
            String value = ownAttrString(obj, MetaObject.ATTR_DISCRIMINATOR_VALUE);
            if (value == null || value.isEmpty()) continue;
            MetaObject discRoot = findDiscriminatorRoot(obj);
            if (discRoot == null) continue;
            String fieldName = ownAttrString(discRoot, MetaObject.ATTR_DISCRIMINATOR);
            if (fieldName == null) continue;
            MetaField field = findFieldOnEntity(discRoot, fieldName);
            if (field == null) continue; // root's own field-not-found already fires

            String st = field.getSubType();
            if (EnumField.SUBTYPE_ENUM.equals(st)) {
                List<String> members = effectiveEnumValues(field);
                if (!members.contains(value)) {
                    throw new MetaDataException(
                        "ERR_DISCRIMINATOR_VALUE_TYPE_MISMATCH"
                            + ": object.entity \"" + shortNameOf(obj) + "\" @discriminatorValue: \""
                            + value + "\" is not a member of the discriminator enum field \""
                            + fieldName + "\" @values " + members,
                        ErrorCode.ERR_DISCRIMINATOR_VALUE_TYPE_MISMATCH, obj.getSource());
                }
            } else if (NUMERIC_DISCRIMINATOR_SUBTYPES.contains(st)) {
                if (!value.matches("-?\\d+")) {
                    throw new MetaDataException(
                        "ERR_DISCRIMINATOR_VALUE_TYPE_MISMATCH"
                            + ": object.entity \"" + shortNameOf(obj) + "\" @discriminatorValue: \""
                            + value + "\" does not coerce to numeric discriminator field \""
                            + fieldName + "\" (field." + st + ")",
                        ErrorCode.ERR_DISCRIMINATOR_VALUE_TYPE_MISMATCH, obj.getSource());
                }
            }
            // string (and other) discriminator types accept any value.

            bindingsByRoot.computeIfAbsent(discRoot, k -> new java.util.ArrayList<>())
                          .add(new Object[]{obj, value});
        }

        // Pass 3: ERR_DISCRIMINATOR_VALUE_DUPLICATE within each root's subtypes.
        for (Map.Entry<MetaObject, List<Object[]>> e : bindingsByRoot.entrySet()) {
            Map<String, MetaObject> seen = new java.util.HashMap<>();
            for (Object[] b : e.getValue()) {
                MetaObject sub = (MetaObject) b[0];
                String value = (String) b[1];
                MetaObject prev = seen.get(value);
                if (prev != null) {
                    throw new MetaDataException(
                        "ERR_DISCRIMINATOR_VALUE_DUPLICATE"
                            + ": object.entity \"" + shortNameOf(sub) + "\" @discriminatorValue: \""
                            + value + "\" duplicates the value already claimed by \""
                            + shortNameOf(prev) + "\"",
                        ErrorCode.ERR_DISCRIMINATOR_VALUE_DUPLICATE, sub.getSource());
                }
                seen.put(value, sub);
            }
        }

        // Pass 4: ERR_DISCRIMINATOR_VALUE_MISSING on concrete subtypes.
        for (MetaObject obj : entities) {
            if (isAbstract(obj)) continue;
            if (ownAttrString(obj, MetaObject.ATTR_DISCRIMINATOR_VALUE) != null) continue;
            if (ownAttrString(obj, MetaObject.ATTR_DISCRIMINATOR) != null) continue; // a root
            MetaObject discRoot = findDiscriminatorRoot(obj);
            if (discRoot == null || discRoot == obj) continue;
            throw new MetaDataException(
                "ERR_DISCRIMINATOR_VALUE_MISSING"
                    + ": object.entity \"" + shortNameOf(obj) + "\" extends the "
                    + "@discriminator-bearing root \"" + shortNameOf(discRoot) + "\" but is "
                    + "missing @discriminatorValue (required on every concrete subtype)",
                ErrorCode.ERR_DISCRIMINATOR_VALUE_MISSING, obj.getSource());
        }
    }

    /** A field with {@code name} on {@code entity} — own first, then extends chain. */
    private static MetaField findFieldOnEntity(MetaObject entity, String name) {
        for (MetaField f : entity.getMetaFields(false)) {
            if (name.equals(shortNameOf(f))) return f;
        }
        MetaData cursor = entity.getSuperData();
        while (cursor != null) {
            if (cursor instanceof MetaObject) {
                for (MetaField f : ((MetaObject) cursor).getMetaFields(false)) {
                    if (name.equals(shortNameOf(f))) return f;
                }
            }
            cursor = cursor.getSuperData();
        }
        return null;
    }

    /** First ancestor (or self) carrying @discriminator. */
    private static MetaObject findDiscriminatorRoot(MetaObject entity) {
        MetaData cursor = entity;
        while (cursor != null) {
            if (cursor instanceof MetaObject) {
                String v = ownAttrString(cursor, MetaObject.ATTR_DISCRIMINATOR);
                if (v != null && !v.isEmpty()) return (MetaObject) cursor;
            }
            cursor = cursor.getSuperData();
        }
        return null;
    }

    /** Own attribute as a String, or null when absent. */
    private static String ownAttrString(MetaData node, String attr) {
        if (!node.hasMetaAttr(attr, false)) return null;
        return node.getMetaAttr(attr, false).getValueAsString();
    }

    // =========================================================================
    // FR-015 — source.rdb @parameterRef typed-input rules.
    //   ERR_PARAMETER_REF_ON_NON_CALLABLE_KIND / _UNRESOLVED / _NOT_VALUE_OBJECT /
    //   _PASSTHROUGH_TYPE_MISMATCH. Mirrors TS persistence/source/validate-source-parameter-ref.ts.
    // =========================================================================

    private static final Set<String> CALLABLE_KINDS = Set.of(
        MetaSource.KIND_STORED_PROC, MetaSource.KIND_TABLE_FUNCTION);

    static void validateSourceParameterRef(MetaRoot root) {
        // Pre-index every object by short name AND fqn.
        Map<String, MetaObject> index = new java.util.HashMap<>();
        for (MetaData rc : root.getChildren(MetaData.class, false)) {
            if (!(rc instanceof MetaObject)) continue;
            MetaObject o = (MetaObject) rc;
            index.put(shortNameOf(o), o);
            if (o.getName() != null) index.put(o.getName(), o);
        }

        for (MetaData rc : root.getChildren(MetaData.class, false)) {
            if (!(rc instanceof MetaObject)) continue;
            MetaObject obj = (MetaObject) rc;
            for (MetaSource source : obj.getSources(false)) {
                if (!RdbSource.SUBTYPE_RDB.equals(source.getSubType())) continue;
                String ref = ownAttrString(source, RdbSource.ATTR_PARAMETER_REF);
                if (ref == null || ref.isEmpty()) continue;

                // ERR_PARAMETER_REF_ON_NON_CALLABLE_KIND — before resolution.
                if (!CALLABLE_KINDS.contains(source.getEffectiveKind())) {
                    throw new MetaDataException(
                        "ERR_PARAMETER_REF_ON_NON_CALLABLE_KIND"
                            + ": source.rdb on object \"" + shortNameOf(obj) + "\" has "
                            + "@parameterRef but @kind is \"" + source.getEffectiveKind()
                            + "\"; only \"storedProc\" or \"tableFunction\" accept parameters",
                        ErrorCode.ERR_PARAMETER_REF_ON_NON_CALLABLE_KIND, source.getSource());
                }

                MetaObject target = index.get(ref);
                if (target == null) {
                    throw new MetaDataException(
                        "ERR_PARAMETER_REF_UNRESOLVED"
                            + ": source.rdb on object \"" + shortNameOf(obj) + "\" @parameterRef = \""
                            + ref + "\" does not resolve to any known object",
                        ErrorCode.ERR_PARAMETER_REF_UNRESOLVED, source.getSource());
                }

                if (!MetaObject.SUBTYPE_VALUE.equals(target.getSubType())) {
                    String reason = MetaObject.SUBTYPE_ENTITY.equals(target.getSubType())
                        ? "an object.entity (entities have identity; parameter shapes are value-objects)"
                        : "an object." + target.getSubType();
                    throw new MetaDataException(
                        "ERR_PARAMETER_REF_NOT_VALUE_OBJECT"
                            + ": source.rdb on object \"" + shortNameOf(obj) + "\" @parameterRef = \""
                            + ref + "\" resolves to " + reason + "; use an object.value",
                        ErrorCode.ERR_PARAMETER_REF_NOT_VALUE_OBJECT, source.getSource());
                }

                // ERR_PARAMETER_REF_PASSTHROUGH_TYPE_MISMATCH per parameter field.
                for (MetaField paramField : ownFieldsRaw(target)) {
                    MetaOrigin passthrough = null;
                    for (MetaData c : paramField.getChildren(MetaData.class, false)) {
                        if (c instanceof MetaOrigin
                                && PassthroughOrigin.SUBTYPE_PASSTHROUGH.equals(c.getSubType())) {
                            passthrough = (MetaOrigin) c;
                            break;
                        }
                    }
                    if (passthrough == null) continue;
                    String from = passthrough.getFrom();
                    if (from == null || from.isEmpty()) continue;
                    int dot = from.indexOf('.');
                    if (dot < 0) continue;
                    String targetEntityName = from.substring(0, dot);
                    String targetFieldName = from.substring(dot + 1);
                    MetaObject targetEntity = index.get(targetEntityName);
                    if (targetEntity == null) continue;
                    MetaField targetField = null;
                    for (MetaField f : ownFieldsRaw(targetEntity)) {
                        if (targetFieldName.equals(shortNameOf(f))) { targetField = f; break; }
                    }
                    if (targetField == null) continue;
                    if (!paramField.getSubType().equals(targetField.getSubType())) {
                        throw new MetaDataException(
                            "ERR_PARAMETER_REF_PASSTHROUGH_TYPE_MISMATCH"
                                + ": parameter field \"" + shortNameOf(paramField) + "\" (field."
                                + paramField.getSubType() + ") on @parameterRef \"" + ref
                                + "\" uses origin.passthrough @from: \"" + from + "\", but "
                                + shortNameOf(targetEntity) + "." + targetFieldName + " is field."
                                + targetField.getSubType() + "; types must match",
                            ErrorCode.ERR_PARAMETER_REF_PASSTHROUGH_TYPE_MISMATCH, paramField.getSource());
                    }
                }
            }
        }
    }

}

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
import com.metaobjects.field.DateField;
import com.metaobjects.field.DecimalField;
import com.metaobjects.field.DoubleField;
import com.metaobjects.field.EnumField;
import com.metaobjects.field.FloatField;
import com.metaobjects.field.IntegerField;
import com.metaobjects.field.LongField;
import com.metaobjects.field.MapField;
import com.metaobjects.field.MetaField;
import com.metaobjects.field.ObjectField;
import com.metaobjects.field.StringField;
import com.metaobjects.field.TimeField;
import com.metaobjects.field.TimestampField;
import com.metaobjects.field.UuidField;
import com.metaobjects.identity.SecondaryIdentity;
import com.metaobjects.index.Index;
import com.metaobjects.index.LookupIndex;
import com.metaobjects.layout.DataGridLayout;
import com.metaobjects.layout.MetaLayout;
import com.metaobjects.identity.MetaIdentity;
import com.metaobjects.identity.ReferenceIdentity;
import com.metaobjects.object.MetaObject;
import com.metaobjects.attr.ExpressionAttribute;
import com.metaobjects.origin.AggregateOrigin;
import com.metaobjects.origin.ComputedOrigin;
import com.metaobjects.origin.FirstOrigin;
import com.metaobjects.origin.MetaOrigin;
import com.metaobjects.origin.PassthroughOrigin;
import com.metaobjects.relationship.MetaRelationship;
import com.metaobjects.requirement.MetaRequirement;
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

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;

/**
 * Post-load validation phase — runs after all sources are parsed and before the
 * loader transitions to INITIALIZED.
 *
 * <p>Mirrors the C# {@code ValidationPasses} orchestrator in style (stateless static
 * methods, a single public entry point). Each pass COLLECTS its finding rather than aborting
 * on the first: the load reports every error (a model with defects across multiple passes
 * surfaces them all). Findings are recorded on the loader (source order) via
 * {@link MetaDataLoader#addError} and the LAST one is thrown so the load still fails; a
 * single-error load records nothing and throws that one, byte-identical to the prior
 * eager-throw. See {@link #run(MetaRoot, MetaDataLoader)}.</p>
 *
 * <p>In this phase only enum {@code @values} content validation is wired here. Other
 * validation passes will be migrated incrementally.</p>
 *
 * <p>Ordering: {@code extends:} super resolution happens eagerly at parse time, so by
 * the time this phase runs {@link MetaData#getSuperData()} is already set. The own-only
 * validation contract (validate the node's own attributes, not inherited ones) means we
 * do not need effective/resolved attribute access.</p>
 *
 * <p><b>ADR-0039 own-accessor policy for this phase.</b> Validation runs on AUTHORED
 * DECLARATIONS, so the pervasive {@code , false} / {@code getChildren(MetaData.class,
 * false)} reads here are the sanctioned own cases: (a) the tree walk descends via OWN
 * children so each declared node is validated exactly ONCE at its declaration site
 * (inherited members were already validated on the parent); (b) an attribute rule
 * validates the {@code @attr} on the node that DECLARES it — re-validating inherited
 * attrs on every subtype would be redundant and could double-report. The rare reads
 * that must instead resolve an EFFECTIVE property to decide correctness — {@code
 * field.object @objectRef}/{@code @storage}, {@code field.map @valueType}/{@code
 * @objectRef}, the primary-source lookup, the M:N slim-vocabulary attrs
 * ({@code @through}/{@code @sourceRefField}/{@code @objectRef}/{@code @cardinality}/
 * {@code @symmetric}) and the junction's {@code identity.reference} view, the
 * {@code layout.dataGrid} lookup + its {@code @defaultSortField}/{@code @filter}, and
 * the {@code template.*} attrs ({@code @format}/{@code @promptStyle}/{@code @kind}/
 * part-refs — templates CAN extend) — are flipped to the resolving accessor inline and
 * marked "ADR-0039: resolving" (mirrors the TS reference and the C# ValidationPasses
 * fix). Declaration-layer markers ({@code @isAbstract}, TPH {@code @discriminator}/
 * {@code @discriminatorValue}) stay own by contract.</p>
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
     *   <li>{@link #validateRequirementStatus(MetaRoot)} — {@code requirement.*}
     *       {@code @status} enum-membership rules.</li>
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
     * @throws MetaDataException when any validation error is found. The load reports
     *         EVERY error: each pass records its finding and the walk continues, so a
     *         model with multiple defects surfaces all of them. The recorded errors are
     *         put on the loader (source order) via {@link MetaDataLoader#addError} and the
     *         LAST one is thrown — matching the conformance harness's "drain getErrors()
     *         then the thrown error" merge. A single-error load records nothing and throws
     *         that one error, byte-identical to the historical eager-throw.
     */
    public static void run(MetaRoot root, MetaDataLoader loader) {
        if (root == null) return;
        // Collect EVERY pass's findings rather than aborting on the first (cross-port parity
        // with TS/C#/Python, which collect). Each pass below still throws a MetaDataException
        // on a defect; pass(...) catches it, records it, and lets the next pass run.
        java.util.List<MetaDataException> collected = new java.util.ArrayList<>();

        // Generic required-attr pass runs first: any node whose registered schema
        // declares required:true attrs that are absent on the node fires
        // ERR_MISSING_REQUIRED_ATTR. Mirrors TS attr-schema-validate / C#
        // ValidateAttrSchemaNode / Python validate_attr_schema. This collapses
        // per-subtype "missing @X" blocks (previously R1 for template.prompt,
        // R1b for template.toolcall) into a single cross-port-aligned pass.
        pass(collected, () -> validateRequiredAttrs(root, loader));
        // Generic singleton-cardinality pass: any parent declaring more children
        // of a registered maxOccurs==1 type.subType than allowed fires
        // ERR_TOO_MANY_OCCURRENCES (e.g. two identity.primary on one object).
        pass(collected, () -> validateMaxOccurs(root, loader));
        pass(collected, () -> validateEnumValues(root));
        pass(collected, () -> validateFieldDefaults(root));
        pass(collected, () -> validateDbColumnType(root));
        pass(collected, () -> validateSourceAttrs(root));
        pass(collected, () -> validateSourcePhysicalNames(root, loader));
        // FR-013 — field-level @readOnly cross-attribute rules.
        pass(collected, () -> validateFieldMutability(root, loader));
        // Authoring guard — a field.enum vocabulary ambiguous under the default
        // @normalize: strip. WARN_ENUM_NORMALIZE_AMBIGUOUS.
        pass(collected, () -> validateEnumNormalizeAmbiguity(root, loader));
        // FR-014 — TPH discriminator cross-attribute rules.
        pass(collected, () -> validateDiscriminator(root));
        // FR-015 — source.rdb @parameterRef typed-input rules.
        pass(collected, () -> validateSourceParameterRef(root));
        pass(collected, () -> validateOnePrimarySource(root));
        // #208 — DDL-ownership escape valves (@sql/@unmanaged on source.rdb).
        // Sibling of the source-role pass above; must run after it.
        pass(collected, () -> validateSourceEscapes(root, loader));
        pass(collected, () -> validateRelationshipReferentialActions(root));
        pass(collected, () -> validateRelationshipsM2M(root));
        // ADR-0042 — the cross-package ambiguity pass (ERR_AMBIGUOUS_REF) is RETIRED. A bare
        // reference now resolves package-locally (referrer's package, else root-level) at every
        // ref site (SymbolTable / resolveRootObject), so cross-package ambiguity is unreachable;
        // an unresolved ref fails closed with its per-attr code (ERR_INVALID_RELATIONSHIP /
        // ERR_INVALID_REFERENCE / ERR_UNRESOLVED_OBJECT_REF / ERR_INVALID_ORIGIN /
        // ERR_INVALID_TEMPLATE).
        // Phase 2 — validation DERIVED FROM THE TYPE REGISTRY: each node's TypeDefinition
        // carries its reference descriptors + imperative validator (relationship @objectRef,
        // identity.reference @references for core; a downstream provider's type carries its
        // own). One recursive walk over a built-once symbol table; this pass ALREADY collects
        // every finding — fold them all in. Needs the registry, so it is skipped on the legacy
        // null-loader path (like validateRequiredAttrs/MaxOccurs).
        if (loader != null && loader.getTypeRegistry() != null) {
            for (com.metaobjects.validation.ValidationError e :
                    com.metaobjects.loader.validation.RegisteredValidation.run(root, loader.getTypeRegistry())) {
                collected.add(new MetaDataException(e.message(), toErrorCode(e.code()), e.source()));
            }
        }
        pass(collected, () -> validateOrigins(root));
        // FR-024 B6 — derived-field providability (entity origin fields need a read source).
        pass(collected, () -> validateDerivedFieldProvidability(root));
        pass(collected, () -> validateObjectFieldStorage(root));
        pass(collected, () -> validateFieldMap(root));
        pass(collected, () -> validateIdentityFieldsAndGeneration(root));
        // FR-024 B3/B4a — subtype rules (identity-name, value purity, projection licensing).
        pass(collected, () -> validateSubtypeRules(root));
        // FR-024 B3 — projection identity pass-through + key correspondence.
        pass(collected, () -> validateIdentityPassthrough(root));
        pass(collected, () -> validateDataGridLayouts(root));
        // #207 — projection row-scope @filter field-ref validation (fail-closed).
        pass(collected, () -> validateProjectionFilter(root));
        pass(collected, () -> validateTemplates(root));
        pass(collected, () -> validateEntityHasPrimaryIdentity(root, loader));
        pass(collected, () -> validateFilterableHasSupportedOps(root));
        pass(collected, () -> validateIndexLookupFields(root));
        // The capability ledger's closed status enum (requirements-as-metadata
        // ruling, Amendment 3) — the loader owns what is UNCONDITIONAL.
        pass(collected, () -> validateRequirementStatus(root));
        warnFilterableWithoutIndex(root, loader); // warnings only — never throws

        // The SAME defect can be flagged by more than one pass (e.g. a missing required attr
        // caught by both the generic required-attr pass and a subtype-specific pass) — that is
        // one finding, not two, and the envelope (code + source) is identical. Dedupe on it so
        // a defect is reported once, while genuinely-distinct findings stay separate.
        java.util.List<MetaDataException> findings = dedupe(collected);

        // Surface ALL findings: record every error but the last on the loader (source order),
        // then throw the last so the load still fails. Single error → records nothing, throws
        // the one (byte-identical to the historical eager-throw).
        if (!findings.isEmpty()) {
            if (loader != null) {
                for (int i = 0; i < findings.size() - 1; i++) {
                    loader.addError(findings.get(i));
                }
            }
            throw findings.get(findings.size() - 1);
        }
    }

    /** Run one validation pass, catching its finding (if any) into {@code collected} so the
     *  remaining passes still run. Only {@link MetaDataException} (a validation finding) is
     *  caught — any other exception is a genuine bug and propagates. */
    private static void pass(java.util.List<MetaDataException> collected, Runnable p) {
        try {
            p.run();
        } catch (MetaDataException e) {
            collected.add(e);
        }
    }

    /** Collapse duplicate findings (same code + same source envelope), preserving first-seen
     *  order. Two errors the conformance envelope model cannot tell apart ARE the same finding.
     *  A finding with neither code nor envelope (no distinguishing identity) is never deduped —
     *  it keeps its own slot via an index-tagged key. */
    private static java.util.List<MetaDataException> dedupe(java.util.List<MetaDataException> in) {
        java.util.Map<String, MetaDataException> byKey = new java.util.LinkedHashMap<>();
        for (int i = 0; i < in.size(); i++) {
            MetaDataException e = in.get(i);
            String code = e.getCode().map(Enum::name).orElse("");
            String env = e.getEnvelope().map(Object::toString).orElse("");
            // No code AND no envelope → nothing to dedupe on; tag with the index so distinct
            // such findings are not collapsed into one.
            String key = (code.isEmpty() && env.isEmpty()) ? ("#" + i) : (code + "|" + env);
            byKey.putIfAbsent(key, e);
        }
        return new java.util.ArrayList<>(byKey.values());
    }

    /** Map a (possibly downstream) error-code STRING to the {@link ErrorCode} enum, falling back
     *  to {@link ErrorCode#ERR_UNKNOWN} for a code not in the enum — so a downstream provider's
     *  custom code never throws out of the validation walk (the message carries the raw code). */
    private static ErrorCode toErrorCode(String code) {
        try {
            return ErrorCode.valueOf(code);
        } catch (IllegalArgumentException | NullPointerException ex) {
            return ErrorCode.ERR_UNKNOWN;
        }
    }

    /**
     * Legacy entry point retained for callers that do not have a loader handle.
     * Delegates to {@link #run(MetaRoot, MetaDataLoader)} with a {@code null}
     * loader, which skips warning collection and the registry-derived reference pass
     * but still runs all error-collecting passes.
     *
     * <p>Without a loader handle there is no error-accumulator to record into, so the
     * collected findings cannot be surfaced via {@code getErrors()}; the load still fails
     * by throwing the last collected finding.</p>
     *
     * @param root the fully-loaded {@link MetaRoot}; must not be {@code null}
     * @throws MetaDataException when any validation error is found (the last collected one)
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

        // #236: an ABSTRACT node is a template, not instantiated — it may omit a required
        // attr for concrete subtypes / extends: to supply. Enforcement stays at the
        // concrete level (a concrete's effective attrs must satisfy it). ADR-0039.
        if (isAbstract(node)) return;

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

    // =========================================================================
    // Authoring guard — enum vocabularies ambiguous under @normalize: strip.
    //   WARN_ENUM_NORMALIZE_AMBIGUOUS
    // Mirrors TS core/field/validate-enum-normalize-ambiguity.ts.
    //
    // `strip` (the DEFAULT) upper-cases and keeps only [A-Z0-9], erasing every
    // separator. That is what makes "SOCIAL-ATTACK" match SOCIAL_ATTACK — desired.
    // But it also collapses a DELIMITED value into one token, and if that token
    // equals another member the extract engine coerces it SUCCESSFULLY:
    //   values = {READ, WRITE, READWRITE};  input "read|write"  ->  READWRITE
    // reported EXTRACTED, not MALFORMED — a plausible wrong value. Detectable from
    // metadata alone, so warn the author at declaration time.
    //
    // WARNING, not error: such a vocabulary is legal and unambiguous for exact
    // matching. `collapse` folds only [\s_-]+ and `none` folds nothing, so neither
    // can merge tokens across a delimiter like "|" — both are skipped.
    // =========================================================================

    static void validateEnumNormalizeAmbiguity(MetaRoot root, MetaDataLoader loader) {
        walkEnumNormalizeAmbiguity(root, loader);
    }

    private static void walkEnumNormalizeAmbiguity(MetaData node, MetaDataLoader loader) {
        checkEnumNormalizeAmbiguity(node, loader);
        // Own children only — inherited children are checked on their declaring nodes.
        for (MetaData child : node.getChildren(MetaData.class, false)) {
            walkEnumNormalizeAmbiguity(child, loader);
        }
    }

    private static void checkEnumNormalizeAmbiguity(MetaData node, MetaDataLoader loader) {
        if (loader == null) return;
        if (!EnumField.TYPE_FIELD.equals(node.getType())
                || !EnumField.SUBTYPE_ENUM.equals(node.getSubType())) {
            return;
        }
        // Own-attrs-only: check the vocabulary DECLARED here. A concrete enum that
        // inherits @values shares the super's member set, already checked at the
        // super — one hazard yields one warning, not one per referring field.
        if (!node.hasMetaAttr(EnumField.ATTR_VALUES, false)) return;
        Object raw = node.getMetaAttr(EnumField.ATTR_VALUES, false).getValue();
        if (!(raw instanceof List)) return;
        List<?> rawList = (List<?>) raw;
        if (rawList.size() < 2) return;
        String[] normalize = effectiveNormalizeMode(node);
        if (!EnumField.NORMALIZE_DEFAULT.equals(normalize[0])) return;
        boolean modeIsExplicit = "true".equals(normalize[1]);

        List<String> members = new ArrayList<>();
        List<String> stripped = new ArrayList<>();
        for (Object o : rawList) {
            String m = String.valueOf(o);
            members.add(m);
            stripped.add(stripNormalize(m));
        }
        for (int i = 0; i < members.size(); i++) {
            String selfStripped = stripped.get(i);
            if (selfStripped.isEmpty()) continue; // e.g. "_" — nothing to collide with
            // Exclude self BY INDEX, not by value: two distinct members can strip to
            // the same string, which is a separate (duplicate) concern.
            List<String> dictMembers = new ArrayList<>();
            List<String> dictStripped = new ArrayList<>();
            for (int j = 0; j < members.size(); j++) {
                if (j == i || stripped.get(j).isEmpty()) continue;
                dictMembers.add(members.get(j));
                dictStripped.add(stripped.get(j));
            }
            List<String> seg = segmentInto(selfStripped, dictMembers, dictStripped);
            if (seg != null) {
                StringBuilder plus = new StringBuilder();
                StringBuilder delimited = new StringBuilder();
                for (int k = 0; k < seg.size(); k++) {
                    if (k > 0) { plus.append(" + "); delimited.append("|"); }
                    plus.append('\'').append(seg.get(k)).append('\'');
                    delimited.append(seg.get(k).toLowerCase(Locale.ROOT));
                }
                loader.addEnvelopeWarning(new LoaderWarning(
                    ErrorMessageConstants.WARN_ENUM_NORMALIZE_AMBIGUOUS,
                    "field.enum \"" + shortNameOf(node) + "\" member '" + members.get(i)
                        + "' is the concatenation of " + plus + " under @"
                        + EnumField.ATTR_NORMALIZE + ": '" + EnumField.NORMALIZE_DEFAULT
                        + "'" + (modeIsExplicit ? "" : " (the default)")
                        + ", which erases separators. A delimited value such as \""
                        + delimited + "\" would coerce silently to '" + members.get(i)
                        + "' and be reported as extracted rather than malformed. Set @"
                        + EnumField.ATTR_NORMALIZE + ": 'collapse' on this field if it can "
                        + "receive delimited input.",
                    node.getSource()));
                return; // one warning per declaring node
            }
        }
    }

    /** Effective @normalize for an enum field: own/inherited -> owning object -> default. */
    private static String[] effectiveNormalizeMode(MetaData field) {
        // Resolving (includeParentData=true) — an enum extending an abstract enum must
        // see the super's @normalize (ADR-0039).
        if (field.hasMetaAttr(EnumField.ATTR_NORMALIZE, true)) {
            return new String[] {
                field.getMetaAttr(EnumField.ATTR_NORMALIZE, true).getValueAsString(), "true" };
        }
        MetaData parent = field.getParent();
        if (parent instanceof MetaObject && parent.hasMetaAttr(EnumField.ATTR_NORMALIZE, true)) {
            return new String[] {
                parent.getMetaAttr(EnumField.ATTR_NORMALIZE, true).getValueAsString(), "true" };
        }
        return new String[] { EnumField.NORMALIZE_DEFAULT, "false" };
    }

    /**
     * `strip` normalization: ASCII fold (a-z -> A-Z), then keep only [A-Z0-9].
     * Mirrors Normalize.STRIP exactly -- note the manual ASCII fold rather than
     * toUpperCase(Locale.ROOT): the engine's Normalize.asciiUpper is deliberately
     * ASCII-only, and locale uppercasing diverges on non-ASCII input. Unreachable
     * for legal metadata (enum members are ASCII identifiers), but an identical
     * fold is what makes "mirrors STRIP" true rather than approximate.
     */
    private static String stripNormalize(String s) {
        StringBuilder sb = new StringBuilder(s.length());
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c >= 'a' && c <= 'z') sb.append((char) (c - 32));
            else if ((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')) sb.append(c);
        }
        return sb.toString();
    }

    /**
     * Word-break: can {@code target} be segmented into two or more dictionary entries?
     * Returns the member names in order, or null. Word-break rather than a pairwise
     * scan so a three-way collision (A + B + C == ABC) is caught too.
     */
    private static List<String> segmentInto(String target, List<String> dictMembers,
                                            List<String> dictStripped) {
        int n = target.length();
        List<List<String>> best = new ArrayList<>(Collections.nCopies(n + 1, (List<String>) null));
        best.set(0, new ArrayList<>());
        for (int i = 0; i < n; i++) {
            List<String> prefix = best.get(i);
            if (prefix == null) continue;
            for (int d = 0; d < dictStripped.size(); d++) {
                String sv = dictStripped.get(d);
                int end = i + sv.length();
                if (end > n || !target.startsWith(sv, i)) continue;
                List<String> cand = new ArrayList<>(prefix);
                cand.add(dictMembers.get(d));
                List<String> cur = best.get(end);
                if (cur == null || cand.size() < cur.size()) best.set(end, cand);
            }
        }
        List<String> full = best.get(n);
        // Two or more segments: a single-segment match is just another member that
        // strips to the same string — a different (duplicate) concern.
        return (full != null && full.size() >= 2) ? full : null;
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

        // --- Own @intValueMap content check (optional) ---
        // Independent of the @values own/inherited branching below — an @intValueMap
        // owned by this node is validated here against the node's EFFECTIVE @values
        // (own or inherited via extends), mirroring the TS/C# port structure exactly.
        validateEnumIntValueMap(node);

        // --- @intValueMap is scalar-only (design D7, narrowed) ---
        // Separate from the content check above because it must fire on the node that
        // combines the two halves, which is NOT necessarily the node declaring the map.
        validateEnumIntValueMapNotArray(node);

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
            // #246: own @values + extends a shared root-level abstract enum is a
            // conflict — one shared enum type has one member set, so codegen's
            // shared-enum collapse would silently drop this field's own @values in
            // favor of the shared type's. Own-attrs-only (matches the check above):
            // only fires when THIS node declares @values itself, not when it merely
            // inherits.
            MetaData sup = sharedEnumSuper(node);
            if (sup != null) {
                throw new MetaDataException(
                    ErrorMessageConstants.ERR_ENUM_EXTENDS_VALUES_CONFLICT
                        + ": field.enum '" + node.getName()
                        + "' extends shared abstract enum '" + sup.getName()
                        + "' AND declares its own @values - a shared enum's member set is"
                        + " owned by the shared declaration; remove the own @values to"
                        + " inherit it, or extend a non-shared enum instead",
                    ErrorCode.ERR_ENUM_EXTENDS_VALUES_CONFLICT, node.getSource());
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
     * Own {@code @intValueMap} content validation for a {@code field.enum} node.
     *
     * <p>Optional. Own-only (mirrors the {@code @values}/FR-011 own-attrs-only policy)
     * — an inherited {@code @intValueMap} is validated on its declaring node. The
     * generic "is this an object of integers" shape check already ran via
     * {@link com.metaobjects.attr.IntMapAttribute} at parse time (its
     * {@code setValueAsString}/{@code setValueAsObject} reject a non-integer member
     * with {@link com.metaobjects.attr.InvalidAttributeValueException}, which the
     * parser's strict-mode catch re-wraps as {@code ERR_BAD_ATTR_VALUE}); this method
     * validates the field.enum-SPECIFIC semantics: key-set-equals-effective-@values,
     * and no two members share the same int value.</p>
     */
    /**
     * The shared-enum super of {@code node}, or null when it has none.
     *
     * <p>"Shared" (FR-019 / #246) means the immediate super is abstract AND declared at
     * metadata-root — its parent is the {@link MetaRoot}, not an object. Such a declaration
     * is materialized ONCE per port as a single named type, so anything a consuming field
     * re-declares that belongs to the shared TYPE's contract (its {@code @values} member
     * set, or the {@code @intValueMap} integer backing of that set) is a conflict.
     *
     * <p>Immediate-super-only, matching codegen's {@code Fr019SharedEnum.resolveSharedEnumDecl}
     * so the validator and the shared-enum collapse agree on what "shared" means.
     */
    private static MetaData sharedEnumSuper(MetaData node) {
        MetaData sup = node.getSuperData();
        return (sup != null && isAbstract(sup) && sup.getParent() instanceof MetaRoot) ? sup : null;
    }

    /**
     * {@code @intValueMap} is scalar-only (design D7, narrowed).
     *
     * <p>Int-backing is a persistence-layer CODEC, and no port implements it element-wise
     * over an array column: OMDB's {@code EnumCodec} and Kotlin's {@code customEnumeration}
     * are scalar by construction, Python would bind the symbol LIST straight into an
     * {@code integer[]}, and TypeScript's sqlite branch serializes an array as JSON text
     * before the enum case is reached. Two ports that happen to compose (TS/Postgres, C#)
     * are not a feature — shipping a claim four ports silently get wrong is the
     * {@code field.byte}/{@code short}/{@code class} mistake.</p>
     *
     * <p>BOTH halves are read RESOLVING, unlike {@link #validateEnumIntValueMap}: the
     * illegal thing is the EFFECTIVE combination. Post-#246 the map must live on the shared
     * abstract declaration, so the field that inherits it is exactly where {@code isArray}
     * gets declared — an own-only read would see the two halves on different nodes and
     * never fire.</p>
     */
    private static void validateEnumIntValueMapNotArray(MetaData node) {
        // hasMetaAttr defaults to includeParentData=true → RESOLVING.
        if (!node.hasMetaAttr(EnumField.ATTR_INT_VALUE_MAP)) return;
        if (!(node instanceof MetaField) || !((MetaField) node).isArrayType()) return;
        throw new MetaDataException(
            ErrorMessageConstants.ERR_ENUM_INT_VALUE_MAP_ARRAY
                + ": field.enum '" + node.getName() + "' declares @"
                + EnumField.ATTR_INT_VALUE_MAP + " with isArray=true; int-backing is"
                + " scalar-only - an array-of-enum persists its member symbols."
                + " Remove @" + EnumField.ATTR_INT_VALUE_MAP + ", or make the field scalar.",
            ErrorCode.ERR_ENUM_INT_VALUE_MAP_ARRAY, node.getSource());
    }

    private static void validateEnumIntValueMap(MetaData node) {
        if (!node.hasMetaAttr(EnumField.ATTR_INT_VALUE_MAP, false)) {
            return;
        }

        // #246 (int-backed twin): the symbol->int mapping is a property of the enum
        // VOCABULARY, not of one column that uses it - it is @values' numeric half. A
        // shared enum is materialized once as a single type, so a per-field map would give
        // one logical type N storage encodings (and, where a port emits per-TYPE codec
        // artifacts, two same-named declarations). Same remedy as the @values half:
        // declare it on the shared declaration and inherit it.
        MetaData sharedSuper = sharedEnumSuper(node);
        if (sharedSuper != null) {
            throw new MetaDataException(
                ErrorMessageConstants.ERR_ENUM_EXTENDS_VALUES_CONFLICT
                    + ": field.enum '" + node.getName()
                    + "' extends shared abstract enum '" + sharedSuper.getName()
                    + "' AND declares its own @" + EnumField.ATTR_INT_VALUE_MAP
                    + " - a shared enum's integer backing is owned by the shared declaration;"
                    + " move @" + EnumField.ATTR_INT_VALUE_MAP + " onto '" + sharedSuper.getName()
                    + "' to inherit it, or extend a non-shared enum instead",
                ErrorCode.ERR_ENUM_EXTENDS_VALUES_CONFLICT, node.getSource());
        }

        @SuppressWarnings("unchecked")
        Map<String, Integer> intValueMap = (Map<String, Integer>)
            node.getMetaAttr(EnumField.ATTR_INT_VALUE_MAP, false).getValue();
        if (intValueMap == null) {
            return;
        }

        List<String> effective = effectiveEnumValues(node);
        Set<String> memberSet = new HashSet<>(effective);
        Set<String> keySet = intValueMap.keySet();

        List<String> missing = effective.stream().filter(m -> !keySet.contains(m)).toList();
        List<String> extra = keySet.stream().filter(k -> !memberSet.contains(k)).toList();
        if (!missing.isEmpty() || !extra.isEmpty()) {
            throw new MetaDataException(
                ErrorMessageConstants.ERR_BAD_ATTR_VALUE
                    + ": field.enum '" + node.getName() + "' attribute '@" + EnumField.ATTR_INT_VALUE_MAP
                    + "' keys must exactly match '@" + EnumField.ATTR_VALUES + "' members"
                    + (missing.isEmpty() ? "" : " (missing: " + String.join(", ", missing) + ")")
                    + (extra.isEmpty() ? "" : " (unknown: " + String.join(", ", extra) + ")") + ".",
                ErrorCode.ERR_BAD_ATTR_VALUE, node.getSource());
        }

        Map<Integer, String> seenValues = new HashMap<>();
        for (Map.Entry<String, Integer> entry : intValueMap.entrySet()) {
            Integer value = entry.getValue();
            String owner = seenValues.putIfAbsent(value, entry.getKey());
            if (owner != null) {
                throw new MetaDataException(
                    ErrorMessageConstants.ERR_BAD_ATTR_VALUE
                        + ": field.enum '" + node.getName() + "' attribute '@" + EnumField.ATTR_INT_VALUE_MAP
                        + "' members '" + owner + "' and '" + entry.getKey()
                        + "' share the same value " + value + "; every member must have a unique int.",
                    ErrorCode.ERR_BAD_ATTR_VALUE, node.getSource());
            }
        }
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
    //   1. The value must be one of the closed set uuid|jsonb
    //      → ERR_BAD_ATTR_VALUE otherwise. (The timestamp_with_tz value was retired
    //        in ADR-0036 Wave 2 — it now trips Rule 1 as an unrecognized value.)
    //   2. The value's legal (subtype × dbColumnType) pairing must hold:
    //        uuid  → field.string
    //        jsonb → field.string
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
        // ADR-0039 physical exception: @dbColumnType is NEVER inherited (a physical
        // column-type override is not a logical property) — the one attribute deliberately
        // read own-only outside the emit-declared-here cases. Own-only here validates only
        // the declaration that carries it.
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
            default -> null; // unreachable — Rule 1 already rejected unknown values
        };
        if (requiredSubType != null && !requiredSubType.equals(subType)) {
            throw new MetaDataException(
                ErrorMessageConstants.ERR_BAD_ATTR_VALUE
                    + ": field '" + node.getName()
                    + "' @" + CoreDBMetaDataProvider.DB_COLUMN_TYPE + " '" + value
                    + "' is not valid on field." + subType
                    + " (requires field." + requiredSubType + "); allowed pairings: "
                    + "uuid→field.string, jsonb→field.string",
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
    //   @role must be one of MetaSource.VALID_ROLES: primary / replica
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
                        // Derived from the registered set (sorted for a deterministic
                        // message — Set.of iteration order is unspecified) so the
                        // diagnostic can never drift from MetaSource.VALID_ROLES again.
                        + "' is not a valid value; allowed: "
                        + String.join(", ", new TreeSet<>(MetaSource.VALID_ROLES)),
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
        // ADR-0039 (declaration-layer check, own-only is correct): the one-primary
        // rule is enforced per DECLARED node — each object in the extends chain is
        // walked separately, so we count only THIS node's own source children (an
        // inherited primary belongs to the parent's own validation). getSources(false)
        // is the explicit own-only form (the no-arg getSources() now RESOLVES).
        java.util.Collection<MetaSource> sources = obj.getSources(false);

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

        // FR-024 B4b (ADR-0028) — THE HARD CUTOVER: an entity's PRIMARY source must be
        // a writable kind; read-only kinds (view/materializedView/storedProc/
        // tableFunction) are legal only in non-primary (read) roles. A derived read
        // model is an object.projection. Mirrors TS validate-source-roles.ts.
        if (MetaObject.SUBTYPE_ENTITY.equals(obj.getSubType())) {
            for (MetaSource s : sources) {
                if (MetaSource.ROLE_PRIMARY.equals(s.getRole()) && s.isReadOnly()) {
                    throw new MetaDataException(
                        "entity \"" + obj.getName() + "\" has a primary source of read-only kind \""
                            + s.getEffectiveKind() + "\" — read-only kinds are legal only in "
                            + "non-primary roles; a derived read model is an object.projection "
                            + "(FR-024, ADR-0028)",
                        ErrorCode.ERR_ENTITY_PRIMARY_SOURCE_READONLY, s.getSource());
                }
            }
        }
    }

    // =========================================================================
    // #208 — DDL-ownership escape valves (@sql / @unmanaged on source.rdb).
    //
    // source.rdb has two mutually exclusive, non-default DDL-ownership markers:
    // @sql (a hand-written body the tool registers/fingerprints/drift-checks but
    // never authors or parses) and @unmanaged (this object's DDL is owned
    // elsewhere — the tool never touches it). Six fail-closed rules (design doc §5):
    //
    //   R1  @sql AND @unmanaged on the SAME source           → ERR_SQL_BODY_WITH_UNMANAGED
    //   R2  @sql on a writable @kind ("table", the default)  → ERR_SQL_BODY_ON_WRITABLE_KIND
    //   R3  @sql present but empty / whitespace-only         → ERR_BAD_ATTR_VALUE
    //   R4  origin.*-bearing own field under an @sql host    → ERR_ORIGIN_UNDER_SQL_BODY
    //   R5  object.projection @filter (#207) + @sql host     → ERR_ORIGIN_UNDER_SQL_BODY
    //   R6  origin.*-bearing own field under an @unmanaged host → WARN_ORIGIN_UNDER_UNMANAGED
    //
    // R1–R3 are per-source (declaration-layer, own-only). R4–R6 are per-host-object:
    // a host with ANY own source.rdb carrying @sql/@unmanaged is judged against its
    // own fields (and, for R5, its own @filter). @sql (R4, hard error) takes priority
    // over @unmanaged (R6, warn) when a host declares both markers across different
    // sources. Mirrors TS validate-source-escapes.ts.
    // =========================================================================

    static void validateSourceEscapes(MetaRoot root, MetaDataLoader loader) {
        for (MetaData rootChild : root.getChildren(MetaData.class, false)) {
            if (!(rootChild instanceof MetaObject)) continue;
            validateObjectSourceEscapes((MetaObject) rootChild, loader);
        }
    }

    private static void validateObjectSourceEscapes(MetaObject obj, MetaDataLoader loader) {
        // ADR-0039: own — declaration-layer source iteration (mirrors
        // validateObjectSourcePhysicalNames / validateObjectPrimarySource): R1–R3
        // judge markers DECLARED on this object's own sources.
        List<RdbSource> sources = obj.getChildren(RdbSource.class, false);

        boolean hasSqlHost = false;
        boolean hasUnmanagedHost = false;

        for (RdbSource source : sources) {
            // ADR-0039: resolving — @sql/@unmanaged are inheritable (follow the
            // @role/effectiveKind precedent — sources are inheritable, NOT the
            // @dbColumnType own-only exception).
            boolean sqlSet = source.getSqlBody() != null;
            boolean unmanagedSet = source.isUnmanaged();

            // R1 — contradictory DDL owners on the same source.
            if (sqlSet && unmanagedSet) {
                throw new MetaDataException(
                    ErrorMessageConstants.ERR_SQL_BODY_WITH_UNMANAGED
                        + ": source.rdb on object \"" + obj.getName()
                        + "\" declares both @sql and @unmanaged — these are the mutually "
                        + "exclusive non-default states of one DDL-ownership axis (an "
                        + "author-supplied body contradicts \"someone else owns this DDL\")",
                    ErrorCode.ERR_SQL_BODY_WITH_UNMANAGED, source.getSource());
            }

            // R2 — @sql on a writable kind would bypass the column-diff machinery;
            // tables are fully modeled or @unmanaged, never opaque-bodied.
            if (sqlSet && source.isWritable()) {
                throw new MetaDataException(
                    ErrorMessageConstants.ERR_SQL_BODY_ON_WRITABLE_KIND
                        + ": source.rdb on object \"" + obj.getName()
                        + "\" declares @sql with a writable @kind (\"" + source.getEffectiveKind()
                        + "\") — @sql is legal only on a read-only kind "
                        + "(view/materializedView/storedProc/tableFunction); a writable table is "
                        + "either fully modeled or marked @unmanaged, never opaque-bodied",
                    ErrorCode.ERR_SQL_BODY_ON_WRITABLE_KIND, source.getSource());
            }

            // R3 — @sql present but empty/whitespace. MUST read the raw attr, not
            // getSqlBody(): getSqlBody() already narrows an empty string to null,
            // which would make a present-but-empty @sql indistinguishable from an
            // absent one.
            if (source.hasMetaAttr(RdbSource.ATTR_SQL)) {
                String rawSql = source.getMetaAttr(RdbSource.ATTR_SQL).getValueAsString();
                if (rawSql == null || rawSql.trim().isEmpty()) {
                    throw new MetaDataException(
                        ErrorMessageConstants.ERR_BAD_ATTR_VALUE
                            + ": source.rdb on object \"" + obj.getName()
                            + "\" sets @sql to an empty/whitespace-only value; @sql requires a "
                            + "non-empty SQL body",
                        ErrorCode.ERR_BAD_ATTR_VALUE, source.getSource());
                }
            }

            if (sqlSet) hasSqlHost = true;
            if (unmanagedSet) hasUnmanagedHost = true;
        }

        if (!hasSqlHost && !hasUnmanagedHost) return;

        // R4 / R6 — origin.*-bearing (derived) own fields under an @sql / @unmanaged
        // host. ADR-0039: own — origin.* never inherits (ADR-0029), so isDerived()
        // is own-only by policy (mirrors validateDerivedFieldProvidability). @sql
        // (hard error) takes priority over @unmanaged (warn) when a host happens to
        // declare both markers across different sources.
        for (MetaField<?> field : obj.getChildren(MetaField.class, false)) {
            if (!field.isDerived()) continue;
            if (hasSqlHost) {
                throw new MetaDataException(
                    ErrorMessageConstants.ERR_ORIGIN_UNDER_SQL_BODY
                        + ": field \"" + obj.getName() + "." + field.getName()
                        + "\" carries an origin.* (derived) child, but \"" + obj.getName()
                        + "\" has a read source carrying @sql — the synthesized derivation and "
                        + "the author's verbatim SQL are two sources of truth for the same body",
                    ErrorCode.ERR_ORIGIN_UNDER_SQL_BODY, field.getSource());
            } else if (loader != null) {
                loader.addEnvelopeWarning(new LoaderWarning(
                    ErrorMessageConstants.WARN_ORIGIN_UNDER_UNMANAGED,
                    "field \"" + obj.getName() + "." + field.getName()
                        + "\" carries an origin.* (derived) child, but \"" + obj.getName()
                        + "\" has a source marked @unmanaged — the tool never touches this "
                        + "object's DDL, so the derivation is documented lineage only (not "
                        + "acted on); this is informational, not an error",
                    field.getSource()));
            }
        }

        // R5 — a projection's row-scope @filter (#207) lowers to the outer WHERE of
        // a TOOL-SYNTHESIZED body; with @sql the author owns the body (and its
        // WHERE), so wrapping it is deferred cleverness (design doc D5) — reject.
        if (hasSqlHost && MetaObject.SUBTYPE_PROJECTION.equals(obj.getSubType())) {
            // ADR-0039: own — the @filter is declared locally on this projection
            // (mirrors validateProjectionFilter).
            if (obj.hasMetaAttr(MetaObject.ATTR_FILTER, false)) {
                throw new MetaDataException(
                    ErrorMessageConstants.ERR_ORIGIN_UNDER_SQL_BODY
                        + ": projection \"" + obj.getName()
                        + "\" declares both @filter and an @sql read source — a view-level "
                        + "@filter lowers to the outer WHERE of a synthesized body; with @sql "
                        + "the author owns the body (and its WHERE), so the two cannot be combined",
                    ErrorCode.ERR_ORIGIN_UNDER_SQL_BODY, obj.getSource());
            }
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
        validateReferenceIdentityActions(node);
        for (MetaData child : node.getChildren(MetaData.class, false)) {
            walkRelationshipReferentialActions(child);
        }
    }

    /**
     * ADR-0047 — validate {@code @onDelete} / {@code @onUpdate} declared directly on an
     * {@code identity.reference} (the explicit per-FK override). Same closed value set
     * as the relationship-level attrs ({@link MetaRelationship#REFERENTIAL_ACTIONS});
     * an out-of-set value throws {@code ERR_BAD_ATTR_VALUE}, matching the other ports'
     * generic allowedValues enforcement.
     */
    private static void validateReferenceIdentityActions(MetaData node) {
        if (!(node instanceof ReferenceIdentity)) {
            return;
        }
        ReferenceIdentity ref = (ReferenceIdentity) node;

        if (node.hasMetaAttr(MetaIdentity.ATTR_ON_DELETE, false)) {
            String onDelete = ref.getOnDeleteRaw();
            if (!MetaRelationship.REFERENTIAL_ACTIONS.contains(onDelete)) {
                throw new MetaDataException(
                    ErrorMessageConstants.ERR_BAD_ATTR_VALUE
                        + ": identity.reference '" + node.getName()
                        + "' @onDelete '" + onDelete
                        + "' is not a valid value; allowed: cascade, set-null, restrict, no-action",
                    ErrorCode.ERR_BAD_ATTR_VALUE, node.getSource());
            }
        }

        if (node.hasMetaAttr(MetaIdentity.ATTR_ON_UPDATE, false)) {
            String onUpdate = ref.getOnUpdateRaw();
            if (!MetaRelationship.REFERENTIAL_ACTIONS.contains(onUpdate)) {
                throw new MetaDataException(
                    ErrorMessageConstants.ERR_BAD_ATTR_VALUE
                        + ": identity.reference '" + node.getName()
                        + "' @onUpdate '" + onUpdate
                        + "' is not a valid value; allowed: cascade, set-null, restrict, no-action",
                    ErrorCode.ERR_BAD_ATTR_VALUE, node.getSource());
            }
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
        // ADR-0042 — a bare @through / @objectRef self-join resolves in the declaring
        // entity's package (an FQN resolves exactly).
        String referrerPkg = obj.getPackage() == null ? "" : obj.getPackage();
        // ADR-0039: resolving — a relationship may inherit its M:N slim-vocabulary
        // attrs (@through/@sourceRefField/@objectRef/@cardinality/@symmetric) via
        // extends. Mirrors TS validateRelationships (validation-passes.ts:1320-1324),
        // which reads them all through the resolving rel.attr(...). The getThrough()/
        // getSourceRefField()/isSymmetric()/getObjectRef()/getCardinality() getters
        // use the no-arg (resolving) getMetaAttr, so an inherited M:N relationship is
        // validated identically to a declared one.
        String through = rel.getThrough();
        String sourceRefField = rel.getSourceRefField();
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
        // ADR-0042: resolve @objectRef and compare NODE IDENTITY — a bare "Widget" in this
        // package is self, but an FQN "other::Widget" (a different same-short-name entity) is
        // NOT (comparing stripped short names would misclassify it).
        boolean isSelfJoin = objectRef != null
            && resolveRootObject(root, objectRef, referrerPkg) == obj;
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
        // ADR-0042: @through resolves package-locally when bare, exactly when FQN — a bare
        // cross-package @through no longer binds a junction in another package.
        MetaObject junction = resolveRootObject(root, through, referrerPkg);
        if (junction == null) {
            throw new MetaDataException(
                ErrorMessageConstants.ERR_INVALID_RELATIONSHIP
                    + ": relationship \"" + obj.getShortName() + "." + rel.getShortName()
                    + "\" @" + MetaRelationship.ATTR_THROUGH + " \"" + through
                    + "\" does not resolve to an entity." + didYouMeanHint(root, through),
                ErrorCode.ERR_INVALID_RELATIONSHIP,
                ResolvedSource.from(rel.getSource(), obj.getShortName() + "::" + rel.getShortName(), through));
        }
        // A junction is a physical join table — it MUST be an object.entity. ADR-0046
        // lets a value carry navigation-only references, so value-purity no longer
        // implicitly guarantees a two-reference junction is an entity; assert it here.
        // (A value/projection has no table to join through.)
        if (!MetaObject.SUBTYPE_ENTITY.equals(junction.getSubType())) {
            throw new MetaDataException(
                ErrorMessageConstants.ERR_INVALID_RELATIONSHIP
                    + ": relationship \"" + obj.getShortName() + "." + rel.getShortName()
                    + "\" @" + MetaRelationship.ATTR_THROUGH + " \"" + through
                    + "\" resolves to " + junction.getType() + "." + junction.getSubType()
                    + ", not an entity — a junction is a persisted join table and must be object.entity.",
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

    /** Count a junction's {@code identity.reference} children.
     *  ADR-0039: resolving — a junction may inherit an {@code identity.reference}
     *  via extends, so the FK direction/count must be judged on the EFFECTIVE view.
     *  Mirrors TS {@code _countJunctionReferences} → {@code referenceIdentities()}
     *  (validation-passes.ts:1293-1309) and the M2MFields.derive resolving
     *  {@code getIdentities()}. Own-only would drop an inherited reference and
     *  falsely reject a well-formed junction. */
    private static int countJunctionReferences(MetaObject junction) {
        int n = 0;
        for (MetaIdentity child : junction.getIdentities()) {
            if (MetaIdentity.SUBTYPE_REFERENCE.equals(child.getSubType())) {
                n++;
            }
        }
        return n;
    }

    /** The first {@code @fields} entry of each {@code identity.reference} child
     *  (the physical FK column on the junction), in declaration order.
     *  ADR-0039: resolving — see {@link #countJunctionReferences}. */
    private static List<String> junctionReferenceFkFields(MetaObject junction) {
        List<String> out = new java.util.ArrayList<>();
        for (MetaIdentity child : junction.getIdentities()) {
            if (!MetaIdentity.SUBTYPE_REFERENCE.equals(child.getSubType())) continue;
            List<String> fields = child.getFields();
            if (!fields.isEmpty()) out.add(fields.get(0));
        }
        return out;
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

        // ADR-0039: @objectRef is an EFFECTIVE property — a concrete field.object may
        // inherit it from an abstract field.object via `extends`. Resolve (default
        // includeParentData=true), else a concrete field extending an abstract
        // AddressBag(@objectRef) is falsely reported as ERR_OBJECT_FIELD_WITHOUT_OBJECT_REF.
        if (!node.hasMetaAttr(ObjectField.ATTR_OBJECTREF)) {
            throw new MetaDataException(
                ErrorMessageConstants.ERR_OBJECT_FIELD_WITHOUT_OBJECT_REF
                    + ": field.object '" + field.getName()
                    + "' has no @objectRef — a field.object requires @objectRef."
                    + " For an open/untyped JSON map use @dbColumnType: jsonb on a"
                    + " field.string instead of a bare object.",
                ErrorCode.ERR_OBJECT_FIELD_WITHOUT_OBJECT_REF, field.getSource());
        }

        // ADR-0039: @storage is also an effective property — resolve it.
        if (!node.hasMetaAttr(ObjectField.ATTR_STORAGE)) return;

        Object storageVal = node.getMetaAttr(ObjectField.ATTR_STORAGE).getValue();
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
    // field.map value-type validation
    //
    // Mirrors the TS validateFieldMap pass (server/typescript/packages/metadata/
    // src/loader/validation-passes.ts). A field.map is an open-keyed map
    // ({@code Map<String, V>}) stored in a single jsonb column. Keys are always
    // strings; the value type is set by EXACTLY ONE of @valueType (a scalar value
    // subtype) or @objectRef (a value-object). This pass enforces that
    // exactly-one-of rule and that @valueType (when set) names a known scalar
    // subtype. Cross-port parity: TS validateFieldMap, Python _validate_field_map,
    // C# ValidateFieldMap. Both violations report ERR_BAD_ATTR_VALUE.
    // =========================================================================

    /** The scalar value subtypes a field.map's @valueType may name. */
    private static final java.util.Set<String> MAP_SCALAR_VALUE_SUBTYPES = java.util.Set.of(
        StringField.SUBTYPE_STRING,
        IntegerField.SUBTYPE_INT,
        LongField.SUBTYPE_LONG,
        DoubleField.SUBTYPE_DOUBLE,
        FloatField.SUBTYPE_FLOAT,
        DecimalField.SUBTYPE_DECIMAL,
        BooleanField.SUBTYPE_BOOLEAN,
        DateField.SUBTYPE_DATE,
        TimeField.SUBTYPE_TIME,
        TimestampField.SUBTYPE_TIMESTAMP,
        UuidField.SUBTYPE_UUID);

    static void validateFieldMap(MetaRoot root) {
        walkFieldMap(root);
    }

    private static void walkFieldMap(MetaData node) {
        validateFieldMapNode(node);
        for (MetaData child : node.getChildren(MetaData.class, false)) {
            walkFieldMap(child);
        }
    }

    private static void validateFieldMapNode(MetaData node) {
        if (!(node instanceof MapField)) return;

        MapField field = (MapField) node;

        String valueType = attrStringOrNull(node, MapField.ATTR_VALUE_TYPE);
        boolean hasValueType = valueType != null && !valueType.isEmpty();
        String objectRef = attrStringOrNull(node, MapField.ATTR_OBJECTREF);
        boolean hasObjectRef = objectRef != null && !objectRef.isEmpty();

        if (hasValueType == hasObjectRef) {
            throw new MetaDataException(
                ErrorMessageConstants.ERR_BAD_ATTR_VALUE
                    + ": field.map '" + field.getName()
                    + "' must set exactly one of @valueType (a scalar value subtype)"
                    + " or @objectRef (a value-object); "
                    + (hasValueType ? "both are set" : "neither is set"),
                ErrorCode.ERR_BAD_ATTR_VALUE, field.getSource());
        }

        if (hasValueType && !MAP_SCALAR_VALUE_SUBTYPES.contains(valueType)) {
            throw new MetaDataException(
                ErrorMessageConstants.ERR_BAD_ATTR_VALUE
                    + ": field.map '" + field.getName()
                    + "' has @valueType \"" + valueType + "\" which is not a scalar"
                    + " value subtype (string/int/long/double/float/decimal/boolean/"
                    + "date/time/timestamp/uuid). For a value-object-valued map use"
                    + " @objectRef instead.",
                ErrorCode.ERR_BAD_ATTR_VALUE, field.getSource());
        }
    }

    /**
     * The resolving attr string value (@valueType/@objectRef are EFFECTIVE properties
     * that may be inherited via extends — ADR-0039), or null when absent. Default
     * includeParentData=true.
     */
    private static String attrStringOrNull(MetaData node, String attrName) {
        if (!node.hasMetaAttr(attrName)) return null;
        return node.getMetaAttr(attrName).getValueAsString();
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

        // FR-024 B5: an object.value host is EXEMPT from @via inference + cardinality
        // (a value's origin.passthrough is FR-015 parameter lineage, not assembly).
        boolean isValueHost = MetaObject.SUBTYPE_VALUE.equals(obj.getSubType());

        // #210 — assembly origins live on projections. A value-hosted field may not
        // carry origin.aggregate / origin.computed / origin.first:
        // a value is constructed — by a caller or by embedding — never assembled from
        // a backing store. origin.passthrough STAYS legal on a value (FR-015 parameter
        // lineage; the B5 exemption above).
        if (isValueHost && MetaOrigin.ASSEMBLY_ORIGIN_SUBTYPES.contains(subType)) {
            throw new MetaDataException(
                "ERR_SUBTYPE_RULE_VIOLATION"
                    + ": value object '" + obj.getName() + "' field '" + field.getName()
                    + "' hosts origin." + subType + " — assembly origins (aggregate, computed, "
                    + "collection, first) live on object.projection; a value is constructed by a "
                    + "caller or by embedding, never assembled from a backing store. Re-host this "
                    + "field on a sourceless object.projection; origin.passthrough (FR-015 "
                    + "parameter lineage) remains legal on a value (#210, ADR-0028).",
                ErrorCode.ERR_SUBTYPE_RULE_VIOLATION, origin.getSource());
        }

        if (PassthroughOrigin.SUBTYPE_PASSTHROUGH.equals(subType)) {
            String from = origin.getFrom();
            if (from == null || from.isEmpty()) {
                throw new MetaDataException(
                    ErrorMessageConstants.ERR_INVALID_ORIGIN
                        + ": origin.passthrough on " + obj.getName() + "." + field.getName()
                        + ": missing @from.",
                    ErrorCode.ERR_INVALID_ORIGIN, origin.getSource());
            }
            OriginTarget fromTarget = validateFromOrOfPath(from, root, obj, field.getName(),
                "origin.passthrough.@from", origin.getSource());
            // FR-024 B6 — extends/origin agreement (host-agnostic; before via/inference).
            checkExtendsOriginAgreement(field, fromTarget.field, from, obj, origin.getSource());
            // #185 — passthrough is type-preserving unless @convert acknowledges a change
            // (host-agnostic; runs whether @via is explicit, inferred, or a base column).
            checkPassthroughType(field, fromTarget.field, from, origin.isConvert(), obj, origin.getSource());
            String via = origin.getVia();
            if (via != null && !via.isEmpty()) {
                java.util.List<MetaData> hops =
                    validateViaPath(via, root, obj, field.getName(), origin.getSource());
                checkPassthroughCardinality(hops, obj, field.getName(), origin.getSource());
            } else if (!isValueHost) {
                // FR-024 §6 — no @via: derive the base entity; a @from targeting the
                // base relation itself is a plain base column; else infer single-hop.
                MetaObject base = deriveBaseEntity(obj, root, field.getName(), origin.getSource());
                if (base != null && !isBaseRelationTarget(fromTarget.entity, base, obj)) {
                    java.util.List<MetaData> hops = inferViaSingleHop(
                        base, fromTarget.entity, obj, field.getName(), from,
                        "origin.passthrough.@from", origin.getSource());
                    checkPassthroughCardinality(hops, obj, field.getName(), origin.getSource());
                }
            }
            return;
        }

        if (AggregateOrigin.SUBTYPE_AGGREGATE.equals(subType)) {
            com.metaobjects.source.ErrorSource src = origin.getSource();
            // Re-check @agg vocabulary — the .withEnum constraint on the base
            // can be subverted by inline attribute parsing paths; mirror the
            // belt-and-braces approach used for relationship referential actions.
            String agg = origin.getAgg();
            if (agg != null && !agg.isEmpty() && !MetaOrigin.AGGREGATE_FUNCTIONS.contains(agg)) {
                throw new MetaDataException(
                    ErrorMessageConstants.ERR_BAD_ATTR_VALUE
                        + ": origin.aggregate on " + obj.getName() + "." + field.getName()
                        + " @agg '" + agg + "' is not a valid value; allowed: "
                        + "count, sum, avg, min, max, any, all, collect",
                    ErrorCode.ERR_BAD_ATTR_VALUE, src);
            }

            String of = origin.getOf();
            boolean ofPresent = of != null && !of.isEmpty();
            boolean hasFilter = origin.hasMetaAttr(MetaOrigin.ATTR_FILTER, false);
            boolean hasDistinct = origin.hasMetaAttr(MetaOrigin.ATTR_DISTINCT, false);
            boolean hasOrderBy = origin.hasMetaAttr(MetaOrigin.ATTR_ORDER_BY, false);
            boolean isPredicate = MetaOrigin.AGG_ANY.equals(agg) || MetaOrigin.AGG_ALL.equals(agg);
            boolean isCollect = MetaOrigin.AGG_COLLECT.equals(agg);

            // --- #195 field-shape rules ---
            // collect ⇒ the carrying field is an array (it produces a list); every
            // other @agg reduces to a scalar (the inverse rule closes a latent hole).
            if (isCollect && !field.isArrayType()) {
                throw new MetaDataException(
                    ErrorMessageConstants.ERR_INVALID_ORIGIN
                        + ": origin.aggregate @agg:collect on " + obj.getName() + "." + field.getName()
                        + ": the carrying field must be isArray:true (collect produces a list).",
                    ErrorCode.ERR_INVALID_ORIGIN, src);
            } else if (!isCollect && field.isArrayType()) {
                throw new MetaDataException(
                    ErrorMessageConstants.ERR_INVALID_ORIGIN
                        + ": origin.aggregate @agg:" + agg + " on " + obj.getName() + "." + field.getName()
                        + ": a non-collect aggregate reduces to a scalar — the field must be isArray:false.",
                    ErrorCode.ERR_INVALID_ORIGIN, src);
            }
            // any/all yield a boolean.
            if (isPredicate && !BooleanField.SUBTYPE_BOOLEAN.equals(field.getSubType())) {
                throw new MetaDataException(
                    ErrorMessageConstants.ERR_INVALID_ORIGIN
                        + ": origin.aggregate @agg:" + agg + " on " + obj.getName() + "." + field.getName()
                        + ": a predicate quantifier yields a boolean — the field must be field.boolean.",
                    ErrorCode.ERR_INVALID_ORIGIN, src);
            }

            // --- #195 attr-presence rules ---
            if (hasDistinct && !isCollect) {
                throw new MetaDataException(
                    ErrorMessageConstants.ERR_INVALID_ORIGIN
                        + ": origin.aggregate on " + obj.getName() + "." + field.getName()
                        + ": @distinct is valid only on @agg:collect.",
                    ErrorCode.ERR_INVALID_ORIGIN, src);
            }
            if (hasOrderBy && !isCollect) {
                throw new MetaDataException(
                    ErrorMessageConstants.ERR_INVALID_ORIGIN
                        + ": origin.aggregate on " + obj.getName() + "." + field.getName()
                        + ": @orderBy is valid only on @agg:collect.",
                    ErrorCode.ERR_INVALID_ORIGIN, src);
            }
            if (isCollect && hasDistinct && hasOrderBy) {
                throw new MetaDataException(
                    ErrorMessageConstants.ERR_INVALID_ORIGIN
                        + ": origin.aggregate @agg:collect on " + obj.getName() + "." + field.getName()
                        + ": @orderBy and @distinct are mutually exclusive — a distinct collect uses"
                        + " value-ascending order (explicit element order is meaningful only without dedupe).",
                    ErrorCode.ERR_INVALID_ORIGIN, src);
            }

            if (isPredicate) {
                // --- any/all: @filter REQUIRED, @of FORBIDDEN, @via REQUIRED (no @of
                // to infer the path from) + must be to-many. ---
                if (!hasFilter) {
                    throw new MetaDataException(
                        ErrorMessageConstants.ERR_INVALID_ORIGIN
                            + ": origin.aggregate @agg:" + agg + " on " + obj.getName() + "." + field.getName()
                            + ": a predicate quantifier requires @filter (the quantified predicate);"
                            + " \"does any related row exist\" is @agg:count.",
                        ErrorCode.ERR_INVALID_ORIGIN, src);
                }
                if (ofPresent) {
                    throw new MetaDataException(
                        ErrorMessageConstants.ERR_INVALID_ORIGIN
                            + ": origin.aggregate @agg:" + agg + " on " + obj.getName() + "." + field.getName()
                            + ": @of is forbidden — a quantifier ranges over rows, not a column"
                            + " (the predicate is @filter).",
                        ErrorCode.ERR_INVALID_ORIGIN, src);
                }
                String via = origin.getVia();
                if (via == null || via.isEmpty()) {
                    throw new MetaDataException(
                        ErrorMessageConstants.ERR_INVALID_ORIGIN
                            + ": origin.aggregate @agg:" + agg + " on " + obj.getName() + "." + field.getName()
                            + ": requires an explicit @via (a quantifier has no @of to infer the path from).",
                        ErrorCode.ERR_INVALID_ORIGIN, src);
                }
                java.util.List<MetaData> hops =
                    validateViaPath(via, root, obj, field.getName(), src);
                checkAggregateCardinality(hops, obj, field.getName(), src);
                return;
            }

            // --- count/sum/avg/min/max/collect: @of REQUIRED ---
            if (!ofPresent) {
                throw new MetaDataException(
                    ErrorMessageConstants.ERR_INVALID_ORIGIN
                        + ": origin.aggregate on " + obj.getName() + "." + field.getName()
                        + ": missing @of.",
                    ErrorCode.ERR_INVALID_ORIGIN, src);
            }
            OriginTarget ofTarget = validateFromOrOfPath(of, root, obj, field.getName(),
                "origin.aggregate.@of", src);
            // #195 — collect preserves the element type: the array field's own subType
            // must equal the @of column's subType (the #185 doctrine on the element).
            if (isCollect && !field.getSubType().equals(ofTarget.field.getSubType())) {
                throw new MetaDataException(
                    ErrorMessageConstants.ERR_INVALID_ORIGIN
                        + ": origin.aggregate @agg:collect on " + obj.getName() + "." + field.getName()
                        + ": field element type field." + field.getSubType()
                        + " does not match the @of column type field." + ofTarget.field.getSubType()
                        + " — collect preserves the element type.",
                    ErrorCode.ERR_INVALID_ORIGIN, src);
            }
            // @orderBy keys (collect only, non-distinct) resolve against the @of entity.
            if (isCollect && hasOrderBy && !hasDistinct) {
                validateOrderByKeys(originOrderBy(origin), ofTarget.entity, obj, field.getName(),
                    "origin.aggregate @agg:collect", src);
            }

            String via = origin.getVia();
            if (via != null && !via.isEmpty()) {
                java.util.List<MetaData> hops =
                    validateViaPath(via, root, obj, field.getName(), src);
                checkAggregateCardinality(hops, obj, field.getName(), src);
                return;
            }
            // FR-024 §6 — no @via on an aggregate: inference applies only when @of
            // targets a non-base entity; an aggregate over the base relation itself
            // still requires an explicit path. (A value host never reaches here —
            // the #210 assembly-origin check above already rejected it.)
            MetaObject base = deriveBaseEntity(obj, root, field.getName(), src);
            if (base == null) return; // base underivable — error already thrown
            if (isBaseRelationTarget(ofTarget.entity, base, obj)) {
                throw new MetaDataException(
                    ErrorMessageConstants.ERR_INVALID_ORIGIN
                        + ": origin.aggregate on " + obj.getName() + "." + field.getName()
                        + ": missing @via (aggregates require a relationship path).",
                    ErrorCode.ERR_INVALID_ORIGIN, src);
            }
            java.util.List<MetaData> hops = inferViaSingleHop(
                base, ofTarget.entity, obj, field.getName(), of,
                "origin.aggregate.@of", src);
            checkAggregateCardinality(hops, obj, field.getName(), src);
            return;
        }

        // origin.computed — #195: a row-level expression over the base entity's OWN
        // fields. No @via/@of (strict scoping already rejects them as ERR_UNKNOWN_ATTR).
        if (ComputedOrigin.SUBTYPE_COMPUTED.equals(subType)) {
            com.metaobjects.source.ErrorSource src = origin.getSource();
            // @expr is a required object-valued attr (ExpressionAttribute → Map).
            Object expr = origin.hasMetaAttr(MetaOrigin.ATTR_EXPR, false)
                ? origin.getMetaAttr(MetaOrigin.ATTR_EXPR, false).getValue() : null;
            if (!(expr instanceof Map)) {
                return; // schema requires @expr (ERR_MISSING_REQUIRED_ATTR fires elsewhere)
            }
            // Structural grammar (fail-closed unknown node) is validated HERE, not in
            // the attr class, so every port validates the closed grammar identically
            // (the other ports store @expr verbatim; TS/C#/Python/Kotlin mirror this pass).
            List<String> structural = ExpressionAttribute.validateExprNode(expr);
            if (!structural.isEmpty()) {
                throw new MetaDataException(
                    "ERR_UNKNOWN_EXPR_NODE"
                        + ": origin.computed on " + obj.getName() + "." + field.getName()
                        + ": " + structural.get(0),
                    ErrorCode.ERR_UNKNOWN_EXPR_NODE, src);
            }
            // Type inference against the base entity's EFFECTIVE fields (ADR-0039).
            MetaObject base = deriveBaseEntity(obj, root, field.getName(), src);
            if (base == null) return;
            final MetaObject baseEntity = base;
            ExpressionAttribute.InferResult inferred = ExpressionAttribute.inferExprType(
                expr, name -> resolvedFieldSubType(baseEntity, name));
            if (!inferred.errors.isEmpty()) {
                throw new MetaDataException(
                    ErrorMessageConstants.ERR_INVALID_ORIGIN
                        + ": origin.computed on " + obj.getName() + "." + field.getName()
                        + ": " + inferred.errors.get(0),
                    ErrorCode.ERR_INVALID_ORIGIN, src);
            }
            if (inferred.type != null && !inferred.type.equals(field.getSubType())) {
                throw new MetaDataException(
                    "ERR_COMPUTED_TYPE_MISMATCH"
                        + ": origin.computed on " + obj.getName() + "." + field.getName()
                        + ": @expr infers field." + inferred.type + " but the field is declared field."
                        + field.getSubType() + " — a computed column's type is derived from its"
                        + " expression and must match (no @convert escape).",
                    ErrorCode.ERR_COMPUTED_TYPE_MISMATCH, src);
            }
            return;
        }

        // origin.first — #195: pick one related row by @orderBy along @via, project @of.
        if (FirstOrigin.SUBTYPE_FIRST.equals(subType)) {
            com.metaobjects.source.ErrorSource src = origin.getSource();
            String of = origin.getOf();
            boolean ofPresent = of != null && !of.isEmpty();
            if (!ofPresent) {
                throw new MetaDataException(
                    ErrorMessageConstants.ERR_INVALID_ORIGIN
                        + ": origin.first on " + obj.getName() + "." + field.getName()
                        + ": missing @of.",
                    ErrorCode.ERR_INVALID_ORIGIN, src);
            }
            // The carrying field must NOT be @required — an empty related set (after
            // @filter) selects no row, so the value is null. ADR-0039: resolving.
            if (fieldIsRequired(field)) {
                throw new MetaDataException(
                    ErrorMessageConstants.ERR_INVALID_ORIGIN
                        + ": origin.first on " + obj.getName() + "." + field.getName()
                        + ": the field must not be @required — an empty related set (after @filter)"
                        + " yields null.",
                    ErrorCode.ERR_INVALID_ORIGIN, src);
            }
            OriginTarget ofTarget = validateFromOrOfPath(of, root, obj, field.getName(),
                "origin.first.@of", src);
            // #185 type-preservation: first projects the @of column unchanged, so the
            // field's subType must equal the @of column's subType (first is scalar).
            if (!field.getSubType().equals(ofTarget.field.getSubType())) {
                throw new MetaDataException(
                    ErrorMessageConstants.ERR_INVALID_ORIGIN
                        + ": origin.first on " + obj.getName() + "." + field.getName()
                        + ": field field." + field.getSubType() + " does not match the @of column field."
                        + ofTarget.field.getSubType() + " — first projects the column unchanged, so the"
                        + " types must match.",
                    ErrorCode.ERR_INVALID_ORIGIN, src);
            }
            // @via — explicit (validated + cardinality) or single-hop-unique inferred.
            String via = origin.getVia();
            if (via != null && !via.isEmpty()) {
                java.util.List<MetaData> hops =
                    validateViaPath(via, root, obj, field.getName(), src);
                checkAggregateCardinality(hops, obj, field.getName(), src);
            } else {
                // (A value host never reaches here — the #210 assembly-origin
                // check above already rejected origin.first on a value.)
                MetaObject base = deriveBaseEntity(obj, root, field.getName(), src);
                if (base != null && !isBaseRelationTarget(ofTarget.entity, base, obj)) {
                    java.util.List<MetaData> hops = inferViaSingleHop(
                        base, ofTarget.entity, obj, field.getName(), of,
                        "origin.first.@of", src);
                    checkAggregateCardinality(hops, obj, field.getName(), src);
                }
            }
            // @orderBy keys resolve against the related (@of) entity.
            validateOrderByKeys(originOrderBy(origin), ofTarget.entity, obj, field.getName(),
                "origin.first", src);
            return;
        }
    }

    /**
     * #195 — the resolving (effective) subType of {@code entity}'s field named
     * {@code name}, or {@code null} when no such field exists. Used by the
     * {@code origin.computed} type-inference resolver; walks inherited fields
     * (ADR-0039 resolving) so an expression may reference a field the base entity
     * inherits via {@code extends}.
     */
    private static String resolvedFieldSubType(MetaObject entity, String name) {
        for (MetaData c : entity.getChildren(MetaData.class, true)) {
            if (c instanceof MetaField && nameMatches(c, name)) {
                return c.getSubType();
            }
        }
        return null;
    }

    /**
     * #195 — the effective boolean value of a field's own {@code @required} attr
     * (resolving, ADR-0039). Mirrors the TS {@code field.attr(FIELD_ATTR_REQUIRED)
     * === true} check the {@code origin.first} rule uses — the {@code @required}
     * attr only, NOT a {@code validator.required} child.
     */
    private static boolean fieldIsRequired(MetaField<?> field) {
        if (!field.hasMetaAttr(MetaField.ATTR_REQUIRED)) return false;
        Object v = field.getMetaAttr(MetaField.ATTR_REQUIRED).getValue();
        return (v instanceof Boolean) ? (Boolean) v : Boolean.parseBoolean(String.valueOf(v));
    }

    /** #195 — the {@code asc}/{@code desc} order directions (mirrors the TS
     *  {@code SORT_ORDER_VALUES}). A bare {@code @orderBy} key needs no suffix. */
    private static final Set<String> SORT_ORDER_VALUES =
        Set.of("asc", "desc");

    /**
     * #195 — the own {@code @orderBy} keys of an origin as a {@code List<String>}
     * (each {@code 'field[:asc|desc]'}), or an empty list when absent. Handles both
     * the stored {@code List} (array-mode {@code StringAttribute}) and a
     * comma-delimited single string, mirroring {@link MetaIdentity#getFields()}.
     */
    private static List<String> originOrderBy(MetaOrigin origin) {
        if (!origin.hasMetaAttr(MetaOrigin.ATTR_ORDER_BY, false)) {
            return java.util.Collections.emptyList();
        }
        Object raw = origin.getMetaAttr(MetaOrigin.ATTR_ORDER_BY, false).getValue();
        if (raw instanceof List) {
            List<String> out = new java.util.ArrayList<>();
            for (Object o : (List<?>) raw) if (o != null) out.add(String.valueOf(o));
            return out;
        }
        if (raw instanceof String) {
            String s = ((String) raw).trim();
            if (s.isEmpty()) return java.util.Collections.emptyList();
            List<String> out = new java.util.ArrayList<>();
            for (String part : s.split(",")) {
                String t = part.trim();
                if (!t.isEmpty()) out.add(t);
            }
            return out;
        }
        return java.util.Collections.emptyList();
    }

    /**
     * #195 — validate {@code @orderBy} keys ({@code 'field[:asc|desc]'}) resolve
     * against the RELATED entity's effective fields (the entity reached via
     * {@code @via}/{@code @of}), and that any direction suffix is {@code asc}/{@code desc}.
     * Null placement is pinned (nulls-last) and carries no vocabulary. Shared by
     * {@code @agg:collect} (element order) and {@code origin.first} (row selection).
     * A {@code null} related entity means a prior error already fired — skip silently.
     * Mirrors the TS {@code _validateOrderByKeys}.
     */
    private static void validateOrderByKeys(List<String> orderBy, MetaObject relatedEntity,
            MetaObject obj, String fieldName, String label,
            com.metaobjects.source.ErrorSource originSource) {
        if (orderBy == null || relatedEntity == null) return;
        for (String raw : orderBy) {
            if (raw == null) continue;
            int colonIdx = raw.indexOf(':');
            String key = colonIdx == -1 ? raw : raw.substring(0, colonIdx);
            String dir = colonIdx == -1 ? null : raw.substring(colonIdx + 1);
            // ADR-0039: resolving — an ordering key may target an inherited field.
            MetaField<?> target = null;
            for (MetaData f : relatedEntity.getChildren(MetaData.class, true)) {
                if (f instanceof MetaField && nameMatches(f, key)) {
                    target = (MetaField<?>) f;
                    break;
                }
            }
            if (target == null) {
                throw new MetaDataException(
                    ErrorMessageConstants.ERR_INVALID_ORIGIN
                        + ": " + label + " on " + obj.getName() + "." + fieldName
                        + ": @orderBy key \"" + raw + "\" — no such field \"" + key
                        + "\" on " + relatedEntity.getName() + ".",
                    ErrorCode.ERR_INVALID_ORIGIN, originSource);
            }
            if (dir != null && !SORT_ORDER_VALUES.contains(dir)) {
                throw new MetaDataException(
                    ErrorMessageConstants.ERR_INVALID_ORIGIN
                        + ": " + label + " on " + obj.getName() + "." + fieldName
                        + ": @orderBy key \"" + raw + "\" — direction must be one of asc|desc.",
                    ErrorCode.ERR_INVALID_ORIGIN, originSource);
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
        // #342: identity.secondary keys off @fields XOR @expr, so an expression-keyed
        // unique index legitimately has no @fields. Only SECONDARY — a primary key or
        // an FK reference is always plain columns and carries no @expr at all. This
        // check is Java-only (TS/C#/Python have no bespoke equivalent), which is why
        // relaxing the registry declaration alone left Java refusing what the other
        // three ports accepted.
        if (!hasFields
                && identity instanceof SecondaryIdentity
                && hasNonBlankAttr(identity, SecondaryIdentity.ATTR_EXPR)) {
            hasFields = true;
        }
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
                // ADR-0039: resolving — an object may inherit a layout.dataGrid via
                // extends. Mirrors TS validateDataGridSortFields/FilterValues, which
                // find the layout on the EFFECTIVE child view (obj.children()) and
                // read its @defaultSortField/@filter resolving. Own-only would skip
                // validating an inherited grid entirely.
                for (MetaData c : obj.getChildren(MetaData.class, true)) {
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
            if (f.hasMetaAttr(ATTR_FILTERABLE, true)) {
                Object v = f.getMetaAttr(ATTR_FILTERABLE, true).getValue();
                boolean isFilterable =
                    (v instanceof Boolean) ? (Boolean) v
                    : (v instanceof String) ? "true".equalsIgnoreCase((String) v)
                    : false;
                if (isFilterable) filterable.add(f.getShortName());
            }
        }

        // @defaultSortField
        // ADR-0039: resolving — a grid may inherit @defaultSortField via extends
        // (TS validateDataGridSortFields reads layout.attr(...) resolving).
        if (grid.hasMetaAttr(DataGridLayout.ATTR_DEFAULT_SORT_FIELD)) {
            Object v = grid.getMetaAttr(DataGridLayout.ATTR_DEFAULT_SORT_FIELD).getValue();
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
        // ADR-0039: resolving — a grid may inherit @filter via extends
        // (TS validateDataGridFilterValues reads layout.attr(...) resolving).
        if (grid.hasMetaAttr(DataGridLayout.ATTR_FILTER)) {
            Object raw = grid.getMetaAttr(DataGridLayout.ATTR_FILTER).getValue();
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
        // opsForField, not opsForSubType — an int-backed field.enum (@intValueMap)
        // stores as an integer, so `like` is not in its band.
        java.util.Set<String> band =
            com.metaobjects.query.FilterOps.opsForField(field);
        // Any subtype without a declared band (already rejected upstream by
        // validateFilterableHasSupportedOps) falls through to the string-shape
        // band, preserving the prior default.
        return band.isEmpty() ? com.metaobjects.query.FilterOps.OPS_STRING : band;
    }

    // =========================================================================
    // #207 — projection row-scope @filter (view-level WHERE) reference validation
    //
    // A projection's @filter (a portable attr.filter object) scopes which rows the
    // derived view returns. Its field refs must name the projection's OWN declared
    // fields, and each must be ADDRESSABLE in a WHERE:
    //   - a plain (extends-bound / no-origin) or origin.passthrough or origin.computed
    //     field → addressable (a base/joined column, or an inlined row-level expression).
    //   - an aggregate-derived field (origin.aggregate / origin.first — anything
    //     OTHER than passthrough/computed) → NOT addressable: a WHERE runs before
    //     aggregation, so it cannot see an aggregate. Fail-closed → ERR_BAD_ATTR_FILTER.
    //   - a ref naming no declared field → dangling → ERR_BAD_ATTR_FILTER.
    //
    // Cross-port: mirrors TS validation-passes.ts (validateProjectionFilter). Only the two
    // CORE checks (dangling ref + aggregate-derived ref) are gated cross-port here; the TS
    // reference's operator-band + malformed-compose-shape checks are TS-only hardening and
    // are deliberately NOT mirrored (see fixtures/conformance/error-projection-filter-*).
    //
    // Own-attrs/own-children only: the @filter is declared locally (registered on
    // object.projection alone), and origin.* never inherits (ADR-0029).
    // =========================================================================

    static void validateProjectionFilter(MetaRoot root) {
        for (MetaData rootChild : root.getChildren(MetaData.class, false)) {
            if (!(rootChild instanceof MetaObject)) continue;
            MetaObject obj = (MetaObject) rootChild;
            if (!MetaObject.SUBTYPE_PROJECTION.equals(obj.getSubType())) continue;
            // ADR-0039: own — the @filter is declared locally on this projection.
            if (!obj.hasMetaAttr(MetaObject.ATTR_FILTER, false)) continue;
            Object raw = obj.getMetaAttr(MetaObject.ATTR_FILTER, false).getValue();
            // A non-object shape is rejected by the attr schema check (FilterAttribute).
            if (!(raw instanceof java.util.Map)) continue;

            // Classify the projection's OWN fields (the declared set IS the exposure —
            // FR-024/ADR-0028): aggregate-derived-ness by the field's OWN origin child.
            // origin.* never inherits (ADR-0029), so both reads are own (category 4).
            java.util.Set<String> declared = new java.util.HashSet<>();
            java.util.Set<String> aggregateDerived = new java.util.HashSet<>();
            for (MetaField<?> f : obj.getChildren(MetaField.class, false)) {
                String name = f.getShortName();
                declared.add(name);
                for (MetaData originChild : f.getChildren(MetaData.class, false)) {
                    if (!(originChild instanceof MetaOrigin)) continue;
                    String os = originChild.getSubType();
                    // Derived (not row-addressable) = any origin OTHER than
                    // passthrough/computed (aggregate/first/collection).
                    if (!PassthroughOrigin.SUBTYPE_PASSTHROUGH.equals(os)
                            && !ComputedOrigin.SUBTYPE_COMPUTED.equals(os)) {
                        aggregateDerived.add(name);
                    }
                }
            }
            checkProjectionFilterRefs(obj, (java.util.Map<?, ?>) raw, declared, aggregateDerived);
        }
    }

    private static void checkProjectionFilterRefs(MetaObject obj, java.util.Map<?, ?> filter,
                                                  java.util.Set<String> declared,
                                                  java.util.Set<String> aggregateDerived) {
        for (java.util.Map.Entry<?, ?> e : filter.entrySet()) {
            String key = e.getKey() == null ? "" : e.getKey().toString();
            // Compose keys — recurse into each sub-clause. Non-list / non-map elements are
            // skipped silently: malformed-compose-shape is TS-only hardening, not gated here.
            if ("and".equals(key) || "or".equals(key)) {
                if (e.getValue() instanceof Iterable) {
                    for (Object sub : (Iterable<?>) e.getValue()) {
                        if (sub instanceof java.util.Map) {
                            checkProjectionFilterRefs(obj, (java.util.Map<?, ?>) sub,
                                declared, aggregateDerived);
                        }
                    }
                }
                continue;
            }
            if (!declared.contains(key)) {
                throw new MetaDataException(
                    ErrorMessageConstants.ERR_BAD_ATTR_FILTER
                        + ": projection '" + obj.getShortName()
                        + "' @filter references '" + key + "', which is not a declared field of"
                        + " the projection. A view-level @filter may only reference the"
                        + " projection's own declared fields.",
                    ErrorCode.ERR_BAD_ATTR_FILTER, obj.getSource());
            }
            if (aggregateDerived.contains(key)) {
                throw new MetaDataException(
                    ErrorMessageConstants.ERR_BAD_ATTR_FILTER
                        + ": projection '" + obj.getShortName()
                        + "' @filter references '" + key + "', an aggregate-derived field."
                        + " A view-level WHERE runs before aggregation, so it cannot filter on"
                        + " an aggregate. Filter on a passthrough or computed field instead.",
                    ErrorCode.ERR_BAD_ATTR_FILTER, obj.getSource());
            }
        }
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
            // Effective (#56): a secondary index that inherits @fields via extends must
            // still contribute its indexed columns, or a filterable field gets a spurious
            // "without index" warning.
            if (!identity.hasMetaAttr(MetaIdentity.ATTR_FIELDS, true)) continue;
            Object raw = identity.getMetaAttr(MetaIdentity.ATTR_FIELDS, true).getValue();
            collectIdentityFields(raw, indexed);
        }

        for (MetaField field : fields) {
            if (!field.hasMetaAttr(ATTR_FILTERABLE, true)) continue;
            Object v = field.getMetaAttr(ATTR_FILTERABLE, true).getValue();
            boolean filterable =
                (v instanceof Boolean) ? (Boolean) v
                : (v instanceof String) ? "true".equalsIgnoreCase((String) v)
                : false;
            if (!filterable) continue;
            // @db.indexed: true is an explicit escape hatch — author asserts a
            // backing index exists (or will, when supported). Mirrors TS
            // validation-passes.ts:155.
            if (field.hasMetaAttr(ATTR_DB_INDEXED, true)) {
                Object iv = field.getMetaAttr(ATTR_DB_INDEXED, true).getValue();
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
                if (!field.hasMetaAttr(ATTR_FILTERABLE, true)) continue;
                Object v = field.getMetaAttr(ATTR_FILTERABLE, true).getValue();
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
    // Eager-throw — mirrors TS validateTemplatePayloadRefs and C# TemplateValidator.
    // ADR-0039: template attrs are read RESOLVING (templates CAN extend), matching
    // the TS reference and the merged codegen template decision.
    // Required-attr enforcement (formerly R1 for
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
        // (text|html|xml|csv|json|markdown|spreadsheet).
        // ADR-0039: resolving — a template may inherit @format via extends
        // (templates CAN extend; consistent with the merged codegen template
        // decision). TS handles @format via the resolving generic schema pass.
        if (template.hasMetaAttr(TemplateConstants.ATTR_FORMAT)) {
            String fmt = template.getMetaAttr(TemplateConstants.ATTR_FORMAT).getValueAsString();
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

        // R5 — @promptStyle (template.prompt only since ADR-0052, FR-010) must be in
        // the closed set (guide|inline|exampleOnly). Absent is fine; default is "guide".
        // ADR-0039: resolving — a template may inherit @promptStyle via extends.
        if (template.hasMetaAttr(TemplateConstants.ATTR_PROMPT_STYLE)) {
            String style = template.getMetaAttr(TemplateConstants.ATTR_PROMPT_STYLE)
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

        // R5b — @responseFormat (template.prompt only, ADR-0053) must be in the closed
        // set (json|xml). Absent is fine; default is "json". Deliberately NOT
        // ALLOWED_FORMATS: a reply is only ever parsed as JSON or XML, and registering
        // members nothing dispatches on is what ADR-0007 Amendment 2 forbids.
        // ADR-0039: resolving — a template may inherit @responseFormat via extends.
        if (template.hasMetaAttr(TemplateConstants.ATTR_RESPONSE_FORMAT)) {
            String respFmt = template.getMetaAttr(TemplateConstants.ATTR_RESPONSE_FORMAT)
                                     .getValueAsString();
            if (respFmt != null
                    && !TemplateConstants.ALLOWED_RESPONSE_FORMATS.contains(respFmt)) {
                throw new MetaDataException(
                    ErrorMessageConstants.ERR_BAD_ATTR_VALUE
                        + ": template '" + template.getName()
                        + "' @responseFormat '" + respFmt
                        + "' is not a valid value; allowed: "
                        + TemplateConstants.ALLOWED_RESPONSE_FORMATS,
                    ErrorCode.ERR_BAD_ATTR_VALUE, template.getSource());
            }
        }

        // R6 — @kind (template.output only, Task 1) closed-enum + conditional
        // ref requirements. @kind is a closed set (document|email); an email
        // requires @subjectRef + @htmlBodyRef; a document (or absent @kind)
        // requires @textRef. template.prompt always requires @textRef (its
        // renderable body). Mirrors TS validateTemplatePayloadRefs.
        if (TemplateConstants.SUBTYPE_OUTPUT.equals(subType)) {
            // ADR-0039: resolving — a template may inherit @kind and its part-refs
            // (@subjectRef/@htmlBodyRef/@textRef) via extends. Mirrors TS
            // validateTemplatePayloadRefs, which reads them via the resolving tmpl.attr(...).
            String kind = template.hasMetaAttr(TemplateConstants.ATTR_KIND)
                ? template.getMetaAttr(TemplateConstants.ATTR_KIND).getValueAsString()
                : null;
            // Closed-enum membership (absent → default "document").
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
                if (!template.hasMetaAttr(TemplateConstants.ATTR_SUBJECT_REF)) {
                    throw new MetaDataException(
                        ErrorMessageConstants.ERR_INVALID_TEMPLATE
                            + ": template '" + template.getName()
                            + "' @kind 'email' requires @subjectRef",
                        ErrorCode.ERR_INVALID_TEMPLATE, template.getSource());
                }
                if (!template.hasMetaAttr(TemplateConstants.ATTR_HTML_BODY_REF)) {
                    throw new MetaDataException(
                        ErrorMessageConstants.ERR_INVALID_TEMPLATE
                            + ": template '" + template.getName()
                            + "' @kind 'email' requires @htmlBodyRef",
                        ErrorCode.ERR_INVALID_TEMPLATE, template.getSource());
                }
            } else {
                // @kind absent or "document" → require @textRef so a document is
                // never bodyless. (An out-of-enum @kind already threw above.)
                if (!template.hasMetaAttr(TemplateConstants.ATTR_TEXT_REF)) {
                    throw new MetaDataException(
                        ErrorMessageConstants.ERR_INVALID_TEMPLATE
                            + ": template '" + template.getName()
                            + "' @kind 'document' requires @textRef",
                        ErrorCode.ERR_INVALID_TEMPLATE, template.getSource());
                }
            }
        } else if (TemplateConstants.SUBTYPE_PROMPT.equals(subType)) {
            // template.prompt always carries a renderable body via @textRef.
            // ADR-0039: resolving — @textRef may be inherited via extends.
            if (!template.hasMetaAttr(TemplateConstants.ATTR_TEXT_REF)) {
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

        // ADR-0042 — a bare @payloadRef resolves in the template's package (else root-level);
        // an FQN resolves exactly. No bare-tail cross-package fallback.
        // #210 — a template-level payload target widened to object.value OR a
        // sourceless object.projection (a SOURCED projection stays illegal).
        String referrerPkg = template.getPackage() == null ? "" : template.getPackage();
        MetaObject payloadVo = resolveRootObject(root, payloadRef, referrerPkg);
        if (payloadVo == null || !isLegalPayloadTarget(payloadVo)) {
            // FR5d — @payloadRef is a reference; emit format=resolved with
            // referrer=template bare (short) name to match TS/C#/Python (the
            // reference contract does not propagate the root `package:` to
            // root-level objects); target=the unresolved payloadRef string.
            throw new MetaDataException(
                ErrorMessageConstants.ERR_INVALID_TEMPLATE
                    + ": template '" + template.getName() + "' @payloadRef '" + payloadRef
                    + "' does not resolve to an object.value or sourceless object.projection at root",
                ErrorCode.ERR_INVALID_TEMPLATE,
                ResolvedSource.from(template.getSource(), template.getShortName(), payloadRef));
        }

        // #210 — nested payload targets stay value-only (see the helper's doctrine).
        checkNestedPayloadRefsValueOnly(payloadVo, root, new java.util.HashSet<>());

        // ADR-0052 — @responseRef obeys the SAME target rule as @payloadRef. It had no check at
        // all in this port while TypeScript validated it, so a @responseRef naming an
        // object.entity loaded clean here and failed there — and, once ADR-0052 made the inbound
        // codegen tier key on it, that ref reached a generator whose parser binds a record the
        // payload tier would not emit. Codegen also fails closed now, but a mistake this cheap to
        // make belongs at the loader, where every port sees it.
        // ADR-0039: getResponseRef() reads through getMetaAttr, which resolves via extends.
        if (template instanceof PromptTemplate promptTmpl) {
            String responseRef = promptTmpl.getResponseRef();
            if (responseRef != null && !responseRef.isEmpty()) {
                MetaObject responseVo = resolveRootObject(root, responseRef, referrerPkg);
                if (responseVo == null || !isLegalPayloadTarget(responseVo)) {
                    throw new MetaDataException(
                        ErrorMessageConstants.ERR_INVALID_TEMPLATE
                            + ": template '" + template.getName() + "' @responseRef '" + responseRef
                            + "' does not resolve to an object.value or sourceless object.projection at root",
                        ErrorCode.ERR_INVALID_TEMPLATE,
                        ResolvedSource.from(template.getSource(), template.getShortName(), responseRef));
                }
                // #210 — the response closure's nested targets stay value-only too.
                checkNestedPayloadRefsValueOnly(responseVo, root, new java.util.HashSet<>());
            }
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
     * #210 — a template-level payload target ({@code @payloadRef} / {@code @responseRef})
     * is an {@code object.value} OR a SOURCELESS {@code object.projection}. "Sourceless"
     * is the #248 persistability contract: no declared/inherited {@code source.*} child
     * (a concrete projection cannot inherit one — {@code ERR_PROJECTION_INHERITED_SOURCE}
     * — so for a concrete projection this is simply "no own source"). Mirrors the TS
     * {@code _isLegalPayloadTarget}.
     */
    private static boolean isLegalPayloadTarget(MetaObject obj) {
        if (MetaObject.SUBTYPE_VALUE.equals(obj.getSubType())) return true;
        if (!MetaObject.SUBTYPE_PROJECTION.equals(obj.getSubType())) return false;
        // ADR-0039: resolving (includeParentData=true) — a source anywhere in the
        // extends chain binds the projection to a backing store, which disqualifies
        // it as a payload shape.
        for (MetaData child : obj.getChildren(MetaData.class, true)) {
            if (child instanceof MetaSource) return false;
        }
        return true;
    }

    /**
     * #210 (carried forward from the #219/ADR-0044 adjudication) — NESTED payload
     * targets stay value-only: every {@code field.object @objectRef} reachable from a
     * template-level payload target must resolve to an {@code object.value}. The
     * template-level widen (sourceless projections) deliberately does NOT extend to
     * nested targets. Dangling refs are NOT reported here — the registry-derived
     * {@code @objectRef} resolution check already owns that failure. Mirrors the TS
     * {@code _checkNestedPayloadRefsValueOnly}.
     */
    private static void checkNestedPayloadRefsValueOnly(MetaObject payload, MetaRoot root,
                                                        Set<MetaObject> visited) {
        if (!visited.add(payload)) return;
        // ADR-0039: resolving (includeParentData=true) — a payload shape may inherit
        // fields via extends.
        for (MetaData child : payload.getChildren(MetaData.class, true)) {
            if (!(child instanceof ObjectField)) continue;
            // ADR-0039: resolving — @objectRef may be inherited via extends.
            if (!child.hasMetaAttr(ObjectField.ATTR_OBJECTREF)) continue;
            Object refVal = child.getMetaAttr(ObjectField.ATTR_OBJECTREF).getValue();
            String ref = refVal == null ? null : String.valueOf(refVal);
            if (ref == null || ref.isEmpty()) continue;
            // ADR-0042: a bare ref resolves in the DECLARING owner's package (an
            // inherited field resolves in the package that declared it).
            MetaData owner = child.getParent() instanceof MetaObject ? child.getParent() : payload;
            String ownerPkg = owner.getPackage() == null ? "" : owner.getPackage();
            MetaObject target = resolveRootObject(root, ref, ownerPkg);
            if (target == null) continue; // dangling — reported by the @objectRef resolution check
            if (!MetaObject.SUBTYPE_VALUE.equals(target.getSubType())) {
                throw new MetaDataException(
                    "ERR_SUBTYPE_RULE_VIOLATION"
                        + ": payload '" + payload.getName() + "' field '" + shortNameOf(child)
                        + "' @objectRef '" + ref + "' resolves to object." + target.getSubType()
                        + " — a nested payload target must be an object.value (template-level refs"
                        + " may also target a sourceless object.projection, nested refs may not)"
                        + " (#210, ADR-0028, ADR-0044).",
                    ErrorCode.ERR_SUBTYPE_RULE_VIOLATION, child.getSource());
            }
            checkNestedPayloadRefsValueOnly(target, root, visited);
        }
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
    /** FR-024 B5/B6 — the resolved target of a {@code @from}/{@code @of} ref: the
     *  named root entity and the resolved field node on it (inherited included). */
    private static final class OriginTarget {
        final MetaObject entity;
        final MetaField<?> field;
        OriginTarget(MetaObject entity, MetaField<?> field) { this.entity = entity; this.field = field; }
    }

    private static OriginTarget validateFromOrOfPath(String pathAttr, MetaRoot root,
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

        // ADR-0042 — a bare @from/@of head resolves in the projection's package.
        String referrerPkg = projection.getPackage() == null ? "" : projection.getPackage();
        MetaObject sourceObj = resolveRootObject(root, entityName, referrerPkg);
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
        MetaField<?> resolvedField = null;
        for (MetaData child : sourceObj.getChildren(MetaData.class, true)) {
            if (child instanceof MetaField && nameMatches(child, targetFieldName)) {
                resolvedField = (MetaField<?>) child;
                break;
            }
        }
        if (resolvedField == null) {
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
        return new OriginTarget(sourceObj, resolvedField);
    }

    /**
     * Validate a dotted path of the form
     * {@code "Entity.hop[.hop...]"}. The leading entity must exist at root; each
     * hop segment must name a {@code relationship.*} OR an {@code identity.reference}
     * (a reference-only forward FK) on the current entity. A relationship hop's
     * next entity comes from {@code @objectRef}; a reference hop's from
     * {@code @references} (FR-024). The resolved target must be an entity at root,
     * which becomes the next hop's current entity.
     */
    private static java.util.List<MetaData> validateViaPath(String viaAttr, MetaRoot root,
                                        MetaObject projection, String fieldName,
                                        com.metaobjects.source.ErrorSource envelope) {
        // FR5d — referrer is `<projection-bare-name>::<fieldName>` (matches
        // TS/C#/Python: bare entity name, not package-qualified).
        String projectionName = projection.getName();
        String referrer = projection.getShortName() + "::" + fieldName;
        java.util.List<MetaData> hops = new java.util.ArrayList<>();
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
        // ADR-0042 — a bare @via HEAD resolves in the projection's package.
        String referrerPkg = projection.getPackage() == null ? "" : projection.getPackage();
        String entityName = segments[0];
        MetaObject currentObj = resolveRootObject(root, entityName, referrerPkg);
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
            // FR-024: a hop may name a relationship OR a reference-only FK
            // (identity.reference) — the reference IS a navigable many-to-one edge.
            MetaRelationship rel = findRelationship(currentObj, relName);
            MetaData hop = (rel != null) ? rel : findReference(currentObj, relName);
            if (hop == null) {
                String prefix = String.join(".", validSegments);
                throw new MetaDataException(
                    ErrorMessageConstants.ERR_INVALID_ORIGIN
                        + ": origin.@via \"" + viaAttr + "\" on "
                        + projectionName + "." + fieldName
                        + ": no such relationship or reference \"" + relName
                        + "\" on " + currentObj.getName() + ". "
                        + "Deepest valid prefix was \"" + prefix + "\".",
                    ErrorCode.ERR_INVALID_ORIGIN,
                    ResolvedSource.from(envelope, referrer, viaAttr));
            }
            // Target entity: @objectRef (relationship) or @references (reference hop).
            String refTarget = hopTargetName(hop);
            if (refTarget == null || refTarget.isEmpty()) {
                String missingAttr = isReferenceHop(hop) ? "@references" : "@objectRef";
                String kind = isReferenceHop(hop) ? "reference" : "relationship";
                throw new MetaDataException(
                    ErrorMessageConstants.ERR_INVALID_ORIGIN
                        + ": origin.@via \"" + viaAttr + "\" on "
                        + projectionName + "." + fieldName
                        + ": " + kind + " \"" + relName + "\" on "
                        + currentObj.getName() + " is missing " + missingAttr + ".",
                    ErrorCode.ERR_INVALID_ORIGIN,
                    ResolvedSource.from(envelope, referrer, viaAttr));
            }
            // ADR-0042 — the hop target (@objectRef/@references) resolves in the package of the
            // entity that DECLARES the relationship/reference, i.e. currentObj (NOT the projection).
            String hopPkg = currentObj.getPackage() == null ? "" : currentObj.getPackage();
            MetaObject nextObj = resolveRootObject(root, refTarget, hopPkg);
            if (nextObj == null) {
                // FR5d — the hop's target points at a missing entity. This is the
                // @objectRef/@references-resolution edge of the via-path walk (the
                // "5th site" in FR5d's scope list for refs encountered transitively).
                // Target = the target value (the missing entity name).
                String kind = isReferenceHop(hop) ? "reference" : "relationship";
                throw new MetaDataException(
                    ErrorMessageConstants.ERR_INVALID_ORIGIN
                        + ": origin.@via \"" + viaAttr + "\" on "
                        + projectionName + "." + fieldName
                        + ": " + kind + " \"" + relName
                        + "\" points to non-existent entity \"" + refTarget + "\".",
                    ErrorCode.ERR_INVALID_ORIGIN,
                    ResolvedSource.from(envelope, referrer, refTarget));
            }
            validSegments.add(relName);
            hops.add(hop);
            currentObj = nextObj;
        }
        return hops;
    }

    // =========================================================================
    // ADR-0042 — package-local object-reference resolution.
    // =========================================================================

    /**
     * ADR-0042 — resolve a metadata OBJECT reference to a top-level {@link MetaObject}
     * under the package-local contract, or {@code null} when nothing matches:
     * <ul>
     *   <li><b>FQN</b> {@code ref} (contains {@code ::}) → EXACT match on the resolution
     *       key ({@link MetaData#getName()}). No bare-tail fallback, so an FQN pointing at
     *       one package never binds a same-named object in another.</li>
     *   <li><b>bare</b> {@code ref} (no {@code ::}) → the referrer's OWN package
     *       ({@code <referrerPkg>::<ref>}), else a root-level (empty-package) object whose
     *       resolution key IS {@code ref}. Package-local BEFORE root-level; no cross-package
     *       bare resolution, no globally-unique scan, no bare-tail fallback.</li>
     * </ul>
     * The single resolver every object-ref site shares (origin {@code @from}/{@code @of}/
     * {@code @via} heads + hops, relationship {@code @through}, template payload/response,
     * {@code @parameterRef}, extends-owner) so resolution is uniform. Mirrors the TS
     * {@code resolveObjectRef} + the loader symbol table.
     *
     * @param referrerPkg the effective package of the node carrying the ref ("" for root-level)
     */
    private static MetaObject resolveRootObject(MetaRoot root, String ref, String referrerPkg) {
        if (ref == null) return null;
        String pkg = (referrerPkg == null) ? "" : referrerPkg;
        if (ref.indexOf(MetaData.PKG_SEPARATOR) >= 0) {
            for (MetaData child : root.getChildren(MetaData.class, false)) {
                if (child instanceof MetaObject && ref.equals(child.getName())) {
                    return (MetaObject) child;
                }
            }
            return null;
        }
        String localKey = pkg.isEmpty() ? ref : pkg + MetaData.PKG_SEPARATOR + ref;
        MetaObject own = null;
        MetaObject rootLevel = null;
        for (MetaData child : root.getChildren(MetaData.class, false)) {
            if (!(child instanceof MetaObject)) continue;
            String key = child.getName();
            if (key == null) continue;
            if (key.equals(localKey)) own = (MetaObject) child;
            if (key.equals(ref)) rootLevel = (MetaObject) child;
        }
        if (own != null) return own;
        return localKey.equals(ref) ? null : rootLevel;
    }

    /** ADR-0042 §5 — a did-you-mean suffix for an UNRESOLVED object reference: the FQNs of
     *  same-short-name objects that DO exist (typically in other packages). Returns "" when
     *  none exist. Mirrors the TS {@code didYouMeanHint}. */
    private static String didYouMeanHint(MetaRoot root, String ref) {
        if (ref == null) return "";
        int sep = ref.lastIndexOf(MetaData.PKG_SEPARATOR);
        String shortName = (sep >= 0) ? ref.substring(sep + MetaData.PKG_SEPARATOR.length()) : ref;
        int dot = shortName.indexOf('.');
        if (dot >= 0) shortName = shortName.substring(0, dot);
        StringBuilder candidates = new StringBuilder();
        for (MetaData child : root.getChildren(MetaData.class, false)) {
            if (!(child instanceof MetaObject)) continue;
            if (!shortName.equals(child.getShortName())) continue;
            if (candidates.length() > 0) candidates.append(", ");
            candidates.append(child.getName());
        }
        if (candidates.length() == 0) return "";
        return " An object named \"" + shortName + "\" exists in: " + candidates
            + ". Qualify it with its package (FQN).";
    }

    /**
     * Find a relationship child on an object by name. Walks inherited children
     * (relationships declared on supers are visible to projections that extend
     * the base entity).
     *
     * <p>Matches a CHILD by its bare name via {@link #nameMatches}, since relationships
     * may be stored with the package prefix attached to {@code getName()}. (This resolves a
     * relationship/reference NAME within an already-resolved entity — distinct from the
     * package-local OBJECT resolution in {@link #resolveRootObject}.)</p>
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
     * Find an {@code identity.reference} (a forward-FK) by name — the "reference
     * hop" FR-024 allows in a {@code @via} path. The reference IS the FK (single
     * source of truth for direction + join column), so naming it in {@code @via}
     * navigates its many-to-one edge without a redundant {@code relationship.*}.
     * Walks inherited children (via extends/super), mirroring {@link #findRelationship}.
     * Mirrors the TS {@code _findReference} / Python {@code _find_reference}.
     */
    private static MetaIdentity findReference(MetaObject obj, String name) {
        for (MetaData child : obj.getChildren(MetaData.class, true)) {
            if (!(child instanceof MetaIdentity)) continue;
            if (!MetaIdentity.SUBTYPE_REFERENCE.equals(child.getSubType())) continue;
            if (nameMatches(child, name)) {
                return (MetaIdentity) child;
            }
        }
        return null;
    }

    /** True for an {@code identity.reference} node (a {@code @via} reference hop). */
    private static boolean isReferenceHop(MetaData hop) {
        return hop instanceof MetaIdentity
            && MetaIdentity.SUBTYPE_REFERENCE.equals(hop.getSubType());
    }

    /**
     * The target entity a {@code @via} hop points at: {@code @references} for a
     * reference hop (identity.reference), {@code @objectRef} for a relationship hop.
     * Returns {@code null} when the attr is absent.
     * Mirrors the TS {@code _hopTargetName} / Python {@code _hop_target_name}.
     */
    private static String hopTargetName(MetaData hop) {
        String attr = isReferenceHop(hop)
            ? MetaIdentity.ATTR_REFERENCES
            : MetaRelationship.ATTR_OBJECT_REF;
        return hop.hasMetaAttr(attr) ? hop.getMetaAttr(attr).getValueAsString() : null;
    }

    /**
     * True if {@code child}'s bare name matches {@code name}. Compares against
     * {@code getShortName()} first, then falls back to deriving the tail
     * segment from {@code getName()} (after the last {@code "::"}).
     */
    private static boolean nameMatches(MetaData child, String name) {
        String bare = shortNameOf(child);
        if (bare == null) return false;
        // This matches a CHILD NAME (a relationship/reference/field within an already-
        // resolved entity), NOT a top-level object ref. A FULLY-QUALIFIED name (contains
        // "::") matches the child's package-qualified name exactly; a bare name matches the
        // child's bare name. (Package-local OBJECT resolution — ADR-0042 — lives in
        // resolveRootObject / the SymbolTable, not here.)
        if (name.indexOf(MetaData.PKG_SEPARATOR) >= 0) {
            return name.equals(child.getName());
        }
        return name.equals(bare);
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
    // FR-024 B5/B6 — base-entity derivation, single-hop @via inference, origin
    // cardinality, and extends/origin agreement (spec §5–§6; ADR-0029 dec 5–7).
    // Mirrors TS validation-passes.ts / the Python port. Throw-first per pass.
    // =========================================================================

    /** A hop's effective @cardinality, or null when absent. A reference hop (a
     *  forward FK) is inherently to-one — a child names the parent it points at,
     *  so it is valid in a passthrough and (correctly) rejected in an aggregate.
     *  Mirrors TS {@code _hopCardinality} (returns CARDINALITY_ONE for a reference
     *  hop; else rel.attr → undefined when not declared): the conservative
     *  cardinality checks must never judge an undeclared relationship hop, so we
     *  read the RAW own attr rather than {@link MetaRelationship#getCardinality()}
     *  (which defaults to "one"). */
    private static String hopCardinality(MetaData rel) {
        if (isReferenceHop(rel)) return MetaRelationship.CARDINALITY_ONE;
        return rel.hasMetaAttr(MetaRelationship.ATTR_CARDINALITY)
            ? rel.getMetaAttr(MetaRelationship.ATTR_CARDINALITY).getValueAsString()
            : null;
    }

    /** Strip a package prefix from a dotted/qualified ref's leading segment. */
    private static String stripPkg(String ref) {
        int i = ref.lastIndexOf(MetaData.PKG_SEPARATOR);
        return (i >= 0) ? ref.substring(i + MetaData.PKG_SEPARATOR.length()) : ref;
    }

    /**
     * The entity NAMED by a node's dotted extends ref — the OWNER part of
     * {@code <owner>.<child>...} resolved as a root object. Differs from
     * {@code getSuperData().getParent()} when the resolved child is INHERITED:
     * {@code Product.id} selecting BaseEntity's identity must anchor Product
     * (what the author wrote), not BaseEntity (where it physically lives).
     */
    private static MetaObject refNamedOwner(MetaData node, MetaRoot root, String referrerPkg) {
        String ref = node.getAuthoredSuperRef();
        if (ref == null) return null;
        // Owner = everything before the child dot in the FINAL ::-segment (the object the
        // extends anchors at). ADR-0042: resolve it AS AUTHORED — an FQN owner
        // ("acme::Customer") resolves exactly, a bare owner ("Product") resolves in the
        // referrer's package. Do NOT strip the package to a bare tail.
        int lastSep = ref.lastIndexOf(MetaData.PKG_SEPARATOR);
        int segStart = (lastSep == -1) ? 0 : lastSep + MetaData.PKG_SEPARATOR.length();
        int dotInSeg = ref.indexOf('.', segStart);
        if (dotInSeg <= segStart) return null; // no dotted child owner
        return resolveRootObject(root, ref.substring(0, dotInSeg), referrerPkg);
    }

    /**
     * Derive the BASE entity a no-{@code @via} origin path anchors at (spec §5):
     * a non-projection host is its own base; a projection's base is the owner
     * entity of its extended identity (preferring the ref-named owner), else the
     * single distinct entity targeted by plain field-extends. Throws
     * ERR_AMBIGUOUS_PATH (&gt;1) / ERR_INVALID_ORIGIN (0) when underivable.
     */
    private static MetaObject deriveBaseEntity(MetaObject obj, MetaRoot root, String fieldName,
                                               com.metaobjects.source.ErrorSource originSource) {
        if (!MetaObject.SUBTYPE_PROJECTION.equals(obj.getSubType())) return obj;
        // ADR-0042 — a bare extends owner resolves in this projection's package.
        String referrerPkg = obj.getPackage() == null ? "" : obj.getPackage();

        for (MetaData ic : obj.getChildren(MetaData.class, false)) {
            if (!(ic instanceof MetaIdentity)) continue;
            MetaData extended = ic.getSuperData();
            if (extended != null && MetaIdentity.TYPE_IDENTITY.equals(extended.getType())) {
                MetaObject named = refNamedOwner(ic, root, referrerPkg);
                if (named != null) return named;
                MetaData owner = extended.getParent();
                if (owner instanceof MetaObject) return (MetaObject) owner;
            }
        }

        java.util.Set<MetaObject> targets = new java.util.LinkedHashSet<>();
        for (MetaData fc : obj.getChildren(MetaData.class, false)) {
            if (!(fc instanceof MetaField)) continue;
            MetaData sup = fc.getSuperData();
            if (sup == null) continue;
            MetaObject named = refNamedOwner(fc, root, referrerPkg);
            MetaData owner = (named != null) ? named : sup.getParent();
            if (owner instanceof MetaObject) {
                MetaObject mo = (MetaObject) owner;
                if (!MetaObject.SUBTYPE_VALUE.equals(mo.getSubType()) && mo != obj) targets.add(mo);
            }
        }
        if (targets.size() == 1) return targets.iterator().next();
        if (targets.size() > 1) {
            StringBuilder names = new StringBuilder();
            for (MetaObject t : targets) { if (names.length() > 0) names.append(", "); names.append('"').append(t.getName()).append('"'); }
            throw new MetaDataException(
                "ERR_AMBIGUOUS_PATH"
                    + ": origin on " + obj.getName() + "." + fieldName
                    + ": cannot derive the base entity — fields extend multiple entities ("
                    + names + ") and no identity extends an entity identity (FR-024).",
                ErrorCode.ERR_AMBIGUOUS_PATH, originSource);
        }
        throw new MetaDataException(
            ErrorMessageConstants.ERR_INVALID_ORIGIN
                + ": origin on " + obj.getName() + "." + fieldName
                + ": cannot derive the base entity for @via inference — declare an extended identity or an explicit @via (FR-024).",
            ErrorCode.ERR_INVALID_ORIGIN, originSource);
    }

    /** True when {@code target} is {@code base} or {@code host}, or on either's extends chain. */
    private static boolean isBaseRelationTarget(MetaObject target, MetaObject base, MetaObject host) {
        for (MetaData cur = base; cur != null; cur = cur.getSuperData()) if (cur == target) return true;
        for (MetaData cur = host; cur != null; cur = cur.getSuperData()) if (cur == target) return true;
        return false;
    }

    /**
     * Single-hop-unique @via inference (ADR-0029 dec 5): scan the base entity's
     * effective relationships for those whose @objectRef resolves to the target
     * entity. Exactly one → that hop. Zero → ERR_INVALID_ORIGIN. &gt;1 → ERR_AMBIGUOUS_PATH.
     */
    private static java.util.List<MetaData> inferViaSingleHop(
            MetaObject base, MetaObject targetEntity, MetaObject obj, String fieldName,
            String fromAttr, String label, com.metaobjects.source.ErrorSource originSource) {
        // FR-024: inference stays relationship-only — a single-hop-unique @via is
        // inferred over relationships, never references (two FKs to the same entity
        // would be ambiguous, and single-hop-unique must stay trivially portable).
        String targetBare = shortNameOf(targetEntity);
        java.util.List<MetaData> candidates = new java.util.ArrayList<>();
        for (MetaData c : base.getChildren(MetaData.class, true)) {
            if (!(c instanceof MetaRelationship)) continue;
            MetaRelationship rel = (MetaRelationship) c;
            String ref = rel.getObjectRef();
            if (ref != null && stripPkg(ref).equals(targetBare)) candidates.add(rel);
        }
        String referrer = obj.getShortName() + "::" + fieldName;
        if (candidates.size() == 1) return java.util.List.of(candidates.get(0));
        if (candidates.isEmpty()) {
            throw new MetaDataException(
                ErrorMessageConstants.ERR_INVALID_ORIGIN
                    + ": " + label + " \"" + fromAttr + "\" on " + obj.getName() + "." + fieldName
                    + ": no @via and no single-hop relationship from base \"" + base.getName()
                    + "\" to \"" + targetEntity.getName() + "\" — declare @via explicitly (ADR-0029).",
                ErrorCode.ERR_INVALID_ORIGIN,
                ResolvedSource.from(originSource, referrer, fromAttr));
        }
        throw new MetaDataException(
            "ERR_AMBIGUOUS_PATH"
                + ": " + label + " \"" + fromAttr + "\" on " + obj.getName() + "." + fieldName
                + ": no @via and " + candidates.size() + " relationships from base \"" + base.getName()
                + "\" to \"" + targetEntity.getName() + "\" — ambiguous; declare @via (ADR-0029).",
            ErrorCode.ERR_AMBIGUOUS_PATH,
            ResolvedSource.from(originSource, referrer, fromAttr));
    }

    /** ADR-0029 dec 6 — a passthrough via-path must be to-one at every hop. */
    private static void checkPassthroughCardinality(java.util.List<MetaData> hops,
            MetaObject obj, String fieldName, com.metaobjects.source.ErrorSource originSource) {
        for (MetaData rel : hops) {
            if (MetaRelationship.CARDINALITY_MANY.equals(hopCardinality(rel))) {
                throw new MetaDataException(
                    "ERR_ORIGIN_CARDINALITY"
                        + ": origin.passthrough on " + obj.getName() + "." + fieldName
                        + ": @via hop \"" + rel.getName() + "\" is to-many — you meant aggregate (ADR-0029).",
                    ErrorCode.ERR_ORIGIN_CARDINALITY, originSource);
            }
        }
    }

    /** ADR-0029 dec 6 — an aggregate via-path must have ≥1 to-many hop (conservative). */
    private static void checkAggregateCardinality(java.util.List<MetaData> hops,
            MetaObject obj, String fieldName, com.metaobjects.source.ErrorSource originSource) {
        if (hops.isEmpty()) return;
        boolean provablyToOne = true;
        for (MetaData rel : hops) {
            if (!MetaRelationship.CARDINALITY_ONE.equals(hopCardinality(rel))) { provablyToOne = false; break; }
        }
        if (provablyToOne) {
            throw new MetaDataException(
                "ERR_ORIGIN_CARDINALITY"
                    + ": origin.aggregate on " + obj.getName() + "." + fieldName
                    + ": every @via hop is to-one — you meant passthrough (ADR-0029).",
                ErrorCode.ERR_ORIGIN_CARDINALITY, originSource);
        }
    }

    /** FR-024 B6 — extends (shape) and origin.passthrough (data) lineage must agree. */
    private static void checkExtendsOriginAgreement(MetaField<?> field, MetaField<?> fromField,
            String fromAttr, MetaObject obj, com.metaobjects.source.ErrorSource originSource) {
        MetaData sup = field.getSuperData();
        if (!(sup instanceof MetaField)) return;
        MetaData supOwner = sup.getParent();
        if (!(supOwner instanceof MetaObject)) return;
        for (MetaData cur = sup; cur != null; cur = cur.getSuperData()) {
            if (cur == fromField) return; // shape + data lineage agree
        }
        String referrer = obj.getShortName() + "::" + field.getName();
        throw new MetaDataException(
            "ERR_EXTENDS_ORIGIN_MISMATCH"
                + ": origin.passthrough on " + obj.getName() + "." + field.getName()
                + ": @from \"" + fromAttr + "\" disagrees with the field's extends target \""
                + supOwner.getName() + "." + sup.getName() + "\" (FR-024).",
            ErrorCode.ERR_EXTENDS_ORIGIN_MISMATCH,
            ResolvedSource.from(originSource, referrer, fromAttr));
    }

    /**
     * #185 — passthrough is type-preserving. A field forwarding another field's value via
     * {@code origin.passthrough} must declare the SAME {@code field.<subType>} and the same
     * array-ness as its resolved {@code @from} source; differ → {@code ERR_PASSTHROUGH_TYPE_MISMATCH}.
     *
     * <p>Two axes: subtype ({@link MetaField#getSubType()}, intrinsic to the node) and array-ness
     * ({@link MetaField#isArrayType()} — the RESOLVING/effective flag, ADR-0039, so a field inheriting
     * its shape via {@code extends} is judged on its effective type; never the own-only
     * {@code isArray()}). Nullability is deliberately NOT compared (a view over an outer join
     * legitimately widens NOT NULL → nullable).</p>
     *
     * <p>Escape hatch: {@code @convert: true} on the passthrough acknowledges a deliberate type
     * change and suppresses the error (acknowledgement only — no generated cast). Host-agnostic
     * (projections, entities, values, and the FR-015 stored-proc parameter refs the retired
     * {@code ERR_PARAMETER_REF_PASSTHROUGH_TYPE_MISMATCH} used to cover). Envelope mirrors
     * {@link #checkExtendsOriginAgreement} exactly (resolved: referrer = {@code host::field},
     * target = the raw {@code @from}).</p>
     */
    private static void checkPassthroughType(MetaField<?> field, MetaField<?> fromField,
            String fromAttr, boolean convert, MetaObject obj,
            com.metaobjects.source.ErrorSource originSource) {
        if (convert) return; // deliberate type change acknowledged
        // Compare both axes at once via the type-label: subtype names never contain
        // "[]", so equal labels <=> same subType AND same array-ness.
        String declared = "field." + field.getSubType() + (field.isArrayType() ? "[]" : "");
        String source = "field." + fromField.getSubType() + (fromField.isArrayType() ? "[]" : "");
        if (declared.equals(source)) return;
        String referrer = obj.getShortName() + "::" + field.getName();
        throw new MetaDataException(
            "ERR_PASSTHROUGH_TYPE_MISMATCH"
                + ": origin.passthrough on " + obj.getName() + "." + field.getName()
                + ": field is " + declared + " but its @from source \"" + fromAttr
                + "\" is " + source + " — a passthrough forwards the value unchanged, so the "
                + "types must match. Declare " + source + ", or set @convert: true to "
                + "acknowledge a deliberate type change.",
            ErrorCode.ERR_PASSTHROUGH_TYPE_MISMATCH,
            ResolvedSource.from(originSource, referrer, fromAttr));
    }

    // =========================================================================
    // FR-024 B3/B4a — subtype rules: identity-name-required, value purity,
    // projection licensing. Mirrors TS subtype-rules.ts / the Python port.
    // =========================================================================

    static void validateSubtypeRules(MetaRoot root) {
        walkSubtypeRules(root);
    }

    private static void walkSubtypeRules(MetaData node) {
        // FR-024 D2 — every identity node needs an author-chosen name (any nesting).
        // This port auto-names a nameless identity (unlike TS/Python which leave
        // name === ""), so detect the omission via the parser's auto-named flag.
        if (node instanceof MetaIdentity && node.isAutoNamed()) {
            throw new MetaDataException(
                "ERR_IDENTITY_NAME_REQUIRED"
                    + ": identity." + node.getSubType()
                    + " has no name — identity nodes require an author-chosen name (FR-024).",
                ErrorCode.ERR_IDENTITY_NAME_REQUIRED, node.getSource());
        }
        if (node instanceof MetaObject) {
            MetaObject obj = (MetaObject) node;
            if (MetaObject.SUBTYPE_VALUE.equals(obj.getSubType())) {
                validateValuePurity(obj);
            } else if (MetaObject.SUBTYPE_PROJECTION.equals(obj.getSubType())) {
                validateProjectionLicensing(obj);
            }
        }
        for (MetaData child : node.getChildren(MetaData.class, false)) {
            walkSubtypeRules(child);
        }
    }

    /** A value object is a pure shape — NO identity of any subtype and NO source. */
    private static void validateValuePurity(MetaObject obj) {
        for (MetaData child : obj.getChildren(MetaData.class, true)) {
            // ADR-0046: a value MAY carry a navigation-only reference — an
            // identity.reference with explicit @enforce:false. Its target still
            // resolves (dangling → ERR_INVALID_REFERENCE via the registry pass) and
            // codegen emits no FK/DDL. Check ReferenceIdentity BEFORE the generic
            // MetaIdentity ban (it is a subclass). Its OWN identity (primary/secondary)
            // and any enforced reference (a physical FK it has no table to hold) stay banned.
            if (child instanceof ReferenceIdentity) {
                if (!((ReferenceIdentity) child).isEnforced()) continue;
                throw new MetaDataException(
                    "ERR_SUBTYPE_RULE_VIOLATION"
                        + ": value object '" + obj.getName() + "' has an enforced reference ("
                        + child.getType() + "." + child.getSubType() + ") — a value is not persisted "
                        + "and has no table to hold a physical FK; declare a navigation-only reference "
                        + "with @enforce: false (FR-024, ADR-0028, ADR-0046).",
                    ErrorCode.ERR_SUBTYPE_RULE_VIOLATION, child.getSource());
            }
            if (child instanceof MetaIdentity) {
                throw new MetaDataException(
                    "ERR_SUBTYPE_RULE_VIOLATION"
                        + ": value object '" + obj.getName() + "' must not have an identity ("
                        + child.getType() + "." + child.getSubType() + ") — use subType \"entity\" (FR-024).",
                    ErrorCode.ERR_SUBTYPE_RULE_VIOLATION, child.getSource());
            }
            if (child instanceof MetaSource) {
                throw new MetaDataException(
                    "ERR_SUBTYPE_RULE_VIOLATION"
                        + ": value object '" + obj.getName() + "' must not have a source — "
                        + "use subType \"entity\" or \"projection\" (FR-024).",
                    ErrorCode.ERR_SUBTYPE_RULE_VIOLATION, child.getSource());
            }
        }
    }

    /** A projection may only object-extend another projection; its sources must be read-only kinds. */
    private static void validateProjectionLicensing(MetaObject obj) {
        MetaData sup = obj.getSuperData();
        if (sup != null && !(MetaObject.TYPE_OBJECT.equals(sup.getType())
                && MetaObject.SUBTYPE_PROJECTION.equals(sup.getSubType()))) {
            throw new MetaDataException(
                "ERR_SUBTYPE_RULE_VIOLATION"
                    + ": projection '" + obj.getName() + "' extends '" + sup.getName() + "' which is "
                    + sup.getType() + "." + sup.getSubType() + " — a projection may only extend a projection (FR-024).",
                ErrorCode.ERR_SUBTYPE_RULE_VIOLATION, obj.getSource());
        }
        // A projection's extends is SHAPE lineage, not a shared-storage hierarchy, so a
        // CONCRETE projection must declare its own source rather than inherit one.
        // extends only ADDS members, so the child's extra fields have no provider in the
        // parent's view, and both objects would claim one physical view while declaring
        // different exposures (the declared field set IS the exposure, fail-closed).
        // Prior art splits the same way: shared-storage inheritance (@Inheritance, EF Core
        // TPH) inherits binding AND writability together; shape-reuse inheritance
        // (@MappedSuperclass, Django abstract bases) does not inherit the binding at all.
        // Enforced at the CONCRETE level (mirrors #236) — an abstract base carries shape
        // only, and a source on one is inert until a concrete child extends it.
        // Skipped when the super is not a legal projection: that trips the rule above and
        // inherits its source too, and one defect should yield one error.
        if (!isAbstract(obj) && sup != null
                && MetaObject.TYPE_OBJECT.equals(sup.getType())
                && MetaObject.SUBTYPE_PROJECTION.equals(sup.getSubType())) {
            int own = 0;
            for (MetaData c : obj.getChildren(MetaData.class, false)) {
                if (c instanceof MetaSource) own++;
            }
            int resolved = 0;
            for (MetaData c : obj.getChildren(MetaData.class, true)) {
                if (c instanceof MetaSource) resolved++;
            }
            if (resolved > own) {
                throw new MetaDataException(
                    "ERR_PROJECTION_INHERITED_SOURCE"
                        + ": projection '" + obj.getName() + "' inherits a source through extends "
                        + "instead of declaring its own — a projection's extends is shape lineage, "
                        + "not a shared-storage hierarchy. Declare the source on this projection; "
                        + "an abstract projection base carries shape only (FR-024, ADR-0028).",
                    ErrorCode.ERR_PROJECTION_INHERITED_SOURCE, obj.getSource());
            }
        }
        for (MetaData child : obj.getChildren(MetaData.class, false)) {
            if (!(child instanceof MetaSource)) continue;
            MetaSource s = (MetaSource) child;
            if (!MetaSource.READ_ONLY_KINDS.contains(s.getEffectiveKind())) {
                throw new MetaDataException(
                    "ERR_PROJECTION_SOURCE_WRITABLE"
                        + ": projection '" + obj.getName() + "' has a writable source (@kind \""
                        + s.getEffectiveKind() + "\") — projection sources must be read-only kinds (FR-024).",
                    ErrorCode.ERR_PROJECTION_SOURCE_WRITABLE, child.getSource());
            }
        }
    }

    // =========================================================================
    // FR-024 B3 — projection identity pass-through + key correspondence.
    // Mirrors TS validate-identity-passthrough.ts / the Python port.
    // =========================================================================

    static void validateIdentityPassthrough(MetaRoot root) {
        for (MetaData c : root.getChildren(MetaData.class, false)) {
            if (!(c instanceof MetaObject)) continue;
            MetaObject obj = (MetaObject) c;
            if (!MetaObject.SUBTYPE_PROJECTION.equals(obj.getSubType())) continue;
            for (MetaData ic : obj.getChildren(MetaData.class, false)) {
                if (!(ic instanceof MetaIdentity)) continue;
                MetaIdentity identity = (MetaIdentity) ic;
                if (identity.getAuthoredSuperRef() == null) {
                    throw new MetaDataException(
                        "ERR_PROJECTION_IDENTITY_NOT_EXTENDED"
                            + ": identity '" + identity.getName() + "' on projection '" + obj.getName()
                            + "' must extend an entity identity — a projection identity is a pass-through (FR-024).",
                        ErrorCode.ERR_PROJECTION_IDENTITY_NOT_EXTENDED, identity.getSource());
                }
                MetaData extended = identity.getSuperData();
                if (!(extended instanceof MetaIdentity)) continue; // unresolved/mismatch reported elsewhere
                MetaData entityNode = extended.getParent();
                if (!(entityNode instanceof MetaObject)) continue;
                MetaObject entity = (MetaObject) entityNode;

                java.util.List<String> extendedFields = ((MetaIdentity) extended).getFields();
                java.util.List<String> computed = new java.util.ArrayList<>();
                boolean missing = false;
                for (String fn : extendedFields) {
                    MetaField<?> entityField = findFieldByName(entity, fn);
                    if (entityField == null) { missing = true; break; }
                    MetaField<?> local = null;
                    for (MetaData oc : obj.getChildren(MetaData.class, false)) {
                        if (oc instanceof MetaField && extendsChainReaches(oc, entityField)) {
                            local = (MetaField<?>) oc; break;
                        }
                    }
                    if (local == null) { missing = true; break; }
                    computed.add(shortNameOf(local));
                }
                if (missing) {
                    throw new MetaDataException(
                        "ERR_IDENTITY_KEY_MISMATCH"
                            + ": identity '" + identity.getName() + "' on projection '" + obj.getName()
                            + "' does not correspond to its extended identity — every extended-identity field "
                            + "needs a pass-through field on the projection (FR-024).",
                        ErrorCode.ERR_IDENTITY_KEY_MISMATCH, identity.getSource());
                }
                java.util.List<String> explicit = identity.hasMetaAttr(MetaIdentity.ATTR_FIELDS, false)
                    ? identity.getFields() : null;
                if (explicit != null && !explicit.equals(computed)) {
                    throw new MetaDataException(
                        "ERR_IDENTITY_KEY_MISMATCH"
                            + ": identity '" + identity.getName() + "' on projection '" + obj.getName()
                            + "' declares @fields " + explicit + " but the computed pass-through key is "
                            + computed + " — omit @fields (it is derived) or make them agree (FR-024).",
                        ErrorCode.ERR_IDENTITY_KEY_MISMATCH, identity.getSource());
                }
            }
        }
    }

    private static MetaField<?> findFieldByName(MetaObject entity, String name) {
        for (MetaData c : entity.getChildren(MetaData.class, true)) {
            if (c instanceof MetaField && nameMatches(c, name)) return (MetaField<?>) c;
        }
        return null;
    }

    private static boolean extendsChainReaches(MetaData node, MetaData target) {
        for (MetaData cur = node.getSuperData(); cur != null; cur = cur.getSuperData()) {
            if (cur == target) return true;
        }
        return false;
    }

    // =========================================================================
    // FR-024 B6 — derived-field providability (spec §7). An object.entity field
    // carrying an origin.* is derived (read-only); the entity needs a read-capable
    // source to provide it. Mirrors TS validateDerivedFieldProvidability.
    // =========================================================================

    static void validateDerivedFieldProvidability(MetaRoot root) {
        for (MetaData c : root.getChildren(MetaData.class, false)) {
            if (!(c instanceof MetaObject)) continue;
            MetaObject obj = (MetaObject) c;
            if (!MetaObject.SUBTYPE_ENTITY.equals(obj.getSubType())) continue;
            boolean hasReadCapable = false;
            for (MetaSource s : obj.getSources(true)) {
                if (s.isReadOnly()) { hasReadCapable = true; break; }
            }
            if (hasReadCapable) continue;
            for (MetaData fc : obj.getChildren(MetaData.class, false)) {
                if (!(fc instanceof MetaField)) continue;
                boolean hasOrigin = false;
                for (MetaData oc : fc.getChildren(MetaData.class, false)) {
                    if (oc instanceof MetaOrigin) { hasOrigin = true; break; }
                }
                if (hasOrigin) {
                    throw new MetaDataException(
                        "ERR_DERIVED_FIELD_NO_READ_SOURCE"
                            + ": derived field \"" + obj.getName() + "." + fc.getName()
                            + "\" carries an origin.* but entity \"" + obj.getName()
                            + "\" declares no read-capable source — declare a read-only source "
                            + "or move the field to an object.projection (FR-024 §7).",
                        ErrorCode.ERR_DERIVED_FIELD_NO_READ_SOURCE, fc.getSource());
                }
            }
        }
    }

    // =========================================================================
    // FR-037 R1 — field-level @mutability cross-attribute rules.
    //   ERR_MUTABILITY_AUTOSET_CONFLICT / ERR_MUTABILITY_DOWNGRADE /
    //   ERR_READONLY_ASSIGNED_PRIMARY / WARN_MUTABILITY_VALUE_OBJECT /
    //   WARN_MUTABILITY_READONLY_HOST
    // Mirrors TS core/field/validate-field-mutability.ts.
    //
    // @mutability is ONE axis — who may write this field, and when — with three
    // mutually exclusive modes, readWrite (default) < writeOnce < readOnly.
    // Modelling it as one enum rather than two booleans is what makes the illegal
    // pair unrepresentable and gives inheritance a total order.
    // =========================================================================

    static void validateFieldMutability(MetaRoot root, MetaDataLoader loader) {
        for (MetaData rc : root.getChildren(MetaData.class, false)) {
            if (!(rc instanceof MetaObject)) continue;
            MetaObject obj = (MetaObject) rc;
            boolean isValueObject = MetaObject.SUBTYPE_VALUE.equals(obj.getSubType());
            boolean hostNeverWritten = writeHostIsReadOnly(obj);

            for (MetaField ownField : ownFieldsRaw(obj)) {
                String ownMode = declaredMutability(ownField);

                // 1) WARN_MUTABILITY_VALUE_OBJECT — a non-default mode DECLARED on a
                //    value's own field. Advisory: a value has no persistence semantics.
                if (isValueObject && ownMode != null
                        && !MetaField.MUTABILITY_READ_WRITE.equals(ownMode) && loader != null) {
                    loader.addEnvelopeWarning(new LoaderWarning(
                        ErrorMessageConstants.WARN_MUTABILITY_VALUE_OBJECT,
                        "field \"" + shortNameOf(ownField) + "\" on object.value \""
                            + shortNameOf(obj) + "\" declares @mutability: \"" + ownMode
                            + "\"; value objects have no persistence semantics, so the "
                            + "write contract is advisory (codegen may use it for "
                            + "record/struct treatment).",
                        ownField.getSource()));
                }

                // 2) ERR_MUTABILITY_DOWNGRADE — a subtype may TIGHTEN an inherited mode,
                //    never loosen it. Rank comparison over the declaration order.
                if (ownMode != null) {
                    MetaField inherited = inheritedMutabilityField(obj, shortNameOf(ownField));
                    String inheritedMode = inherited != null ? declaredMutability(inherited) : null;
                    if (inheritedMode != null && mutabilityRank(ownMode) < mutabilityRank(inheritedMode)) {
                        throw new MetaDataException(
                            "ERR_MUTABILITY_DOWNGRADE"
                                + ": field \"" + shortNameOf(ownField) + "\" on \""
                                + shortNameOf(obj) + "\" sets @mutability: \"" + ownMode
                                + "\", but its extends-chain parent declares \"" + inheritedMode
                                + "\". A subtype may only TIGHTEN an inherited mode ("
                                + String.join(" < ", MetaField.MUTABILITY_MODES)
                                + "), never loosen it (FR-037 R1).",
                            ErrorCode.ERR_MUTABILITY_DOWNGRADE, ownField.getSource());
                    }
                }
            }

            // Rules 3 + 5 read the EFFECTIVE tree — an inherited mode binds exactly as
            // hard as a declared one for "is this combination coherent?".
            for (MetaField f : obj.getChildren(MetaField.class, true)) {
                String mode = fieldMutability(f);

                // 3) ERR_MUTABILITY_AUTOSET_CONFLICT — @autoSet with a non-readWrite mode.
                //    Both arms: readOnly (representable-but-unvalidated in the boolean
                //    era) and writeOnce (new). @autoSet means the SERVER supplies the
                //    value, so constraining who ELSE may write it is contradictory.
                if (!MetaField.MUTABILITY_READ_WRITE.equals(mode)
                        && f.hasMetaAttr(MetaField.ATTR_AUTO_SET, true)) {
                    throw new MetaDataException(
                        "ERR_MUTABILITY_AUTOSET_CONFLICT"
                            + ": field \"" + shortNameOf(f) + "\" on \"" + shortNameOf(obj)
                            + "\" declares @autoSet together with @mutability: \"" + mode
                            + "\". @autoSet already means the SERVER supplies the value; "
                            + "@mutability says who may write it. Drop @mutability (an "
                            + "@autoSet field is already excluded from every input shape) "
                            + "or drop @autoSet (FR-037 R1).",
                        ErrorCode.ERR_MUTABILITY_AUTOSET_CONFLICT, f.getSource());
                }

                // 5) WARN_MUTABILITY_READONLY_HOST — writeOnce on a host nothing writes.
                if (MetaField.MUTABILITY_WRITE_ONCE.equals(mode) && hostNeverWritten && loader != null) {
                    loader.addEnvelopeWarning(new LoaderWarning(
                        ErrorMessageConstants.WARN_MUTABILITY_READONLY_HOST,
                        "field \"" + shortNameOf(f) + "\" on \"" + shortNameOf(obj)
                            + "\" declares @mutability: \"writeOnce\", but its host is never "
                            + "written (a projection, or a read-only source @kind). The "
                            + "declaration is inert — nothing creates a row here for it to "
                            + "be settable on.",
                        f.getSource()));
                }
            }

            // 4) ERR_READONLY_ASSIGNED_PRIMARY — readOnly on an ASSIGNED primary key.
            //    Note what is NOT here: writeOnce on an assigned key is legal, and is
            //    the natural declaration for one. That asymmetry is why this code keeps
            //    its readOnly-specific name.
            if (!isValueObject) {
                Set<String> assigned = primaryAssignedFieldNames(obj);
                if (!assigned.isEmpty()) {
                    for (MetaField f : obj.getChildren(MetaField.class, true)) {
                        if (!assigned.contains(shortNameOf(f))) continue;
                        if (!MetaField.MUTABILITY_READ_ONLY.equals(fieldMutability(f))) continue;
                        throw new MetaDataException(
                            "ERR_READONLY_ASSIGNED_PRIMARY"
                                + ": field \"" + shortNameOf(f) + "\" on \""
                                + shortNameOf(obj) + "\" is @mutability: \"readOnly\" AND the "
                                + "target of identity.primary with @generation: \"assigned\"; "
                                + "the application has no path to populate the identity "
                                + "value. Use @mutability: \"writeOnce\" if the intent is "
                                + "\"set once on create, never changed\" (FR-037 R1).",
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

    /**
     * A field's EFFECTIVE mutability mode. Absent =&gt; readWrite. THE accessor every
     * consumer should use, so the default lives in exactly one place per port.
     * ADR-0039: RESOLVING ({@code true} = include the super chain) — an own-only read
     * would report readWrite for a field whose abstract parent declared readOnly.
     */
    static String fieldMutability(MetaField field) {
        return field.getMutability();
    }

    /** The mode a node DECLARED (own), or null when it declared none.
     *  ADR-0039 sanctioned own: the downgrade rule needs the EXPLICIT mode on the
     *  DECLARING node — resolving would report a child's own value back at itself. */
    private static String declaredMutability(MetaField field) {
        if (!field.hasMetaAttr(MetaField.ATTR_MUTABILITY, false)) return null;
        Object v = field.getMetaAttr(MetaField.ATTR_MUTABILITY, false).getValue();
        return (v instanceof String && MetaField.MUTABILITY_MODES.contains(v)) ? (String) v : null;
    }

    /** Rank on the tightening order. Declaration order IS the order, so "may only
     *  tighten" is an index comparison rather than a lookup table. */
    private static int mutabilityRank(String mode) {
        return MetaField.MUTABILITY_MODES.indexOf(mode);
    }

    /** True when no write path reaches this object: an object.projection, or an
     *  object whose every source is a read-only {@code @kind}. */
    private static boolean writeHostIsReadOnly(MetaObject obj) {
        if (MetaObject.SUBTYPE_PROJECTION.equals(obj.getSubType())) return true;
        // ADR-0039: resolving — a source may be inherited via extends.
        List<MetaSource> sources = obj.getChildren(MetaSource.class, true);
        if (sources.isEmpty()) return false;
        for (MetaSource src : sources) {
            if (!src.isReadOnly()) return false;
        }
        return true;
    }

    /** Walk the extends chain for a field with {@code name}; return its declaring
     *  node (own attrs intact). */
    private static MetaField inheritedMutabilityField(MetaObject obj, String name) {
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
    //   ERR_PARAMETER_REF_ON_NON_CALLABLE_KIND / _UNRESOLVED / _NOT_VALUE_OBJECT.
    //   Passthrough type-matching on parameter fields is the universal
    //   ERR_PASSTHROUGH_TYPE_MISMATCH (retired the narrow parameter-ref code, #185).
    //   Mirrors TS persistence/source/validate-source-parameter-ref.ts.
    // =========================================================================

    private static final Set<String> CALLABLE_KINDS = Set.of(
        MetaSource.KIND_STORED_PROC, MetaSource.KIND_TABLE_FUNCTION);

    static void validateSourceParameterRef(MetaRoot root) {
        for (MetaData rc : root.getChildren(MetaData.class, false)) {
            if (!(rc instanceof MetaObject)) continue;
            MetaObject obj = (MetaObject) rc;
            // ADR-0042 — a bare @parameterRef resolves package-local (this object's package,
            // else root-level); an FQN resolves exactly. NO bare-name-anywhere fallback (which
            // would silently bind a same-named value-object in another package).
            String referrerPkg = obj.getPackage() == null ? "" : obj.getPackage();
            // ADR-0039: own — declaration-layer source iteration (mirrors TS
            // validateSourceParameterRef, which walks obj.ownChildren() sources).
            for (MetaSource source : obj.getSources(false)) {
                if (!RdbSource.SUBTYPE_RDB.equals(source.getSubType())) continue;
                // ADR-0039: resolving — a source may inherit @parameterRef via extends
                // (TS reads source.attr(...) resolving).
                String ref = source.hasMetaAttr(RdbSource.ATTR_PARAMETER_REF)
                    ? source.getMetaAttr(RdbSource.ATTR_PARAMETER_REF).getValueAsString() : null;
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

                MetaObject target = resolveRootObject(root, ref, referrerPkg);
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

                // #185 — the per-parameter-field passthrough type check (formerly
                // ERR_PARAMETER_REF_PASSTHROUGH_TYPE_MISMATCH here) is RETIRED: it is
                // generalized by the universal ERR_PASSTHROUGH_TYPE_MISMATCH, which
                // validateOrigins already applies to every origin.passthrough — including
                // the object.value parameter-shape fields resolved via @parameterRef.
            }
        }
    }

    // =========================================================================
    // Index-key resolution — index.lookup AND identity.secondary (#342)
    //
    // The key is @fields XOR @expr: exactly one must be DECLARED (Rule 1a), and
    // whichever is declared must actually supply a key (Rule 1b). Every named field
    // must exist in the entity's EFFECTIVE (resolved) field set — inherited fields
    // via extends: count as valid (Rule 2). @expr has no @fields to resolve; it is
    // raw SQL over the physical columns and is deliberately not parsed.
    //
    // identity.secondary is covered because per ADR-0040 uniqueness lives in the
    // TYPE — it IS a unique index and keys itself identically.
    //
    // ADR-0039: uses resolving getChildren(MetaField.class, true) so that fields
    // inherited via extends: are visible; mirrors the TS validateIndexLookupFields
    // (uses obj.children() = resolving). Own-only walk on object children so each
    // index.lookup is validated exactly once at its declaration site.
    //
    // Code: ERR_INVALID_INDEX.
    // =========================================================================

    static void validateIndexLookupFields(MetaRoot root) {
        for (MetaData rootChild : root.getChildren(MetaData.class, false)) {
            walkIndexLookupFields(rootChild);
        }
    }

    private static void walkIndexLookupFields(MetaData node) {
        if (node instanceof MetaObject) {
            validateObjectIndexLookupFields((MetaObject) node);
        }
        for (MetaData child : node.getChildren(MetaData.class, false)) {
            walkIndexLookupFields(child);
        }
    }

    private static void validateObjectIndexLookupFields(MetaObject obj) {
        // Build the effective (resolved) field name set — includes inherited fields.
        // ADR-0039: resolving — getChildren(MetaField.class, true).
        java.util.Set<String> effectiveFieldNames = new java.util.HashSet<>();
        for (com.metaobjects.field.MetaField f : obj.getChildren(com.metaobjects.field.MetaField.class, true)) {
            if (f.getName() != null) effectiveFieldNames.add(f.getName());
        }

        // Validate each own index.lookup / identity.secondary child (#342).
        //
        // The key is @fields XOR @expr. @expr has always been registered as "used
        // INSTEAD of @fields" (Index.ATTR_EXPR's own javadoc says @fields "may be
        // omitted when ATTR_EXPR provides a functional expression instead") and
        // migrate-ts has always keyed off it — only the loader required @fields
        // unconditionally, which made an expression index undeclarable. Declaring
        // BOTH previously loaded and had @fields silently discarded downstream,
        // which is the silent-wrong-output the strict registry exists to prevent.
        //
        // identity.secondary is included because per ADR-0040 uniqueness lives in
        // the TYPE — identity.secondary IS a unique index and keys itself the same
        // way, carrying @expr from the same db provider.
        for (MetaData child : obj.getChildren(MetaData.class, false)) {
            final java.util.List<String> fields;
            if (child instanceof LookupIndex) {
                fields = ((LookupIndex) child).getFields();
            } else if (child instanceof SecondaryIdentity) {
                fields = ((SecondaryIdentity) child).getFields();
            } else {
                continue;
            }
            // Derived, not hardcoded per branch — matches the other three ports and
            // leaves one place to update if a third keyed type is ever added.
            final String label = child.getType() + "." + child.getSubType();
            final boolean hasExpr = hasNonBlankAttr(child, Index.ATTR_EXPR);
            // PRESENCE vs CONTENT are two different questions, and conflating them is a
            // bug in both directions. The CONTRADICTION check needs PRESENCE — an explicit
            // `@fields: []` beside @expr is still a declaration of both, and keying it on
            // non-emptiness let that spelling load clean while `@fields: ["x"]` + @expr was
            // refused. The KEY-RESOLUTION check needs normalized CONTENT (getFields() folds
            // absent/non-list/empty together) — the normalization is the fix for one and
            // the obstacle for the other, so the two are asked separately.
            final boolean hasFieldsAttr = child.hasMetaAttr(Index.ATTR_FIELDS, true);

            // Rule 1a: exactly one of @fields / @expr may be DECLARED.
            if (hasFieldsAttr && hasExpr) {
                throw new MetaDataException(
                    ErrorMessageConstants.ERR_INVALID_INDEX
                        + ": " + label + " \"" + child.getName()
                        + "\" on \"" + obj.getName()
                        + "\" declares BOTH @" + Index.ATTR_FIELDS
                        + " and @" + Index.ATTR_EXPR
                        + "; they are the two mutually exclusive ways to key an index. @"
                        + Index.ATTR_EXPR + " is used INSTEAD of @" + Index.ATTR_FIELDS
                        + " — drop one. (Declaring both previously loaded but silently"
                        + " discarded @" + Index.ATTR_FIELDS + ".)",
                    ErrorCode.ERR_INVALID_INDEX, child.getSource());
            }

            // Rule 1b: whichever is declared must actually supply a key.
            if (fields.isEmpty() && !hasExpr) {
                throw new MetaDataException(
                    ErrorMessageConstants.ERR_INVALID_INDEX
                        + ": " + label + " \"" + child.getName()
                        + "\" on \"" + obj.getName()
                        + "\" declares no key: it must have @" + Index.ATTR_FIELDS
                        + " (one or more columns) or @" + Index.ATTR_EXPR
                        + " (a key expression)",
                    ErrorCode.ERR_INVALID_INDEX, child.getSource());
            }

            // Rule 2: every named field must resolve. An @expr index has no @fields
            // to resolve — @expr is raw SQL over physical columns, deliberately not
            // parsed here.
            for (String fieldName : fields) {
                if (!effectiveFieldNames.contains(fieldName)) {
                    throw new MetaDataException(
                        ErrorMessageConstants.ERR_INVALID_INDEX
                            + ": " + label + " \"" + child.getName()
                            + "\" on \"" + obj.getName()
                            + "\" references field \"" + fieldName
                            + "\" which does not exist on \"" + obj.getName()
                            + "\". Available fields: "
                            + (effectiveFieldNames.isEmpty() ? "(none)" : String.join(", ", effectiveFieldNames)),
                        ErrorCode.ERR_INVALID_INDEX, child.getSource());
                }
            }
        }
    }

    /**
     * Is {@code name} present on {@code node} with a non-blank string value?
     * Resolving (includeParentData=true) per ADR-0039, so a value inherited via
     * {@code extends} counts.
     */
    private static boolean hasNonBlankAttr(MetaData node, String name) {
        if (!node.hasMetaAttr(name, true)) return false;
        String v = node.getMetaAttr(name, true).getValueAsString();
        return v != null && !v.trim().isEmpty();
    }

    // =========================================================================
    // requirement.* @status enum validation
    //
    // Applied to every requirement.* node after the full tree is built (attrs are
    // set post-placement, so the registered .withEnum() CustomConstraint cannot
    // fire at addChild time — its applicability test sees the ATTR node's own
    // type/subtype, not the container's; same reason source @kind/@role and
    // relationship @onDelete/@onUpdate use post-load passes).
    //
    //   @status must be one of: planned / live / partial
    //
    // This is the mechanism the capability ledger was made registered vocabulary
    // FOR (requirements-as-metadata ruling, Amendment 3): a typo'd status is
    // refused by the LOADER, not by a hand-written string comparison in one CLI.
    // ERR_BAD_ATTR_VALUE is the existing cross-port code for an out-of-set
    // allowedValues member — no new error code.
    // =========================================================================

    /**
     * Walk the full tree and validate {@code @status} on every {@code requirement.*} node.
     *
     * @param root the root node to walk
     * @throws MetaDataException when {@code @status} carries a value outside the closed set
     */
    static void validateRequirementStatus(MetaRoot root) {
        walkRequirementStatus(root);
    }

    private static void walkRequirementStatus(MetaData node) {
        validateRequirementStatusNode(node);
        for (MetaData child : node.getChildren(MetaData.class, false)) {
            walkRequirementStatus(child);
        }
    }

    private static void validateRequirementStatusNode(MetaData node) {
        if (!(node instanceof MetaRequirement)) {
            return;
        }
        // Own attribute only — an inherited @status was already validated on its declaring
        // node, matching the source @kind/@role and relationship @onDelete/@onUpdate passes.
        if (!node.hasMetaAttr(MetaRequirement.ATTR_STATUS, false)) {
            return;
        }
        String status = ((MetaRequirement) node).getStatus();
        if (!MetaRequirement.STATUSES.contains(status)) {
            throw new MetaDataException(
                ErrorMessageConstants.ERR_BAD_ATTR_VALUE
                    + ": requirement '" + node.getName()
                    + "' @" + MetaRequirement.ATTR_STATUS + " '" + status
                    + "' is not a valid value; allowed: "
                    + String.join(", ", MetaRequirement.STATUSES),
                ErrorCode.ERR_BAD_ATTR_VALUE, node.getSource());
        }
    }

}

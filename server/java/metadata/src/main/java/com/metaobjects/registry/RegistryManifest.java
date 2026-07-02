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
package com.metaobjects.registry;

import com.metaobjects.MetaData;
import com.metaobjects.MetaDataTypeId;
import com.metaobjects.attr.MetaAttribute;
import com.metaobjects.constraint.Constraint;
import com.metaobjects.field.MetaField;
import com.metaobjects.view.CurrencyView;
import com.metaobjects.view.MetaView;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;

/**
 * SP-G Registry Conformance — the Java registry-manifest emitter.
 *
 * <p>Walks a {@link MetaDataRegistry} and serializes the LOGICAL metamodel
 * vocabulary as a canonical, fully-sorted, byte-stable JSON manifest. This must
 * byte-match the single committed canonical produced by the TS reference
 * emitter ({@code server/typescript/packages/metadata/src/registry-manifest.ts})
 * — a structural gate against the SP-C class of silent vocabulary drift (a
 * port's registry diverging — wrong attr names, missing subtypes, different
 * required-ness — with every behavioral corpus still green).</p>
 *
 * <p>The IN/OUT boundary (the v1 logical subset emittable byte-identically by
 * all five ports) is documented in {@code fixtures/registry-conformance/README.md}.
 * In short: {@code type.subType} + {@code attrs[{name, valueType, required}]} +
 * {@code commonAttrs} + {@code defaultSubTypes}.</p>
 *
 * <p><strong>The Java porting subtlety.</strong> Java models an attribute as a
 * {@link ChildRequirement} ({@code expectedType == "attr"}) on a
 * {@link TypeDefinition}, alongside child-type rules (a {@code ChildRequirement}
 * with {@code name == "*"}) and placement/validation-constraint variants. The
 * v1 manifest emits ONLY the attribute child-requirements — it filters to
 * {@code expectedType == "attr"} and a non-wildcard name. The non-attr / wildcard
 * requirements are the deferred {@code childRules} and never leak into the
 * manifest (see README "EXCLUDED from v1").</p>
 *
 * <p>EXCLUDED from v1 (per-port-physical or not-universally-tracked-on-the-
 * registry): factories / {@code Class} bindings; declared parent
 * ({@code inheritsFrom}); per-attr default; {@code childRules}.</p>
 *
 * <p>ADR-0036 Wave 1 (decision 5) ADDS {@code allowedValues} — an attr's closed
 * value-set, emitted between {@code required} and {@code description} ONLY when the
 * attr declares a non-empty set (OMITTED for open / format-validated attrs like
 * {@code @currency}/{@code @locale}), in declaration order (load-bearing — sourced
 * from {@code spec/metamodel/*.json}). This byte-gates closed vocabularies
 * cross-port.</p>
 */
public final class RegistryManifest {

    private RegistryManifest() {
        // Utility class — no instantiation.
    }

    // ------------------------------------------------------------------
    // The canonical metamodel provider set (the registry-conformance gate's
    // measured vocabulary).
    // ------------------------------------------------------------------

    /**
     * Compose a fresh {@link MetaDataRegistry} from EXACTLY the metadata-module
     * metamodel providers — the SAME defined provider set the
     * {@code metadata}-module conformance runner measures (core types +
     * field/attr/validator/relationship/identity + db-extensions +
     * source/origin + documentation common-attrs + view/layout/template +
     * core objects).
     *
     * <p>This mirrors the TS reference's explicit {@code composeRegistry(coreProviders)}
     * (and Python's {@code compose_registry(core_providers)}): the manifest is
     * emitted from a <strong>defined</strong> provider set, NOT from the
     * process-global {@link MetaDataRegistry#getInstance()} singleton — which
     * picks up whatever {@link MetaDataTypeProvider} SPI files happen to be on
     * the classpath of the module running the test.</p>
     *
     * <p><strong>Why this matters for the gate.</strong> The {@code metadata}
     * module's classpath holds only the metamodel providers, so its runner can
     * read {@code getInstance()} and stay clean. But a downstream module that
     * also runs this gate (e.g. {@code codegen-kotlin}) has the {@code om} and
     * {@code codegen-base} modules on its test classpath — whose SPI providers
     * register an extra {@code object.managed} subtype and ~22 codegen-tooling
     * attrs ({@code ai*}/{@code json*}/{@code has*}) that the generators
     * self-register. Those are per-port codegen tooling, NOT the cross-port
     * logical metamodel vocabulary the gate measures. Composing from this
     * defined provider set makes <em>every</em> module's runner measure the same
     * vocabulary — so the gate stays meaningful (it still catches a real attr/
     * subtype divergence in any of these providers) while being immune to
     * classpath pollution. See {@code fixtures/registry-conformance/README.md}.</p>
     *
     * @return a new registry composed from the metamodel provider set
     */
    public static MetaDataRegistry composeMetamodelRegistry() {
        MetaDataRegistry registry = MetaDataRegistry.compose(metamodelProviders());
        // Force the lazy core-constraint init NOW: it expands the named inherited
        // attr child-requirements (e.g. field.base's `required`/`default`/`unique`
        // onto each concrete field subtype). Those named requirements must exist
        // BEFORE applySpecDescriptions rebuilds the type definitions, otherwise the
        // rebuild would not see them and their descriptions would never land.
        registry.getAllValidationConstraints();
        // FR-033 (sub-step B1): source every type / attr / common-attr description
        // (+ rules/example/whenToUse) from the embedded spec/metamodel/*.json — the
        // cross-port single source of truth — onto the freshly-composed registry,
        // BEFORE any seal. Single-sourced, byte-identical to TS; never hand-copied.
        registry.applySpecDescriptions(
                com.metaobjects.registry.spec.SpecMetamodelReader.load());
        return registry;
    }

    /**
     * The process-wide, lazily-built, <strong>sealed</strong> default registry the
     * library loader uses (ADR-0023 Decision 2 — the JVM load-time pivot).
     *
     * <p>This is the SAME defined metamodel provider set the SP-G
     * registry-conformance gate measures ({@link #composeMetamodelRegistry()}),
     * promoted from a test-only measurement device to the runtime default.
     * Unlike {@link MetaDataRegistry#getInstance()} — which is populated by an
     * unbounded {@code ServiceLoader} SPI scan of whatever {@link MetaDataTypeProvider}
     * files happen to be on the classpath (the {@code codegen-base}/{@code om}
     * doc-generator providers self-register {@code ai*}/{@code json*}/{@code has*}
     * tooling attrs + an {@code object.managed} subtype that were never agreed
     * metamodel vocabulary) — this registry contains EXACTLY the cross-port logical
     * metamodel vocabulary, and is sealed so nothing can pollute it post-bootstrap.</p>
     *
     * <p>This is also the ADR-0001-consistent choice: vocabulary no longer depends
     * on classpath SPI presence (AOT-safe). Downstream apps that genuinely need
     * extra vocabulary use the {@code loader.setTypeRegistry(compose(... + myProvider))}
     * seam (their own, unsealed registry) — the sanctioned extension path.</p>
     *
     * @return the shared sealed default registry
     */
    public static MetaDataRegistry defaultLoaderRegistry() {
        MetaDataRegistry r = defaultLoaderRegistry;
        if (r == null) {
            synchronized (DEFAULT_LOCK) {
                r = defaultLoaderRegistry;
                if (r == null) {
                    r = composeMetamodelRegistry();
                    // The core constraint set is normally lazy-loaded on first
                    // getAllValidationConstraints() read — which, post-seal, would
                    // happen DURING a load and trip the seal guard. Force it now,
                    // while still unsealed, so the sealed registry is fully built.
                    r.getAllValidationConstraints();
                    r.seal();
                    defaultLoaderRegistry = r;
                }
            }
        }
        return r;
    }

    private static volatile MetaDataRegistry defaultLoaderRegistry;
    private static final Object DEFAULT_LOCK = new Object();

    /**
     * The explicit metamodel provider set — instantiated in the same order as
     * {@code metadata/src/main/resources/META-INF/services/com.metaobjects.registry.MetaDataTypeProvider}
     * (provider dependencies are re-resolved by {@code compose}, so order is for
     * readability only). Keep this list in lockstep with that SPI file.
     */
    public static List<MetaDataTypeProvider> metamodelProviders() {
        return List.of(
                new com.metaobjects.core.CoreTypeMetaDataProvider(),
                new com.metaobjects.object.ObjectTypesMetaDataProvider(),
                new com.metaobjects.field.FieldTypesMetaDataProvider(),
                new com.metaobjects.attr.AttributeTypesMetaDataProvider(),
                new com.metaobjects.validator.ValidatorTypesMetaDataProvider(),
                new com.metaobjects.relationship.RelationshipTypesMetaDataProvider(),
                new com.metaobjects.identity.IdentityTypesMetaDataProvider(),
                new com.metaobjects.index.IndexTypesMetaDataProvider(),
                new com.metaobjects.database.CoreDBMetaDataProvider(),
                new com.metaobjects.source.SourceTypesMetaDataProvider(),
                new com.metaobjects.origin.OriginTypesMetaDataProvider(),
                new com.metaobjects.documentation.DocumentationMetaDataProvider(),
                new com.metaobjects.view.ViewTypesMetaDataProvider(),
                new com.metaobjects.layout.LayoutTypesMetaDataProvider(),
                new com.metaobjects.template.TemplateTypesMetaDataProvider(),
                // FR-033 concern providers — re-home UI / prompt attrs out of the
                // core type classes (read spec/metamodel/ui.json + prompt.json).
                // Placed after their type deps (field/view/layout/template/object);
                // compose() re-resolves order via getDependencies() regardless.
                new com.metaobjects.presentation.ui.UiTypesMetaDataProvider(),
                new com.metaobjects.template.PromptTypesMetaDataProvider(),
                new com.metaobjects.object.CoreObjectsMetaDataProvider());
    }

    /**
     * The polymorphic / untyped attr whose value-type follows its owning field's
     * subtype. The manifest renders its {@code valueType} as an explicit
     * {@code null} literal (mirrors the TS reference, where {@code @default} has
     * no fixed value-type).
     */
    private static final String POLYMORPHIC_DEFAULT_ATTR = MetaField.ATTR_DEFAULT;

    /** Wildcard token used by Java's {@link ChildRequirement} for "any name / any type". */
    private static final String WILDCARD = "*";

    /**
     * The rolled-up spec-version string emitted as the first top-level key of
     * the registry manifest. Value {@code "0"} = pre-1.0/unstable (semver major-0);
     * the 1.0 cut will flip it to {@code "1.0"}. Mirrors the TS reference's
     * {@code METAMODEL_VERSION} constant.
     */
    public static final String METAMODEL_VERSION = "0";

    // ------------------------------------------------------------------
    // SP-G Phase1 Units2-3 — manifest emitter exclusions (documented, uniform
    // across all four ports; see fixtures/registry-conformance/README.md
    // "EXCLUDED" list + the SP-G divergence analysis buckets C-2/C-3/C-5/B-2):
    //  - structural keywords (isArray/isAbstract) + the `description` commonAttr
    //    are NOT per-type attrs. Java DOES register all three as ordinary
    //    per-type attrs (on metadata.base / field.base, inherited everywhere) —
    //    so this filter is what drops them from Java's emitter output. They are
    //    no-ops for TS/C#/Python. `description` stays in the commonAttrs block.
    //  - metadata.base is Java's internal inheritance anchor — other ports
    //    register only metadata.root (the deferred inheritsFrom anchor).
    //  - the 11 generic view.* controls are a TS-web-presentation facet (Java
    //    never registered them anyway; the filter keeps the contract explicit).
    // ------------------------------------------------------------------

    /**
     * Wave 3b — the in/out boundary is an EXPLICIT CLASSIFICATION (a reason
     * category per carve-out), not a bare name-match. The negative branch of a
     * name-list silently meant "logical"; now {@link #classifyPerTypeAttr} returns
     * either an {@link ExclusionReason} (carved out, with a documented category) or
     * {@link ExclusionReason#INCLUDED} (logical cross-port vocabulary).
     * Inclusion-by-classification is sound because ADR-0023 seals the
     * agreed-vocabulary registry. The axis is cross-port-CONTRACT vs
     * port-PRIVATE-mechanism (NOT abstract-vs-physical — the physical-DB attrs
     * column/dbColumnType/db.indexed/precision/scale/maxLength/unique ARE logical
     * here, the agreed persistence vocabulary).
     */
    public enum ExclusionReason {
        /** Sentinel: NOT excluded — logical cross-port vocabulary. */
        INCLUDED,
        /** Native type-binding / factory (incl. ADR-0001 {@code object}, ADR-0005 {@code objectAdapter}). */
        NATIVE_BINDING,
        /** Bare structural / OO-shape keyword (isArray/isAbstract/extends/implements/isInterface). */
        STRUCTURAL_KEYWORD,
        /** A commonAttr ({@code description}) re-registered per-type — belongs in commonAttrs. */
        COMMON_ATTR_DUP,
        /** The {@code metadata.base} per-port inheritance anchor (deferred inheritsFrom facet). */
        INHERITANCE_ANCHOR,
        /** TS-web-presentation-only facet (the generic {@code view.*} controls). */
        PRESENTATION_ONLY,
        /**
         * FR-024 reference-first rollout slot (RETIRED at the atomic flip): the
         * {@code object.projection} row + the {@code origin.aggregate.via}
         * required-override were excluded until every port registered the FR-024
         * loader-grammar slice, then removed with the canonical updated in ONE
         * commit (the {@code @responseRef} carve-out-close playbook). Kept as the
         * documented lifecycle slot for the next rollout; currently no members.
         */
        FR024_PENDING
    }

    /**
     * Per-type attr names carved out of the agreed vocabulary, each mapped to its
     * PORT_PRIVATE reason. An attr NOT in this map is logical (INCLUDED) by the
     * ADR-0023 sealed-vocabulary contract.
     *
     * <p>The structural / OO-shape keywords {@code isArray}/{@code isAbstract}/
     * {@code extends}/{@code implements}/{@code isInterface} are bare OO-shape
     * keywords (the OO modeling spine, peers of {@code name}/{@code children}),
     * NOT per-type attributes — Java registers them on {@code object.base}
     * (inherited by entity/value), so the classification is what drops them from
     * the emitter (no-op for TS/C#/Python). They remain REGISTERED (the loader
     * must accept an authored {@code extends:}). {@code description} is carved out
     * ONLY per-type — it remains in the {@code commonAttrs} block. {@code object}
     * (ADR-0001 class-FQN type binding) and {@code objectAdapter} (ADR-0005
     * value-access seam) are per-port binding mechanisms (same category as native
     * type bindings); they stay REGISTERED in Java (read by the value-access
     * representation, IO readers, OMDB), only carved out of the manifest.</p>
     */
    private static final Map<String, ExclusionReason> EXCLUDED_PER_TYPE_ATTRS = Map.of(
            MetaField.ATTR_IS_ARRAY, ExclusionReason.STRUCTURAL_KEYWORD,
            MetaData.ATTR_IS_ABSTRACT, ExclusionReason.STRUCTURAL_KEYWORD,
            com.metaobjects.object.MetaObject.ATTR_EXTENDS, ExclusionReason.STRUCTURAL_KEYWORD,
            com.metaobjects.object.MetaObject.ATTR_IMPLEMENTS, ExclusionReason.STRUCTURAL_KEYWORD,
            com.metaobjects.object.MetaObject.ATTR_IS_INTERFACE, ExclusionReason.STRUCTURAL_KEYWORD,
            com.metaobjects.object.MetaObject.ATTR_OBJECT, ExclusionReason.NATIVE_BINDING,
            com.metaobjects.object.AbstractObjectRepresentation.ATTR_OBJECT_ADAPTER, ExclusionReason.NATIVE_BINDING,
            MetaData.ATTR_DESCRIPTION, ExclusionReason.COMMON_ATTR_DUP);

    /**
     * Classify a per-type attr: an {@link ExclusionReason} (carved out) or
     * {@link ExclusionReason#INCLUDED} (logical). Total — no silent default.
     */
    public static ExclusionReason classifyPerTypeAttr(String name) {
        return EXCLUDED_PER_TYPE_ATTRS.getOrDefault(name, ExclusionReason.INCLUDED);
    }

    /**
     * Classify a {@code (type, subType)} row: the {@code metadata.base} inheritance
     * anchor (C-5) / the generic presentation-only {@code view.*} controls (B-2) /
     * {@link ExclusionReason#INCLUDED}.
     */
    public static ExclusionReason classifyTypeSubType(String type, String subType) {
        if (MetaData.TYPE_METADATA.equals(type) && MetaData.SUBTYPE_BASE.equals(subType)) {
            return ExclusionReason.INHERITANCE_ANCHOR; // C-5 — Java's internal inheritance anchor
        }
        if (MetaView.TYPE_VIEW.equals(type)
                && !MetaData.SUBTYPE_BASE.equals(subType)
                && !CurrencyView.SUBTYPE_CURRENCY.equals(subType)) {
            return ExclusionReason.PRESENTATION_ONLY; // B-2 — TS-web-presentation generic view controls
        }
        return ExclusionReason.INCLUDED;
    }

    /** True if a {@code (type, subType)} row is carved out of the manifest (any reason). */
    private static boolean isExcludedTypeSubType(String type, String subType) {
        return classifyTypeSubType(type, subType) != ExclusionReason.INCLUDED;
    }

    /**
     * Suffix of the auto-generated array CustomConstraint id (see
     * {@code AttributeConstraintBuilder.generateArrayConstraint} and
     * {@code MetaDataRegistry} common-attr registration). Java models an
     * array-valued attr as a {@code StringAttribute} child requirement (subType
     * {@code string}) PLUS this constraint — its presence is the {@code .asArray()}
     * / {@code @isArray} marker the emitter reads to decompose array-ness into the
     * orthogonal {@code isArray} flag (the retired {@code stringarray} subtype).
     */
    private static final String ARRAY_CONSTRAINT_SUFFIX = ".array";

    /**
     * One attribute in the manifest — the logical, cross-port-identical facet.
     * FR-033: carries a required {@code description} plus the optional
     * {@code rules}/{@code example}/{@code whenToUse} doc facets (null = omitted).
     */
    private record ManifestAttr(String name, String valueType, boolean isArray, boolean required,
                                List<String> allowedValues,
                                String description, String rules, String example, String whenToUse) {}

    /**
     * One structural child rule of a type (FR-033 constraint graph). Mirrors the
     * TS {@code ManifestChild}: {@code childSubType} is a single subtype string,
     * {@code "*"}, or a comma-list lowered to a {@code List<String>} for emission.
     * Cardinality ({@code min}/{@code max}/{@code named}) is emitted ONLY when
     * present — Java's {@link ChildRequirement} carries none today, so all three
     * are null (sub-step B may add cardinality).
     */
    private record ManifestChild(String childType, Object childSubType, String childName,
                                 Integer min, Integer max, Boolean named, boolean maxIsNull) {}

    /**
     * One registered (type, subType) with its docs + declared attrs + the
     * structural constraint graph (FR-033). {@code rules}/{@code example}/
     * {@code whenToUse} are null when absent; {@code parents} is empty when absent.
     */
    private record ManifestType(String type, String subType, String description,
                                String rules, String example, String whenToUse,
                                List<ManifestAttr> attrs, List<ManifestChild> children,
                                List<String> parents) {}

    // ------------------------------------------------------------------
    // Build
    // ------------------------------------------------------------------

    /**
     * Collect the attr child-requirements declared on one (type, subType) and
     * normalize them to the manifest's logical attr shape, sorted by name.
     *
     * <p>Only {@code expectedType == "attr"}, non-wildcard-name requirements are
     * kept (the attr facet). Wildcard child rules and non-attr child rules are
     * the deferred {@code childRules} and are dropped. De-duped by name (a direct
     * requirement overriding an inherited one with the same name is collapsed —
     * the cross-port manifest has exactly one entry per attr name).</p>
     */
    private static List<ManifestAttr> attrsOf(MetaDataRegistry registry, String type, String subType,
                                              Set<String> arrayAttrNames) {
        TypeDefinition def = registry.getTypeDefinition(type, subType);
        if (def == null) {
            return List.of();
        }

        // De-dupe by attr name; required-ness "true wins" if any requirement for
        // the same name is required (matches the logical intent — an attr is
        // required if the type requires it).
        Map<String, ManifestAttr> byName = new LinkedHashMap<>();
        for (ChildRequirement req : def.getChildRequirements()) {
            if (!MetaAttribute.TYPE_ATTR.equals(req.getExpectedType())) {
                continue; // non-attr child rule (deferred childRules)
            }
            String name = req.getName();
            if (name == null || WILDCARD.equals(name)) {
                continue; // wildcard "any attr" rule (deferred childRules)
            }
            if (classifyPerTypeAttr(name) != ExclusionReason.INCLUDED) {
                continue; // carved out (structural keyword / native binding / description dup) — see classifyPerTypeAttr
            }
            String valueType = valueTypeOf(name, req.getExpectedSubType());
            // Array-ness is the orthogonal axis: a StringAttribute requirement
            // marked .asArray() emits valueType "string" + isArray true (the
            // retired stringarray subtype). Detected via the array-constraint set.
            boolean isArray = arrayAttrNames.contains(name);
            ManifestAttr existing = byName.get(name);
            boolean required = req.isRequired() || (existing != null && existing.required());
            // FR-033: the per-attr doc description (empty string when not yet
            // sourced — sub-step B reads it from the embedded spec/metamodel JSON).
            // A non-null description on EITHER the direct or a prior requirement
            // wins (first-non-empty), keeping the de-dupe collapse deterministic.
            String docDescription = req.getDocDescription();
            String description = (docDescription != null && !docDescription.isEmpty())
                    ? docDescription
                    : (existing != null ? existing.description() : "");
            // ADR-0036 Wave 1 (decision 5) — the closed value-set, sourced onto the
            // requirement from spec/metamodel/*.json (null when the attr declares no
            // closed set); preserve the prior copy on the de-dupe collapse.
            List<String> allowedValues = req.getAllowedValues();
            if (allowedValues == null && existing != null) {
                allowedValues = existing.allowedValues();
            }
            // rules/example/whenToUse have no Java attr-level source today → null
            // (omitted by the serializer). Sub-step B may source them.
            byName.put(name, new ManifestAttr(name, valueType, isArray, required, allowedValues,
                    description, null, null, null));
        }

        List<ManifestAttr> attrs = new ArrayList<>(byName.values());
        attrs.sort(Comparator.comparing(ManifestAttr::name));
        return attrs;
    }

    /**
     * Build the FR-033 constraint graph ({@code children}) for one (type, subType)
     * from its STRUCTURAL child requirements — every {@link ChildRequirement}
     * whose {@code expectedType != "attr"} (the attr requirements are the
     * {@code attrs} block; the any-attr {@code name=="*" && expectedType=="attr"}
     * wildcard is dropped — the strict model has no attr wildcard). Each maps to a
     * {@link ManifestChild} {@code {childType, childSubType, childName}}; Java's
     * {@link ChildRequirement} carries no cardinality, so {@code min}/{@code max}/
     * {@code named} are absent (omitted) for now (sub-step B may add them).
     *
     * <p>Sorted by {@code (childType, childSubTypeKey, childName)} — ASCII
     * codepoint compare — matching the TS reference's {@code sortedChildren}.
     * De-duped by the same tuple so an inherited rule duplicating a direct one
     * collapses to a single entry.</p>
     */
    private static List<ManifestChild> childrenOf(MetaDataRegistry registry, String type, String subType) {
        TypeDefinition def = registry.getTypeDefinition(type, subType);
        if (def == null) {
            return List.of();
        }

        Map<String, ManifestChild> byKey = new LinkedHashMap<>();
        for (ChildRequirement req : def.getChildRequirements()) {
            String expectedType = req.getExpectedType();
            if (MetaAttribute.TYPE_ATTR.equals(expectedType)) {
                continue; // attr requirement (the attrs block) — incl. the any-attr wildcard
            }
            // Skip placement/validation constraint requirements (they carry no
            // structural child shape — name/type/subType are all "*").
            if (req.isPlacementConstraint() || req.isValidationConstraint()) {
                continue;
            }
            String childType = expectedType;
            String childSubType = req.getExpectedSubType();
            String childName = req.getName();
            // FR-033 B2a — cardinality (min/max/named) is now sourced from the strict
            // spec/metamodel graph onto the ChildRequirement (Pass 4 of
            // applySpecDescriptions); emit it (max:null literal when declared-unbounded).
            ManifestChild child = new ManifestChild(childType, childSubType, childName,
                    req.getMin(), req.getMax(), req.getNamed(), req.isMaxNull());
            String key = childType + " " + childSubTypeKey(childSubType) + " " + childName;
            byKey.putIfAbsent(key, child);
        }

        List<ManifestChild> children = new ArrayList<>(byKey.values());
        children.sort(
            Comparator.<ManifestChild, String>comparing(ManifestChild::childType)
                .thenComparing(c -> childSubTypeKey(c.childSubType()))
                .thenComparing(ManifestChild::childName));
        return children;
    }

    /**
     * The canonical sort/dedupe key for a child rule's subType: the string itself,
     * or a comma-joined list (matches the TS {@code childSubTypeKey}). Java stores
     * only a single subType string today, so this is the string (or {@code "*"}).
     */
    private static String childSubTypeKey(Object childSubType) {
        if (childSubType instanceof List<?> list) {
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < list.size(); i++) {
                if (i > 0) {
                    sb.append(',');
                }
                sb.append(list.get(i));
            }
            return sb.toString();
        }
        return childSubType == null ? "" : childSubType.toString();
    }

    /**
     * Build the set of attr names that are array-valued, by scanning the
     * registry's constraints for the auto-generated array CustomConstraint
     * (id {@code <type>.<subType>.<attr>.array} for per-type attrs, or
     * {@code *.*.<attr>.array} for common attrs). The attr name is the
     * second-to-last dotted segment (immediately before the {@code .array}
     * suffix). This is the {@code .asArray()} / {@code @isArray} marker —
     * Java's array attrs carry no flag on the {@link ChildRequirement} itself.
     */
    private static Set<String> arrayAttrNames(MetaDataRegistry registry) {
        Set<String> names = new HashSet<>();
        for (Constraint c : registry.getAllValidationConstraints()) {
            String id = c.getConstraintId();
            if (id == null || !id.endsWith(ARRAY_CONSTRAINT_SUFFIX)) {
                continue;
            }
            String withoutSuffix = id.substring(0, id.length() - ARRAY_CONSTRAINT_SUFFIX.length());
            int lastDot = withoutSuffix.lastIndexOf('.');
            String attrName = lastDot >= 0 ? withoutSuffix.substring(lastDot + 1) : withoutSuffix;
            if (!attrName.isEmpty()) {
                names.add(attrName);
            }
        }
        return names;
    }

    /**
     * Map a Java attr requirement to the cross-port manifest value-type vocabulary.
     * The polymorphic {@code @default} attr is rendered as {@code null}; every
     * other attr carries its {@code expectedSubType} verbatim (the attr subtype
     * names — {@code string}, {@code int}, {@code boolean}, {@code long},
     * {@code double}, {@code properties}, {@code filter} — are already the
     * cross-port value-type vocabulary; an array attr's requirement subType is
     * {@code string}, with array-ness carried by the separate {@code isArray}
     * flag). A wildcard subtype is rendered as {@code null} (untyped).
     */
    private static String valueTypeOf(String attrName, String expectedSubType) {
        if (POLYMORPHIC_DEFAULT_ATTR.equals(attrName)) {
            return null;
        }
        if (expectedSubType == null || WILDCARD.equals(expectedSubType)) {
            return null;
        }
        return expectedSubType;
    }

    // ------------------------------------------------------------------
    // Emit
    // ------------------------------------------------------------------

    /**
     * Emit the canonical registry manifest as a byte-stable JSON string.
     *
     * <p>Serialization contract — every port MUST match this exactly:</p>
     * <ul>
     *   <li>2-space indentation.</li>
     *   <li>Object key order fixed by construction: {@code metamodelVersion},
     *       {@code types}, {@code commonAttrs},
     *       {@code defaultSubTypes}; each type as {@code type}, {@code subType},
     *       {@code attrs}; each attr as {@code name}, {@code valueType},
     *       {@code isArray}, {@code required}.</li>
     *   <li>All arrays sorted (ASCII/codepoint compare): {@code types} by
     *       "type.subType"; {@code attrs} by name; {@code commonAttrs} by name;
     *       {@code defaultSubTypes} keys sorted.</li>
     *   <li>{@code valueType: null} literal for polymorphic/untyped attrs.</li>
     *   <li>A single trailing newline.</li>
     * </ul>
     *
     * <p>The sort uses {@link String#compareTo} which, for the metamodel's
     * ASCII-only identifiers, is exactly a UTF-16-code-unit (== codepoint)
     * compare — byte-identical to the TS reference's {@code a < b} string
     * compare.</p>
     */
    public static String emit(MetaDataRegistry registry) {
        // The set of array-valued attr names (the .asArray() / @isArray marker).
        Set<String> arrayAttrNames = arrayAttrNames(registry);

        // types: sorted by "type.subType"
        List<ManifestType> types = new ArrayList<>();
        for (MetaDataTypeId id : registry.getRegisteredTypes()) {
            if (isExcludedTypeSubType(id.type(), id.subType())) {
                continue; // metadata.base anchor (C-5) / generic view.* controls (B-2)
            }
            TypeDefinition def = registry.getTypeDefinition(id.type(), id.subType());
            // FR-033: per-type docs. description is the existing TypeDefinition
            // slot (empty when not yet sourced); rules/example/whenToUse are the
            // new optional slots (null → omitted); parents the child-side claim.
            String description = def != null ? def.getDescription() : "";
            String rules = def != null ? def.getRules() : null;
            String example = def != null ? def.getExample() : null;
            String whenToUse = def != null ? def.getWhenToUse() : null;
            List<String> parents = def != null ? def.getParents() : List.of();
            types.add(new ManifestType(id.type(), id.subType(), description,
                rules, example, whenToUse,
                attrsOf(registry, id.type(), id.subType(), arrayAttrNames),
                childrenOf(registry, id.type(), id.subType()),
                parents));
        }
        types.sort(Comparator.comparing(t -> t.type() + "." + t.subType()));

        // commonAttrs: sorted by name. An array-shaped common attr is the scalar
        // value-type plus the orthogonal isArray flag (the retired stringarray
        // subtype) — matching the cross-port {valueType, isArray} contract. The
        // FR-033 (sub-step B): the per-commonAttr description is now sourced from the
        // universal *.* entry of the embedded spec/metamodel/documentation.json and
        // applied onto each CommonAttributeDef at composition time (pre-seal).
        List<ManifestAttr> commonAttrs = new ArrayList<>();
        for (CommonAttributeDef def : registry.getCommonAttributes()) {
            // ADR-0036 Wave 1 — no common attr declares a closed value-set today
            // (null → the allowedValues key is omitted by the serializer).
            commonAttrs.add(new ManifestAttr(def.name(), def.valueType(), def.isArray(), false,
                null, def.description() != null ? def.description() : "", null, null, null));
        }
        commonAttrs.sort(Comparator.comparing(ManifestAttr::name));

        // defaultSubTypes: probe each distinct registered type name; sorted keys.
        TreeSet<String> typeNames = new TreeSet<>();
        for (ManifestType t : types) {
            typeNames.add(t.type());
        }
        Map<String, String> defaultSubTypes = new TreeMap<>();
        for (String typeName : typeNames) {
            String defaultSub = registry.defaultSubTypeOf(typeName);
            if (defaultSub != null) {
                defaultSubTypes.put(typeName, defaultSub);
            }
        }

        return serialize(types, commonAttrs, defaultSubTypes);
    }

    // ------------------------------------------------------------------
    // Hand-rolled JSON serialization (2-space indent, fixed key order)
    // ------------------------------------------------------------------

    private static String serialize(List<ManifestType> types,
                                    List<ManifestAttr> commonAttrs,
                                    Map<String, String> defaultSubTypes) {
        StringBuilder sb = new StringBuilder();
        sb.append("{\n");

        // "metamodelVersion": first top-level key (C4 of the 1.0 readiness program)
        sb.append("  \"metamodelVersion\": ").append(jsonString(METAMODEL_VERSION)).append(",\n");

        // "types": [ ... ]
        sb.append("  \"types\": [");
        if (types.isEmpty()) {
            sb.append("],\n");
        } else {
            sb.append('\n');
            for (int i = 0; i < types.size(); i++) {
                ManifestType t = types.get(i);
                sb.append("    {\n");
                sb.append("      \"type\": ").append(jsonString(t.type())).append(",\n");
                sb.append("      \"subType\": ").append(jsonString(t.subType())).append(",\n");
                sb.append("      \"description\": ").append(jsonString(t.description())).append(",\n");
                // FR-033: optional type-level docs, emitted ONLY when present, in
                // fixed order between `description` and `attrs`.
                if (t.rules() != null) {
                    sb.append("      \"rules\": ").append(jsonString(t.rules())).append(",\n");
                }
                if (t.example() != null) {
                    sb.append("      \"example\": ").append(jsonString(t.example())).append(",\n");
                }
                if (t.whenToUse() != null) {
                    sb.append("      \"whenToUse\": ").append(jsonString(t.whenToUse())).append(",\n");
                }
                sb.append("      \"attrs\": ");
                appendAttrs(sb, t.attrs(), "      ");
                sb.append(",\n");
                sb.append("      \"children\": ");
                appendChildren(sb, t.children(), "      ");
                // FR-033: optional `parents` (omitted when absent/empty), sorted ASCII.
                if (t.parents() != null && !t.parents().isEmpty()) {
                    sb.append(",\n");
                    sb.append("      \"parents\": ");
                    appendStringArray(sb, sortedCopy(t.parents()), "      ");
                }
                sb.append('\n');
                sb.append("    }");
                sb.append(i + 1 < types.size() ? ",\n" : "\n");
            }
            sb.append("  ],\n");
        }

        // "commonAttrs": [ ... ]
        sb.append("  \"commonAttrs\": ");
        appendAttrs(sb, commonAttrs, "  ");
        sb.append(",\n");

        // "defaultSubTypes": { ... }
        sb.append("  \"defaultSubTypes\": {");
        if (defaultSubTypes.isEmpty()) {
            sb.append("}\n");
        } else {
            sb.append('\n');
            int i = 0;
            int n = defaultSubTypes.size();
            for (Map.Entry<String, String> e : defaultSubTypes.entrySet()) {
                sb.append("    ").append(jsonString(e.getKey())).append(": ")
                  .append(jsonString(e.getValue()));
                sb.append(++i < n ? ",\n" : "\n");
            }
            sb.append("  }\n");
        }

        sb.append("}\n");
        return sb.toString();
    }

    /**
     * Append an attrs array at the given base indent (the indent of the line the
     * opening {@code [} sits on). Matches {@code JSON.stringify(_, _, 2)} layout.
     */
    private static void appendAttrs(StringBuilder sb, List<ManifestAttr> attrs, String baseIndent) {
        if (attrs.isEmpty()) {
            sb.append("[]");
            return;
        }
        String itemIndent = baseIndent + "  ";
        String fieldIndent = itemIndent + "  ";
        sb.append("[\n");
        for (int i = 0; i < attrs.size(); i++) {
            ManifestAttr a = attrs.get(i);
            sb.append(itemIndent).append("{\n");
            sb.append(fieldIndent).append("\"name\": ").append(jsonString(a.name())).append(",\n");
            sb.append(fieldIndent).append("\"valueType\": ")
              .append(a.valueType() == null ? "null" : jsonString(a.valueType())).append(",\n");
            sb.append(fieldIndent).append("\"isArray\": ").append(a.isArray() ? "true" : "false").append(",\n");
            sb.append(fieldIndent).append("\"required\": ").append(a.required() ? "true" : "false").append(",\n");
            // ADR-0036 Wave 1 (decision 5): the closed value-set, emitted ONLY when
            // the attr declares a non-empty set (OMITTED for open / format-validated
            // attrs), in fixed order between `required` and `description`.
            if (a.allowedValues() != null && !a.allowedValues().isEmpty()) {
                sb.append(fieldIndent).append("\"allowedValues\": ");
                appendStringArray(sb, a.allowedValues(), fieldIndent);
                sb.append(",\n");
            }
            // FR-033: `description` (required) follows `required`; the optional
            // `rules`/`example`/`whenToUse` follow, emitted ONLY when present.
            sb.append(fieldIndent).append("\"description\": ").append(jsonString(a.description()));
            if (a.rules() != null) {
                sb.append(",\n").append(fieldIndent).append("\"rules\": ").append(jsonString(a.rules()));
            }
            if (a.example() != null) {
                sb.append(",\n").append(fieldIndent).append("\"example\": ").append(jsonString(a.example()));
            }
            if (a.whenToUse() != null) {
                sb.append(",\n").append(fieldIndent).append("\"whenToUse\": ").append(jsonString(a.whenToUse()));
            }
            sb.append('\n');
            sb.append(itemIndent).append('}');
            sb.append(i + 1 < attrs.size() ? ",\n" : "\n");
        }
        sb.append(baseIndent).append(']');
    }

    /**
     * Append the FR-033 constraint graph ({@code children}) at the given base
     * indent. Each child: {@code childType}, {@code childSubType} (a string, a
     * {@code "*"}, or a JSON array for a subtype list), {@code childName}, then the
     * optional {@code min}/{@code max}/{@code named} (emitted ONLY when present;
     * {@code max} may be the JSON {@code null} literal when defined-as-unbounded).
     * Matches {@code JSON.stringify(_, _, 2)} layout.
     */
    private static void appendChildren(StringBuilder sb, List<ManifestChild> children, String baseIndent) {
        if (children.isEmpty()) {
            sb.append("[]");
            return;
        }
        String itemIndent = baseIndent + "  ";
        String fieldIndent = itemIndent + "  ";
        sb.append("[\n");
        for (int i = 0; i < children.size(); i++) {
            ManifestChild c = children.get(i);
            sb.append(itemIndent).append("{\n");
            sb.append(fieldIndent).append("\"childType\": ").append(jsonString(c.childType())).append(",\n");
            sb.append(fieldIndent).append("\"childSubType\": ").append(childSubTypeJson(c.childSubType())).append(",\n");
            sb.append(fieldIndent).append("\"childName\": ").append(jsonString(c.childName()));
            if (c.min() != null) {
                sb.append(",\n").append(fieldIndent).append("\"min\": ").append(c.min());
            }
            if (c.max() != null || c.maxIsNull()) {
                sb.append(",\n").append(fieldIndent).append("\"max\": ")
                  .append(c.max() == null ? "null" : c.max().toString());
            }
            if (c.named() != null) {
                sb.append(",\n").append(fieldIndent).append("\"named\": ").append(c.named() ? "true" : "false");
            }
            sb.append('\n');
            sb.append(itemIndent).append('}');
            sb.append(i + 1 < children.size() ? ",\n" : "\n");
        }
        sb.append(baseIndent).append(']');
    }

    /**
     * Render a {@code childSubType} as JSON — a quoted string (the common case,
     * incl. {@code "*"}) or a JSON array of strings when it is a subtype list.
     */
    private static String childSubTypeJson(Object childSubType) {
        if (childSubType instanceof List<?> list) {
            StringBuilder sb = new StringBuilder("[");
            for (int i = 0; i < list.size(); i++) {
                if (i > 0) {
                    sb.append(", ");
                }
                sb.append(jsonString(String.valueOf(list.get(i))));
            }
            return sb.append(']').toString();
        }
        return jsonString(childSubType == null ? "" : childSubType.toString());
    }

    /** Append a JSON string-array at the given base indent (JSON.stringify(_, _, 2) layout). */
    private static void appendStringArray(StringBuilder sb, List<String> values, String baseIndent) {
        if (values.isEmpty()) {
            sb.append("[]");
            return;
        }
        String itemIndent = baseIndent + "  ";
        sb.append("[\n");
        for (int i = 0; i < values.size(); i++) {
            sb.append(itemIndent).append(jsonString(values.get(i)));
            sb.append(i + 1 < values.size() ? ",\n" : "\n");
        }
        sb.append(baseIndent).append(']');
    }

    /** A new ASCII-sorted copy (the byte-stable order; {@link String#compareTo}). */
    private static List<String> sortedCopy(List<String> values) {
        List<String> copy = new ArrayList<>(values);
        copy.sort(Comparator.naturalOrder());
        return copy;
    }

    /**
     * JSON-encode a string the way {@code JSON.stringify} does for the ASCII
     * identifiers in the metamodel vocabulary (the only chars that ever appear
     * here are letters, digits, {@code .}, {@code _}). Escapes the JSON-mandatory
     * control/quote/backslash chars defensively.
     */
    private static String jsonString(String s) {
        StringBuilder out = new StringBuilder(s.length() + 2);
        out.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"' -> out.append("\\\"");
                case '\\' -> out.append("\\\\");
                case '\b' -> out.append("\\b");
                case '\f' -> out.append("\\f");
                case '\n' -> out.append("\\n");
                case '\r' -> out.append("\\r");
                case '\t' -> out.append("\\t");
                default -> {
                    if (c < 0x20) {
                        out.append(String.format("\\u%04x", (int) c));
                    } else {
                        out.append(c);
                    }
                }
            }
        }
        out.append('"');
        return out.toString();
    }
}

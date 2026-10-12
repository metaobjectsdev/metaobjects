package com.metaobjects.generator;

import com.metaobjects.generator.apidocs.ApiSymbol;
import com.metaobjects.generator.apidocs.ApiSymbolKind;
import com.metaobjects.generator.apidocs.ApiUnit;
import com.metaobjects.generator.apidocs.ClasspathTemplateProvider;
import com.metaobjects.generator.apidocs.DocsPaths;
import com.metaobjects.generator.apidocs.FieldShape;
import com.metaobjects.generator.apidocs.JavaApiDocsGenerator;
import com.metaobjects.generator.apidocs.JavaApiDocsRenderer;
import com.metaobjects.generator.apidocs.JavaApiModel;
import com.metaobjects.generator.apidocs.JavaApiModelBuilder;
import com.metaobjects.generator.apidocs.JavaFieldShapes;
import com.metaobjects.generator.apidocs.UnitExample;
import com.metaobjects.generator.direct.metadata.ai.MetaDataAIDocumentationGenerator;
import com.metaobjects.generator.direct.metadata.ai.MetaDataAIDocumentationWriter;
import com.metaobjects.generator.direct.metadata.file.json.MetaDataFileJsonSchemaGenerator;
import com.metaobjects.generator.direct.metadata.file.json.MetaDataFileSchemaWriter;
import com.metaobjects.generator.direct.metadata.html.MetaDataHtmlDocumentationGenerator;
import com.metaobjects.generator.direct.metadata.html.MetaDataHtmlDocumentationWriter;
import com.metaobjects.generator.direct.object.BaseObjectCodeGenerator;
import com.metaobjects.generator.direct.object.BaseObjectCodeWriter;
import com.metaobjects.generator.direct.object.javacode.ExtractorCodeGenerator;
import com.metaobjects.generator.direct.object.javacode.JavaCodeGenerator;
import com.metaobjects.generator.direct.object.javacode.JavaCodeWriter;
import com.metaobjects.generator.direct.object.javacode.JavaObjectCodeGenerator;
import com.metaobjects.generator.direct.object.javacode.PojoAwareCodeWriter;
import com.metaobjects.generator.direct.object.javacode.ValueObjectCodeWriter;
import com.metaobjects.generator.spring.Fr019SharedEnum;
import com.metaobjects.generator.spring.JUnitRequirementTestsGenerator;
import com.metaobjects.generator.spring.LlmTraceHelperGenerator;
import com.metaobjects.generator.spring.OutputFormatSpecEmitter;
import com.metaobjects.generator.spring.SpringControllerGenerator;
import com.metaobjects.generator.spring.SpringDtoGenerator;
import com.metaobjects.generator.spring.SpringFilterAllowlistGenerator;
import com.metaobjects.generator.spring.SpringNamesGenerator;
import com.metaobjects.generator.spring.SpringOutputParserGenerator;
import com.metaobjects.generator.spring.SpringOutputPromptGenerator;
import com.metaobjects.generator.spring.SpringRecordBuilder;
import com.metaobjects.generator.spring.SpringRenderHelperGenerator;
import com.metaobjects.generator.spring.SpringRepositoryGenerator;
import com.metaobjects.generator.spring.SpringValueObjectGenerator;
import com.metaobjects.generator.template.TemplateScopeGenerator;

import java.util.Collections;
import java.util.List;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Stable-name registry for Java's code generators (ADR-0021 D3).
 *
 * <p>Maps each <em>canonical stable name</em> (the cross-port spelling pinned in
 * {@code fixtures/generator-registry-conformance/registry.json}) to metadata about
 * the Java generator that exposes it: the implementing class' FQN, a short
 * description, and its {@link Tier}.</p>
 *
 * <p>The registry deliberately holds only metadata — it is a stable-name contract
 * and a conformance anchor, <em>not</em> a live factory. Java generators live across
 * several modules ({@code codegen-base}, {@code codegen-spring}, {@code render}); a
 * string-keyed metadata map keeps the contract in one place without forcing a heavy
 * cross-module instantiation graph. FQNs are captured via {@code Class.getName()} so
 * the contract follows refactors/renames of the generator classes.</p>
 *
 * <p>This registry's name set is conformance-gated against the canonical manifest's
 * {@code java} slice by {@code GeneratorRegistryConformanceTest}. Adding, removing,
 * or renaming a generator means editing <em>both</em> the manifest and this registry
 * in the same change — the gate fails on any drift.</p>
 *
 * <p>Follow-up (not in scope here): wire Maven generator selection-by-stable-name
 * through this registry (the staged ADR-0021 D3 fan-out).</p>
 */
public final class GeneratorRegistry {

    /** Generator tier, mirroring the manifest's {@code tier} field. */
    public enum Tier {
        /** Idiomatic, per-port hand-written generator. */
        NATIVE,
        /** Tier-2 neutral artifact owned by {@code meta docs}. */
        NEUTRAL
    }

    /**
     * The six layers a generator can belong to — the axis an adopter SELECTS BY,
     * mirroring the manifest's {@code layer} field and gated against it exactly as
     * {@link Tier} is.
     *
     * <p>Six, not ten. An earlier draft split {@code CAPABILITY} four ways, each with
     * ONE member — a layer with one member does no grouping work. The first four layers
     * are app-shape decisions a builder makes; {@code CAPABILITY} holds the ones the
     * MODEL has already made (you declared a {@code template.prompt}), which is why they
     * are found by probing a real model rather than by browsing a taxonomy.</p>
     */
    public enum Layer {
        /** Entity / DTO / value-object modules and the constants beside them. */
        MODEL,
        /** Query helpers, DbContext, repositories, table objects. */
        PERSISTENCE,
        /** HTTP surface: routes, filter allowlists, validators, wiring. */
        API,
        /** Browser tier: forms, hooks, grids. */
        CLIENT,
        /** Documentation artifacts (on by default; owned by the docs door). */
        DOCS,
        /** Chosen by the model, not by browsing — prompts, parsers, payloads, traces. */
        CAPABILITY;

        /** The manifest's spelling: lower-case, hyphen-free. */
        public String manifestValue() {
            return name().toLowerCase(java.util.Locale.ROOT);
        }
    }

    /** Immutable metadata for a single registered generator. */
    public static final class GeneratorInfo {
        private final String stableName;
        private final String classname;
        private final String description;
        private final Tier tier;
        private final Layer layer;
        private final String ejectResourcePath;
        private final List<String> ejectRuntime;
        private final String ejectNote;
        private final List<String> ejectWith;
        private final List<String> ejectResources;

        public GeneratorInfo(String stableName, String classname, String description,
                             Tier tier, Layer layer) {
            this(stableName, classname, description, tier, layer, null);
        }

        public GeneratorInfo(String stableName, String classname, String description,
                             Tier tier, Layer layer, String ejectResourcePath) {
            this(stableName, classname, description, tier, layer, ejectResourcePath, List.of());
        }

        /**
         * @param ejectResourcePath classpath location of this generator's reference source,
         *      as shipped inside the {@code codegen-*} jar that owns it (e.g. {@code
         *      META-INF/metaobjects/reference/java/SpringNamesGenerator.java}), or {@code
         *      null} when this generator is not ejectable — {@code mvn metaobjects:eject}
         *      reads this field to resolve {@code -Dnames}. Which generators may carry none
         *      is ruled in the shared manifest ({@code fixtures/generator-registry-conformance/
         *      registry.json}, the {@code eject} entries) and asserted by {@code
         *      EjectContractTest}: "template" and "mustache" are exempt, with reasons.
         * @param ejectRuntime simple names of the helper-runtime classes this generator's
         *      OUTPUT imports (from {@link #RUNTIME_PACKAGE}), closed over their own references
         *      to each other. {@code mvn metaobjects:eject} copies their source (shipped under
         *      {@link #EJECT_RUNTIME_RESOURCE_ROOT}) into the adopter's module with the
         *      generator, so the owned output depends on owned code only.
         */
        public GeneratorInfo(String stableName, String classname, String description,
                             Tier tier, Layer layer, String ejectResourcePath,
                             List<String> ejectRuntime) {
            this(stableName, classname, description, tier, layer, ejectResourcePath,
                    ejectRuntime, null, List.of());
        }

        /**
         * @param ejectNote wiring the generic eject report cannot know, printed after it;
         *      {@code null} for a generator whose only wiring is the {@code <classname>}
         *      change. {@code {owned}} in it is replaced by the owned copy's class name.
         * @param ejectWith fully-qualified names of the classes that hold the rest of this
         *      GENERATOR's emit (its bases and writers), closed over their references to each
         *      other. {@code mvn metaobjects:eject} copies each one's source (shipped at
         *      {@link #EJECT_RESOURCE_ROOT}{@code <SimpleName>.java}) into the same owned
         *      package as the generator and points their imports of one another at the copies,
         *      so an owned generator extends and calls owned code. Not {@code ejectRuntime}:
         *      that is what the generated OUTPUT imports.
         */
        public GeneratorInfo(String stableName, String classname, String description,
                             Tier tier, Layer layer, String ejectResourcePath,
                             List<String> ejectRuntime, String ejectNote, List<String> ejectWith) {
            this(stableName, classname, description, tier, layer, ejectResourcePath,
                    ejectRuntime, ejectNote, ejectWith, List.of());
        }

        /**
         * @param ejectResources the template references this GENERATOR's emit reads from the
         *      classpath, each the path under {@link #TEMPLATE_RESOURCE_PREFIX} without its
         *      {@code .md.mustache} extension (e.g. {@code api/index}). {@code mvn
         *      metaobjects:eject} copies each into the adopter's module, under the owned
         *      package's path, and points the owned template provider there, so the page text
         *      is the adopter's too. Each is shipped at {@link #EJECT_TEMPLATE_RESOURCE_ROOT}.
         */
        public GeneratorInfo(String stableName, String classname, String description,
                             Tier tier, Layer layer, String ejectResourcePath,
                             List<String> ejectRuntime, String ejectNote, List<String> ejectWith,
                             List<String> ejectResources) {
            this.ejectResources = List.copyOf(ejectResources);
            this.stableName = stableName;
            this.classname = classname;
            this.description = description;
            this.tier = tier;
            this.layer = layer;
            this.ejectResourcePath = ejectResourcePath;
            this.ejectRuntime = List.copyOf(ejectRuntime);
            this.ejectNote = ejectNote;
            this.ejectWith = List.copyOf(ejectWith);
        }

        /** Canonical cross-port stable name (the manifest key). */
        public String stableName() {
            return stableName;
        }

        /** Fully-qualified class name of the implementing generator. */
        public String classname() {
            return classname;
        }

        /** Short human description of what the generator emits. */
        public String description() {
            return description;
        }

        /** The generator's tier (native vs neutral). */
        public Tier tier() {
            return tier;
        }

        /** The generator's layer — the axis an adopter selects by. */
        public Layer layer() {
            return layer;
        }

        /** Classpath resource path of this generator's ejectable reference source, or
         *  {@code null} when it is not ejectable (see the constructor javadoc). */
        public String ejectResourcePath() {
            return ejectResourcePath;
        }

        /** Simple names of the helper-runtime classes this generator's output imports — the
         *  source {@code mvn metaobjects:eject} hands over with it (see the constructor). */
        public List<String> ejectRuntime() {
            return ejectRuntime;
        }

        /** Wiring to print after the generic eject report, or {@code null} (see the
         *  constructor). */
        public String ejectNote() {
            return ejectNote;
        }

        /** Fully-qualified names of the classes copied with this generator into its owned
         *  package, the rest of its emit (see the constructor). */
        public List<String> ejectWith() {
            return ejectWith;
        }

        /** Template references copied with this generator into the adopter's resources (see
         *  the constructor). */
        public List<String> ejectResources() {
            return ejectResources;
        }

        @Override
        public String toString() {
            return "GeneratorInfo{" + stableName + " -> " + classname
                    + " (" + tier + ", " + layer + ")}";
        }
    }

    /** What the generated controller imports — the whole filter pipeline, the patch and
     *  constraint error mapping, and the record-component escape. Declared before
     *  {@code REGISTRY}: static initializers run in order. */
    private static final List<String> ROUTES_RUNTIME = List.of(
            "ConstraintErrors", "FilterParseResult", "FilterParser", "FilterPredicate",
            "PatchValidationException", "RecordComponentNames");

    /** The writer a generated type's package and class name are read from, and its base. */
    private static final List<String> OBJECT_NAMING = List.of(
            JavaCodeWriter.class.getName(), BaseObjectCodeWriter.class.getName());

    /** The rest of "entity"'s emit: the bases that parse its arguments and place each file,
     *  and the writers that emit the class body, one per flavor. */
    private static final List<String> ENTITY_EMIT = List.of(
            JavaCodeGenerator.class.getName(), BaseObjectCodeGenerator.class.getName(),
            BaseObjectCodeWriter.class.getName(), JavaCodeWriter.class.getName(),
            PojoAwareCodeWriter.class.getName(), ValueObjectCodeWriter.class.getName(),
            ExtractorCodeGenerator.class.getName());

    /** The shared and externally-provided enum writer, and the builder a generated record
     *  carries: emit code the DTO and value-object generators each call, so each takes a copy. */
    private static final List<String> RECORD_EMIT = List.of(
            Fr019SharedEnum.class.getName(), SpringRecordBuilder.class.getName());

    /** The enum writer the output parser calls. */
    private static final List<String> ENUM_EMIT = List.of(Fr019SharedEnum.class.getName());

    /** The rest of {@code api-docs}: the page IR, the builder that fills it, the renderer, the page
     *  paths and the template provider. {@code GeneratorApplicability} is the engine. */
    private static final List<String> API_DOCS_EMIT = List.of(
            ApiSymbol.class.getName(), ApiSymbolKind.class.getName(), ApiUnit.class.getName(),
            ClasspathTemplateProvider.class.getName(), DocsPaths.class.getName(), FieldShape.class.getName(),
            JavaApiDocsRenderer.class.getName(), JavaApiModel.class.getName(),
            JavaApiModelBuilder.class.getName(), JavaFieldShapes.class.getName(), UnitExample.class.getName());

    /** The page text of {@code api-docs}, read from the classpath. */
    private static final List<String> API_DOCS_TEMPLATES = List.of("api/entity-api", "api/index", "api/agent-api");

    /** The prompt-tier writer behind {@code output-prompt}: the format-spec literal. */
    private static final List<String> PROMPT_EMIT = List.of(OutputFormatSpecEmitter.class.getName());

    /** The two generators that live in modules this one does not depend on
     *  ({@code codegen-plantuml}, {@code codegen-mustache}), so they are named, not
     *  referenced. {@code GeneratorRegistryConformanceTest} loads every registered class. */
    private static final String PLANTUML_GENERATOR =
            "com.metaobjects.generator.direct.plantuml.PlantUMLGenerator";
    private static final String PLANTUML_WRITER =
            "com.metaobjects.generator.direct.plantuml.PlantUMLWriter";
    private static final String MUSTACHE_GENERATOR =
            "com.metaobjects.generator.mustache.MustacheTemplateGenerator";

    private static final Map<String, GeneratorInfo> REGISTRY = buildRegistry();

    /** Classpath root every ejectable Java generator's reference source is shipped under
     *  (FR — eject in every port, JVM section). A generator's resource lives at {@code
     *  <this>/<SimpleClassName>.java}, inside whichever {@code codegen-*} jar owns it. */
    public static final String EJECT_RESOURCE_ROOT = "META-INF/metaobjects/reference/java/";

    /** The package generated Spring code imports its helper runtime from when nothing is
     *  ejected: {@code FilterParser}, {@code PatchValidationException}, {@code
     *  ConstraintErrors} and friends. These are HELPERS (ADR-0034 Amendment 3), not core. */
    public static final String RUNTIME_PACKAGE = "com.metaobjects.generator.spring.runtime";

    /** Classpath root the helper-runtime sources are shipped under, one {@code
     *  <SimpleName>.java} per class, for {@code mvn metaobjects:eject} to copy. */
    public static final String EJECT_RUNTIME_RESOURCE_ROOT = EJECT_RESOURCE_ROOT + "runtime/";

    /** Simple names of the support classes the Java generators share: emit rules more than
     *  one generator applies (which fields a DTO carries, validation annotations, M:N finder
     *  naming). {@code mvn metaobjects:eject} copies one beside every ejected generator whose
     *  source imports it, so the adopter owns those rules with the generator. */
    public static final List<String> EJECT_SUPPORT = List.of("SpringGeneratorSupport");

    /** The package the packaged support classes live in, and the one an ejectable generator
     *  imports them from. */
    public static final String SUPPORT_PACKAGE = "com.metaobjects.generator.spring";

    /** The classpath prefix the packaged api-docs templates are read from, and an owned copy's
     *  template provider is pointed away from (see {@link GeneratorInfo#ejectResources()}). */
    public static final String TEMPLATE_RESOURCE_PREFIX = "templates/";

    /** Classpath root the template sources are shipped under, one {@code <ref>.md.mustache} per
     *  reference, for {@code mvn metaobjects:eject} to copy. */
    public static final String EJECT_TEMPLATE_RESOURCE_ROOT = EJECT_RESOURCE_ROOT + "templates/";

    /** Classpath root the support sources are shipped under, one {@code <SimpleName>.java}
     *  per class, for {@code mvn metaobjects:eject} to copy. */
    public static final String EJECT_SUPPORT_RESOURCE_ROOT = EJECT_RESOURCE_ROOT + "support/";

    private GeneratorRegistry() {
    }

    /** {@code <EJECT_RESOURCE_ROOT>/<simple class name>.java} for an ejectable generator. */
    private static String ejectPath(Class<?> impl) {
        return EJECT_RESOURCE_ROOT + impl.getSimpleName() + ".java";
    }

    private static Map<String, GeneratorInfo> buildRegistry() {
        Map<String, GeneratorInfo> m = new LinkedHashMap<>();
        // "entity" and "extractor" live in codegen-base, which ships their reference source
        // (its pom, the same execution as this module's). The class body "entity" writes is
        // emitted by its writers, so the owned copy is the generator AND those writers, with
        // the two bases between it and the file loop (ADR-0034 Amendment 6).
        register(m, "entity", JavaObjectCodeGenerator.class.getName(),
                "Per-entity Java model/class (table-backed or value object).", Tier.NATIVE, Layer.MODEL,
                ejectPath(JavaObjectCodeGenerator.class), List.of(), null, ENTITY_EMIT);
        register(m, "routes", SpringControllerGenerator.class.getName(),
                "Per-entity Spring @RestController endpoint surface.", Tier.NATIVE, Layer.API,
                ejectPath(SpringControllerGenerator.class), ROUTES_RUNTIME);
        register(m, "output-parser", SpringOutputParserGenerator.class.getName(),
                "Per-template response parser: a strict parse that rejects a reply not matching the "
                    + "@responseRef shape, plus a tolerant, never-throwing extractLenient. [Emitted code imports "
                    + "com.metaobjects.object.extract, so the consuming module needs a "
                    + "`metaobjects-om` dependency — without it the generated parser does not "
                    + "compile and nothing in the build says why.]", Tier.NATIVE, Layer.CAPABILITY,
                ejectPath(SpringOutputParserGenerator.class), List.of(), null, ENUM_EMIT);
        register(m, "output-prompt", SpringOutputPromptGenerator.class.getName(),
                "Per-template output-format prompt fragment generator.", Tier.NATIVE, Layer.CAPABILITY,
                ejectPath(SpringOutputPromptGenerator.class), List.of(), null, PROMPT_EMIT);
        register(m, "render-helper", SpringRenderHelperGenerator.class.getName(),
                "Per-renderable-template render helper (typed wrappers; document/email for a template.output, the document shape for a template.prompt).", Tier.NATIVE, Layer.CAPABILITY,
                ejectPath(SpringRenderHelperGenerator.class));
        // "extractor" is a generator of its own AND a step "entity" runs when no separate
        // one is in the run (EmitsObjectExtractors), so an existing pom that wires only
        // "entity" emits what it always did. The note is what eject prints: unlike every
        // other generator there may be no <generator> entry to change, only one to add.
        register(m, "extractor", ExtractorCodeGenerator.class.getName(),
                "Per-object typed <Name>Extractor: tolerant recovery of the typed, flavored object "
                    + "graph from dirty model text; throws only when a @required field is lost. `entity` "
                    + "writes these itself with a concrete flavor, unless this generator is in "
                    + "<generators> too.", Tier.NATIVE, Layer.CAPABILITY,
                ejectPath(ExtractorCodeGenerator.class), List.of(),
                "extractor: `entity` writes the <Name>Extractor classes itself unless a separate "
                    + "extractor generator is in <generators>. If yours has no entry for one, add "
                    + "<generator><classname>{owned}</classname></generator> with the same outputDir, "
                    + "pkgPrefix, pkgSuffix, namePrefix and nameSuffix args, and the same <filters>, as "
                    + "your entity generator: an extractor for an object entity wrote no class for does "
                    + "not compile. `entity` then leaves those files to it. A pom with more than "
                    + "one entity entry needs one extractor entry per entity entry, each with that "
                    + "entry's outputDir, naming args and <filters>: a single extractor generator in "
                    + "the run stops every entity entry writing its extractors.",
                OBJECT_NAMING);
        // "template" stays registered but is NOT ejectable: it is already a generic,
        // declaratively-configured primitive (Mustache template + output pattern) with no
        // emit LOGIC in it to own — you customize it via args/template-spec, not by editing
        // its source, so ejecting it would not serve ADR-0034's purpose.
        register(m, "template", TemplateScopeGenerator.class.getName(),
                "Generic Mustache template primitive (walk + template -> files) — the "
                    + "Maven-wirable declarative form over the conformance-pinned renderer.", Tier.NATIVE, Layer.CAPABILITY);
        register(m, "filter-allowlist", SpringFilterAllowlistGenerator.class.getName(),
                "Per-entity REST filter allowlist (queryable-field guard).", Tier.NATIVE, Layer.API,
                ejectPath(SpringFilterAllowlistGenerator.class));
        register(m, "repository", SpringRepositoryGenerator.class.getName(),
                "Per-entity Spring Data repository.", Tier.NATIVE, Layer.PERSISTENCE,
                ejectPath(SpringRepositoryGenerator.class), List.of("FilterPredicate"));
        register(m, "dto", SpringDtoGenerator.class.getName(),
                "Per-entity Spring DTO record.", Tier.NATIVE, Layer.MODEL,
                ejectPath(SpringDtoGenerator.class), List.of("PatchValidationException"), null, RECORD_EMIT);
        register(m, "value-object", SpringValueObjectGenerator.class.getName(),
                "Per-value-object Spring record with jakarta constraints — the typed "
                    + "component the DTO/Patch bind for a field.object @storage:jsonb column, "
                    + "and a template's payload/response type.", Tier.NATIVE, Layer.MODEL,
                ejectPath(SpringValueObjectGenerator.class), List.of(), null, RECORD_EMIT);
        register(m, "trace-helper", LlmTraceHelperGenerator.class.getName(),
                "Per-entity typed record<Entity> LLM-trace helper (extract + buildLlmCallRow + persist; "
                    + "LlmCallBase-derived entities only).", Tier.NATIVE, Layer.CAPABILITY,
                ejectPath(LlmTraceHelperGenerator.class));
        register(m, "requirement-tests", JUnitRequirementTestsGenerator.class.getName(),
                "Per-package JUnit Jupiter tests, one per tested requirement, each calling a project-owned "
                    + "witness class through a generated interface; a live test with no witness fails and a "
                    + "planned or retired one is @Disabled.",
                Tier.NATIVE, Layer.CAPABILITY, ejectPath(JUnitRequirementTestsGenerator.class));
        register(m, "names", SpringNamesGenerator.class.getName(),
                "Per-object physical database name constants (table/view/schema/column) "
                    + "for a hand-written consumer to reference instead of a string literal.", Tier.NATIVE, Layer.MODEL,
                ejectPath(SpringNamesGenerator.class));
        // The generators below were wirable by class name and in no registry, so no catalog,
        // eject command or test saw them (ADR-0034 Amendment 8). Each is a generator and the writer
        // that emits its file; eject copies both. "mustache" never ejects: it is deprecated in
        // favour of "template".
        register(m, "api-docs", JavaApiDocsGenerator.class.getName(),
                "Per-entity/template SDK API reference (generated-code API; human + agent forms).",
                Tier.NATIVE, Layer.DOCS, ejectPath(JavaApiDocsGenerator.class), List.of(),
                "api-docs: `mvn metaobjects:docs` runs this generator, not `metaobjects:generate`, which "
                    + "skips it. List it in <generators> with <classname>{owned}</classname> and the "
                    + "docs goal runs your copy for the java surface in place of the packaged one.",
                API_DOCS_EMIT, API_DOCS_TEMPLATES);
        register(m, "plantuml", PLANTUML_GENERATOR,
                "PlantUML class diagram of the object model.", Tier.NATIVE, Layer.DOCS,
                EJECT_RESOURCE_ROOT + "PlantUMLGenerator.java", List.of(), null, List.of(PLANTUML_WRITER));
        register(m, "html-docs", MetaDataHtmlDocumentationGenerator.class.getName(),
                "Single-page HTML reference of the registered metamodel types, read from the "
                    + "type registry.", Tier.NATIVE, Layer.DOCS,
                ejectPath(MetaDataHtmlDocumentationGenerator.class), List.of(), null,
                List.of(MetaDataHtmlDocumentationWriter.class.getName()));
        register(m, "ai-docs", MetaDataAIDocumentationGenerator.class.getName(),
                "JSON reference of the registered metamodel types written for an AI reader, "
                    + "read from the type registry.", Tier.NATIVE, Layer.DOCS,
                ejectPath(MetaDataAIDocumentationGenerator.class), List.of(), null,
                List.of(MetaDataAIDocumentationWriter.class.getName()));
        register(m, "json-schema", MetaDataFileJsonSchemaGenerator.class.getName(),
                "JSON Schema that validates metadata files, read from the type registry.",
                Tier.NATIVE, Layer.CAPABILITY,
                ejectPath(MetaDataFileJsonSchemaGenerator.class), List.of(), null,
                List.of(MetaDataFileSchemaWriter.class.getName()));
        register(m, "mustache", MUSTACHE_GENERATOR,
                "The pre-`template` Mustache generator, kept so a pom that names its class keeps "
                    + "building. Deprecated: use `template`.", Tier.NATIVE, Layer.CAPABILITY);
        return Collections.unmodifiableMap(m);
    }

    private static void register(Map<String, GeneratorInfo> m, String stableName,
                                 String classname, String description, Tier tier, Layer layer) {
        register(m, stableName, classname, description, tier, layer, null);
    }

    private static void register(Map<String, GeneratorInfo> m, String stableName,
                                 String classname, String description, Tier tier, Layer layer,
                                 String ejectResourcePath) {
        register(m, stableName, classname, description, tier, layer, ejectResourcePath, List.of());
    }

    private static void register(Map<String, GeneratorInfo> m, String stableName,
                                 String classname, String description, Tier tier, Layer layer,
                                 String ejectResourcePath, List<String> ejectRuntime) {
        register(m, stableName, classname, description, tier, layer, ejectResourcePath,
                ejectRuntime, null, List.of());
    }

    private static void register(Map<String, GeneratorInfo> m, String stableName,
                                 String classname, String description, Tier tier, Layer layer,
                                 String ejectResourcePath, List<String> ejectRuntime,
                                 String ejectNote, List<String> ejectWith) {
        register(m, stableName, classname, description, tier, layer, ejectResourcePath,
                ejectRuntime, ejectNote, ejectWith, List.of());
    }

    private static void register(Map<String, GeneratorInfo> m, String stableName,
                                 String classname, String description, Tier tier, Layer layer,
                                 String ejectResourcePath, List<String> ejectRuntime,
                                 String ejectNote, List<String> ejectWith, List<String> ejectResources) {
        if (m.put(stableName, new GeneratorInfo(stableName, classname, description, tier, layer,
                ejectResourcePath, ejectRuntime, ejectNote, ejectWith, ejectResources)) != null) {
            throw new IllegalStateException("duplicate generator stable name: " + stableName);
        }
    }

    /** All registered generators, keyed by stable name (insertion-ordered, immutable). */
    public static Map<String, GeneratorInfo> list() {
        return REGISTRY;
    }

    /** Lookup a single generator by its stable name, or {@code null} if absent. */
    public static GeneratorInfo get(String stableName) {
        return REGISTRY.get(stableName);
    }
}

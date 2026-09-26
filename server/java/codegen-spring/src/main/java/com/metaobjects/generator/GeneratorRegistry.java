package com.metaobjects.generator;

import com.metaobjects.generator.direct.object.javacode.ExtractorCodeGenerator;
import com.metaobjects.generator.direct.object.javacode.JavaObjectCodeGenerator;
import com.metaobjects.generator.spring.LlmTraceHelperGenerator;
import com.metaobjects.generator.spring.SpringControllerGenerator;
import com.metaobjects.generator.spring.SpringDtoGenerator;
import com.metaobjects.generator.spring.SpringFilterAllowlistGenerator;
import com.metaobjects.generator.spring.SpringNamesGenerator;
import com.metaobjects.generator.spring.SpringOutputParserGenerator;
import com.metaobjects.generator.spring.SpringOutputPromptGenerator;
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
         *      reads this field to resolve {@code -Dnames}. See {@link
         *      docs/superpowers/specs/2026-09-22-eject-in-every-port-design.md the JVM
         *      eject design} for why some registered generators (the "extractor" that is
         *      fused into "entity"; "template", a generic declarative primitive with no
         *      emit logic to own) deliberately carry no eject source.
         * @param ejectRuntime simple names of the helper-runtime classes this generator's
         *      OUTPUT imports (from {@link #RUNTIME_PACKAGE}), closed over their own references
         *      to each other. {@code mvn metaobjects:eject} copies their source (shipped under
         *      {@link #EJECT_RUNTIME_RESOURCE_ROOT}) into the adopter's module with the
         *      generator, so the owned output depends on owned code only.
         */
        public GeneratorInfo(String stableName, String classname, String description,
                             Tier tier, Layer layer, String ejectResourcePath,
                             List<String> ejectRuntime) {
            this.stableName = stableName;
            this.classname = classname;
            this.description = description;
            this.tier = tier;
            this.layer = layer;
            this.ejectResourcePath = ejectResourcePath;
            this.ejectRuntime = List.copyOf(ejectRuntime);
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

    private GeneratorRegistry() {
    }

    /** {@code <EJECT_RESOURCE_ROOT>/<simple class name>.java} for an ejectable generator. */
    private static String ejectPath(Class<?> impl) {
        return EJECT_RESOURCE_ROOT + impl.getSimpleName() + ".java";
    }

    private static Map<String, GeneratorInfo> buildRegistry() {
        Map<String, GeneratorInfo> m = new LinkedHashMap<>();
        // "entity" stays registered but is NOT ejectable on Java: JavaObjectCodeGenerator
        // lives in codegen-base (not this module), extends a same-package superclass
        // (JavaCodeGenerator), and directly instantiates the FUSED, non-ejectable
        // ExtractorCodeGenerator plus other same-package writer helpers
        // (PojoAwareCodeWriter / ValueObjectCodeWriter). Ejecting it would mean widening a
        // whole internal writer hierarchy to public — a materially bigger surface than the
        // other ten generators, for a generator this port already documents as fused to a
        // non-ejectable neighbor. Kotlin's "entity" (KotlinEntityGenerator) has no such
        // entanglement and IS ejectable — see GeneratorRegistry.kt.
        register(m, "entity", JavaObjectCodeGenerator.class.getName(),
                "Per-entity Java model/class (table-backed or value object).", Tier.NATIVE, Layer.MODEL);
        register(m, "routes", SpringControllerGenerator.class.getName(),
                "Per-entity Spring @RestController endpoint surface.", Tier.NATIVE, Layer.API,
                ejectPath(SpringControllerGenerator.class), ROUTES_RUNTIME);
        register(m, "output-parser", SpringOutputParserGenerator.class.getName(),
                "Per-template response parser: a strict parse that rejects a reply not matching the "
                    + "@responseRef shape, plus a tolerant, never-throwing extractLenient. [Emitted code imports "
                    + "com.metaobjects.object.extract, so the consuming module needs a "
                    + "`metaobjects-om` dependency — without it the generated parser does not "
                    + "compile and nothing in the build says why.]", Tier.NATIVE, Layer.CAPABILITY,
                ejectPath(SpringOutputParserGenerator.class));
        register(m, "output-prompt", SpringOutputPromptGenerator.class.getName(),
                "Per-template output-format prompt fragment generator.", Tier.NATIVE, Layer.CAPABILITY,
                ejectPath(SpringOutputPromptGenerator.class));
        register(m, "render-helper", SpringRenderHelperGenerator.class.getName(),
                "Per-renderable-template render helper (typed wrappers; document/email for a template.output, the document shape for a template.prompt).", Tier.NATIVE, Layer.CAPABILITY,
                ejectPath(SpringRenderHelperGenerator.class));
        // "extractor" stays registered (discoverable, cross-port symmetric) but is NOT
        // ejectable: it is fused into "entity"'s own emission (JavaObjectCodeGenerator),
        // not a separately wirable generator with its own emit logic to own.
        register(m, "extractor", ExtractorCodeGenerator.class.getName(),
                "Per-template typed extract<Name> helper: tolerant recovery of the typed response from "
                    + "dirty model text; throws only when a @required field is lost. FUSED into `entity` on this "
                    + "port — emitted by JavaObjectCodeGenerator, not separately wirable.", Tier.NATIVE, Layer.CAPABILITY);
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
                ejectPath(SpringDtoGenerator.class), List.of("PatchValidationException"));
        register(m, "value-object", SpringValueObjectGenerator.class.getName(),
                "Per-value-object Spring record with jakarta constraints — the typed "
                    + "component the DTO/Patch bind for a field.object @storage:jsonb column, "
                    + "and a template's payload/response type.", Tier.NATIVE, Layer.MODEL,
                ejectPath(SpringValueObjectGenerator.class));
        register(m, "trace-helper", LlmTraceHelperGenerator.class.getName(),
                "Per-entity typed record<Entity> LLM-trace helper (extract + buildLlmCallRow + persist; "
                    + "LlmCallBase-derived entities only).", Tier.NATIVE, Layer.CAPABILITY,
                ejectPath(LlmTraceHelperGenerator.class));
        register(m, "names", SpringNamesGenerator.class.getName(),
                "Per-object physical database name constants (table/view/schema/column) "
                    + "for a hand-written consumer to reference instead of a string literal.", Tier.NATIVE, Layer.MODEL,
                ejectPath(SpringNamesGenerator.class));
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
        if (m.put(stableName, new GeneratorInfo(stableName, classname, description, tier, layer,
                ejectResourcePath, ejectRuntime)) != null) {
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

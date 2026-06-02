package com.metaobjects.generator;

import com.metaobjects.generator.direct.object.javacode.ExtractorCodeGenerator;
import com.metaobjects.generator.direct.object.javacode.JavaObjectCodeGenerator;
import com.metaobjects.generator.spring.SpringControllerGenerator;
import com.metaobjects.generator.spring.SpringDtoGenerator;
import com.metaobjects.generator.spring.SpringFilterAllowlistGenerator;
import com.metaobjects.generator.spring.SpringOutputParserGenerator;
import com.metaobjects.generator.spring.SpringOutputPromptGenerator;
import com.metaobjects.generator.spring.SpringPayloadGenerator;
import com.metaobjects.generator.spring.SpringRenderHelperGenerator;
import com.metaobjects.generator.spring.SpringRepositoryGenerator;
import com.metaobjects.render.templategen.TemplateGenerator;

import java.util.Collections;
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

    /** Immutable metadata for a single registered generator. */
    public static final class GeneratorInfo {
        private final String stableName;
        private final String classname;
        private final String description;
        private final Tier tier;

        public GeneratorInfo(String stableName, String classname, String description, Tier tier) {
            this.stableName = stableName;
            this.classname = classname;
            this.description = description;
            this.tier = tier;
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

        @Override
        public String toString() {
            return "GeneratorInfo{" + stableName + " -> " + classname + " (" + tier + ")}";
        }
    }

    private static final Map<String, GeneratorInfo> REGISTRY = buildRegistry();

    private GeneratorRegistry() {
    }

    private static Map<String, GeneratorInfo> buildRegistry() {
        Map<String, GeneratorInfo> m = new LinkedHashMap<>();
        register(m, "entity", JavaObjectCodeGenerator.class.getName(),
                "Per-entity Java model/class (table-backed or value object).", Tier.NATIVE);
        register(m, "routes", SpringControllerGenerator.class.getName(),
                "Per-entity Spring @RestController endpoint surface.", Tier.NATIVE);
        register(m, "output-parser", SpringOutputParserGenerator.class.getName(),
                "Per-template tolerant output parser (recover-on-receipt).", Tier.NATIVE);
        register(m, "output-prompt", SpringOutputPromptGenerator.class.getName(),
                "Per-template output-format prompt fragment generator.", Tier.NATIVE);
        register(m, "render-helper", SpringRenderHelperGenerator.class.getName(),
                "Per-template.output render helper (document/email typed wrappers).", Tier.NATIVE);
        register(m, "extractor", ExtractorCodeGenerator.class.getName(),
                "Per-template strict typed extract<Name> helper.", Tier.NATIVE);
        register(m, "template", TemplateGenerator.class.getName(),
                "Generic Mustache template primitive (walk + template -> files).", Tier.NATIVE);
        register(m, "filter-allowlist", SpringFilterAllowlistGenerator.class.getName(),
                "Per-entity REST filter allowlist (queryable-field guard).", Tier.NATIVE);
        register(m, "payload", SpringPayloadGenerator.class.getName(),
                "Per-template payload value object (the strict payload type).", Tier.NATIVE);
        register(m, "repository", SpringRepositoryGenerator.class.getName(),
                "Per-entity Spring Data repository.", Tier.NATIVE);
        register(m, "dto", SpringDtoGenerator.class.getName(),
                "Per-entity Spring DTO record.", Tier.NATIVE);
        return Collections.unmodifiableMap(m);
    }

    private static void register(Map<String, GeneratorInfo> m, String stableName,
                                 String classname, String description, Tier tier) {
        if (m.put(stableName, new GeneratorInfo(stableName, classname, description, tier)) != null) {
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

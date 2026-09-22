package com.metaobjects.generator.spring;

import com.metaobjects.generator.direct.object.javacode.JavaObjectCodeGenerator;
import com.metaobjects.generator.Generator;
import com.metaobjects.generator.util.GeneratedFileWriter;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.registry.SharedRegistryTestBase;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.stream.Stream;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * CODEGEN-COMPILE CONFORMANCE (Java lane).
 *
 * <p>Generate from the SHARED cross-port corpus —
 * {@code fixtures/persistence-conformance/canonical/meta.fitness.json} — and compile
 * every emitted file with the real Java compiler. Zero diagnostics or the lane is red.
 *
 * <p>WHY THIS EXISTS. Four defects shipped in 1.0.4 that every existing gate was blind
 * to, because each one produced output that PARSES and GENERATES cleanly and only fails
 * when somebody builds it:
 *
 * <ul>
 *   <li>a view over an int-backed enum imported a codec drizzle does not export (TS);
 *   <li>a renamed projection field selected a column that does not exist (TS);
 *   <li>a DbContext named FK config through {@code nameof} on a member that is not there (C#);
 *   <li>an extract mapper did not compile for most scalar subtypes (Java).
 * </ul>
 *
 * <p>{@code mvn metaobjects:generate} exits 0 in all four cases. The metamodel, render,
 * persistence, api-contract and registry corpora all stay green — they gate BEHAVIOR, and
 * none of them asks whether the emitted code builds. The adopter's build is the first
 * thing that does, which makes the adopter the gate. This closes that.
 *
 * <p>WHY THIS IS NOT THE EXISTING COMPILE TESTS. Roughly twenty tests in this package
 * compile generated Java, and every one of them runs ONE generator (or a tight pair) over
 * a small hand-authored fixture built to corner a specific emit. That is the right tool
 * for a targeted regression and the wrong one for this: a defect that only appears when
 * the whole tier is emitted TOGETHER over a real model — an entity referencing a names
 * constant, a DTO referencing a value object, a repository referencing both — has no
 * single-generator test that could fail on it. This compiles the fan-out as one program,
 * over the same 16-entity corpus the other four ports generate from.
 *
 * <p>WHAT IT EXCLUDES: {@link SpringControllerGenerator}, the ONLY generator in this
 * module whose emitted code references {@code org.springframework.*} — and this module
 * declares no Spring dependency at any scope, by design ("Hand-rolled string emission; no
 * Spring runtime dependency"). Every peer port draws the same line for the same reason
 * (TS omits routesFile, C# omits RoutesGenerator), so the boundary is a cross-port rule
 * rather than a local concession. The generated controller is compiled and booted over
 * real HTTP in {@code integration-tests}, which does have Spring on its test classpath.
 *
 * <p>The TEMPLATE capability tier (output-parser / output-prompt / render-helper) IS in
 * scope as of 2026-09-22. It used to be excluded on the grounds that the corpus declared
 * no {@code template.*} node, which was true and was the whole problem: the tier that
 * ADR-0056 rewrote sat outside the one gate that asks whether emitted code builds, and a
 * lowercase-initial template name duly shipped emitting a TypeScript extractor importing
 * a symbol its parser exports under a different capitalization. The corpus now declares a
 * responding {@code template.prompt} (deliberately lowercase-initial), so the exclusion no
 * longer describes anything. {@code trace-helper} stays out: it keys off an
 * {@code LlmCallBase} subclass, which this corpus still has none of.
 *
 * <p>The peer lanes are the same test in each port. If one port drops out, that port
 * keeps precisely the bug class this exists to catch — so a skip here is never "just this
 * lane".
 */
public class CodegenCompileConformanceTest extends SharedRegistryTestBase {

    @Rule
    public TemporaryFolder tempFolder = new TemporaryFolder();

    /**
     * Generate one selection into one output dir and compile the whole tree as a single
     * program. Compiling the fan-out TOGETHER is the point: emitting each generator into
     * its own sandbox would re-create the single-generator blind spot this test exists to
     * close, because the cross-artifact references would never be resolved.
     *
     * <p>The run is opened through {@link GeneratedFileWriter#beginRun()} — the same scope
     * {@code MetaDataGeneratorMojo} opens around a real build — so a selection in which two
     * generators claim one output path fails here instead of resolving by generator order.
     */
    private void generateAndCompile(String label, Map<String, Map<String, String>> selection,
            int minFiles, String... expectedTypes) throws Exception {
        String canonicalMeta = Files.readString(
            SpringTestFixtures.findCorpusRoot().resolve("canonical/meta.fitness.json"), StandardCharsets.UTF_8);

        Path outDir = tempFolder.newFolder("gen-" + label).toPath();
        Path workspace = tempFolder.newFolder("ws-" + label).toPath();
        MetaDataLoader loader =
            SpringTestFixtures.loadFixture(workspace, "fitness-" + label, canonicalMeta);

        // Each Java generator decides its own applicability INSIDE execute(loader) — via its
        // own static appliesTo(MetaObject) guard chain — so unlike the TS lane there is no
        // runner-level `matches` to compose here. Driving them exactly as the Maven plugin
        // does is what keeps this measuring the emit and not the harness.
        try (GeneratedFileWriter.Run run = GeneratedFileWriter.beginRun()) {
            for (Map.Entry<String, Map<String, String>> e : selection.entrySet()) {
                Generator gen = newGenerator(e.getKey());
                run.attributeTo(gen.getClass().getSimpleName());
                Map<String, String> args = new LinkedHashMap<>(e.getValue());
                args.put("outputDir", outDir.toString());
                gen.setArgs(args).execute(loader);
            }
        }

        long emitted;
        try (Stream<Path> s = Files.walk(outDir)) {
            emitted = s.filter(p -> p.toString().endsWith(".java")).count();
        }
        assertFalse(label + ": the shared corpus generated no .java files at all", emitted == 0);
        // The floor is PER SELECTION. It used to be a flat `> 16`, calibrated for the
        // entity fan-out — which a template-only selection cannot reach (it emits one
        // artifact per template plus the value objects), so the count was a floor for one
        // selection and a trap for the next.
        assertTrue(
            label + ": expected at least " + minFiles + " file(s) from this selection, saw " + emitted,
            emitted >= minFiles);

        // A compile gate passes trivially on an empty emit, so name what this selection
        // must have produced. A corpus edit that drops the nodes fails here loudly rather
        // than leaving the lane green over a model with nothing in it.
        for (String type : expectedTypes) {
            boolean found;
            try (Stream<Path> s2 = Files.walk(outDir)) {
                found = s2.anyMatch(p -> p.getFileName().toString().equals(type + ".java"));
            }
            assertTrue(label + ": expected " + type + ".java in the emitted tree", found);
        }

        // Fails with every diagnostic plus a dump of every generated source file.
        SpringTestFixtures.compileGenerated(outDir, tempFolder.newFolder("classes-" + label).toPath());
    }

    private static Generator newGenerator(String stableName) {
        switch (stableName) {
            case "entity":           return new JavaObjectCodeGenerator();
            case "value-object":     return new SpringValueObjectGenerator();
            case "dto":              return new SpringDtoGenerator();
            case "repository":       return new SpringRepositoryGenerator();
            case "filter-allowlist": return new SpringFilterAllowlistGenerator();
            case "names":            return new SpringNamesGenerator();
            case "output-parser":    return new SpringOutputParserGenerator();
            case "output-prompt":    return new SpringOutputPromptGenerator();
            case "render-helper":    return new SpringRenderHelperGenerator();
            default: throw new IllegalArgumentException("unmapped generator: " + stableName);
        }
    }

    private static final Map<String, String> PLAIN = Map.of();
    private static final Map<String, String> AS_CLASS = Map.of("type", "class", "flavor", "pojoAware");

    /**
     * The render-helper and output-prompt generators run a BUILD-TIME drift gate, so they
     * need the on-disk mustache the corpus's {@code @textRef} points at. The corpus ships
     * it beside the model, so every port's lane resolves the same bytes.
     */
    private static Map<String, String> withTemplateRoot() {
        return Map.of("templateRoot",
            SpringTestFixtures.findCorpusRoot().resolve("canonical/prompts").toString());
    }

    /**
     * The plain Java model tier: POJO classes plus the physical-name constants they pair
     * with. This is what an adopter selects with no Spring web surface at all.
     */
    @Test
    public void theJavaModelTierCompiles() throws Exception {
        Map<String, Map<String, String>> selection = new LinkedHashMap<>();
        selection.put("entity", AS_CLASS);
        selection.put("names", PLAIN);
        generateAndCompile("model", selection, 17);
    }

    /**
     * The Spring request/response tier: the DTO/Patch pair, the value-object records they
     * bind, the repositories and the filter allowlists.
     *
     * <p>{@code entity} is deliberately NOT in this selection, and not for tidiness.
     * {@code entity} and {@code value-object} BOTH emit a Java type for an
     * {@code object.value} at the same path — a POJO class and a record — so selecting both
     * is an order-dependent build, which {@link GeneratedFileWriter.Run} now raises rather
     * than resolving silently. These two selections are the two coherent halves.
     */
    @Test
    public void theSpringWebTierCompiles() throws Exception {
        Map<String, Map<String, String>> selection = new LinkedHashMap<>();
        selection.put("value-object", PLAIN);
        selection.put("dto", PLAIN);
        selection.put("repository", PLAIN);
        selection.put("filter-allowlist", PLAIN);
        selection.put("names", PLAIN);
        generateAndCompile("web", selection, 17);
    }

    /**
     * The TEMPLATE tier, compiled as one program with the value objects it references.
     *
     * <p>{@code value-object} is in the selection because ADR-0056 made the template tier
     * reference each value object's OWN record rather than a template-named copy — so the
     * tier does not compile alone, and a selection that left it out would prove nothing
     * about the reference. {@code entity} stays out for the same reason it does in the web
     * tier: it and {@code value-object} both claim the output path of an
     * {@code object.value}.
     */
    @Test
    public void theTemplateTierCompiles() throws Exception {
        Map<String, Map<String, String>> selection = new LinkedHashMap<>();
        selection.put("value-object", PLAIN);
        selection.put("render-helper", withTemplateRoot());
        selection.put("output-prompt", withTemplateRoot());
        selection.put("output-parser", withTemplateRoot());
        generateAndCompile("template", selection, 6,
            "CoachNoteRenderHelper", "CoachNoteResponseFormat", "CoachNoteParser",
            "ProgramBrief", "ProgramVerdict", "WeekLabel");
    }
}

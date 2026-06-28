package com.metaobjects.generator.apidocs;

import com.metaobjects.generator.direct.object.javacode.JavaObjectCodeGenerator;
import com.metaobjects.generator.spring.SpringControllerGenerator;
import com.metaobjects.generator.spring.SpringDtoGenerator;
import com.metaobjects.generator.spring.SpringFilterAllowlistGenerator;
import com.metaobjects.generator.spring.SpringOutputParserGenerator;
import com.metaobjects.generator.spring.SpringOutputPromptGenerator;
import com.metaobjects.generator.spring.SpringPayloadGenerator;
import com.metaobjects.generator.spring.SpringRenderHelperGenerator;
import com.metaobjects.generator.spring.SpringRepositoryGenerator;
import com.metaobjects.generator.spring.SpringTestFixtures;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.registry.SharedRegistryTestBase;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.EnumSet;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;
import java.util.stream.Stream;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

/**
 * SP-2a keystone ACCURACY GATE: proves the {@link JavaApiModelBuilder}'s documented
 * SDK surface == what the REAL Spring/Java generators actually emit.
 *
 * <p>The builder enumerates symbol names via the {@code SpringNaming} seam and gates
 * inclusion via each generator's {@code appliesTo(...)} predicate, so by construction
 * documented == generated. This test is the cross-check that holds that promise: it
 * runs every real generator into a temp directory, then greps the generated Java for
 * every documented symbol (forward) and confirms skip-shapes are not over-documented
 * (inverse). It deliberately does NOT compare against the builder's own strings — the
 * forward assertions match documented names against the independently generated source.</p>
 *
 * <h2>Fixture</h2>
 * Loaded from the Java-test-local resource {@code apidocs-fixture/meta.json} (NOT the
 * repo-root {@code fixtures/conformance/} corpus, which cross-port harnesses glob). It
 * covers every skip branch the builder exercises:
 * <ul>
 *   <li>{@code Author} TABLE entity (pk, {@code @required name}, optional {@code bio},
 *       {@code field.enum status}, {@code @filterable name}) → MODEL/DTO/DATA_ACCESS/
 *       REST/FILTER/VALIDATION;</li>
 *   <li>M:N {@code Author} ↔ {@code Tag} via the {@code AuthorTag} junction → the M:N
 *       REST traversal + repository finder;</li>
 *   <li>{@code Address} value object (no identity, no rdb source) → MODEL only;</li>
 *   <li>{@code SummaryOutput} json {@code template.output} → PAYLOAD/RENDER/PROMPT/
 *       OUTPUT_PARSER;</li>
 *   <li>{@code WelcomeEmail} email {@code template.output} → PAYLOAD/RENDER/PROMPT/
 *       OUTPUT_PARSER (the prompt/parser apply regardless of {@code @kind});</li>
 *   <li>{@code ClassifyPrompt} {@code template.prompt} → PAYLOAD only (RENDER/PROMPT/
 *       OUTPUT_PARSER require {@code SUBTYPE_OUTPUT}; this is the prompt-vs-output
 *       skip difference).</li>
 * </ul>
 *
 * <h2>EXTRACTOR deferral (intentional)</h2>
 * {@code JavaObjectCodeGenerator} emits a {@code <Name>Extractor} only when run with a
 * concrete {@code flavor} arg (pojoAware/valueObject) — a generator-config choice not
 * present in the loaded metadata and with no {@code appliesTo} predicate. The builder
 * deliberately does NOT document EXTRACTOR (stays drift-proof: document only what the
 * loaded model determines), so this gate likewise does NOT assert EXTRACTOR symbols.
 * The {@code Extractor} files DO appear in the generated output here (we run the model
 * generator with {@code flavor=pojoAware}), but since the builder emits no EXTRACTOR
 * symbol there is nothing to forward-check — the asymmetry is by design.
 */
public class JavaApiDocsAccuracyTest extends SharedRegistryTestBase {

    private static final String PROJECT = "apidocs-fixture";

    @Rule
    public TemporaryFolder tempFolder = new TemporaryFolder();

    private MetaDataLoader loader;
    private JavaApiModel model;

    /** All generated .java concatenated. */
    private String allGenerated;
    /** Relative-path → file content, for the per-file (controller / DTO) checks. */
    private Map<String, String> generatedByFile;

    @Before
    public void setUp() throws Exception {
        Path workspace = tempFolder.newFolder("apidocs-fx").toPath();
        loader = SpringTestFixtures.loadFixture(workspace, "apidocs", readFixture());

        model = new JavaApiModelBuilder().build(loader, PROJECT);

        Path templates = tempFolder.newFolder("templates").toPath();
        writeTemplates(templates);

        Path out = tempFolder.newFolder("gen").toPath();
        runGenerators(out, templates);

        StringBuilder all = new StringBuilder();
        generatedByFile = new LinkedHashMap<>();
        try (Stream<Path> s = Files.walk(out)) {
            List<Path> javaFiles = s.filter(p -> p.toString().endsWith(".java"))
                                    .sorted()
                                    .collect(Collectors.toList());
            for (Path p : javaFiles) {
                String content = Files.readString(p);
                generatedByFile.put(out.relativize(p).toString(), content);
                all.append(content).append('\n');
            }
        }
        allGenerated = all.toString();
        assertFalse("expected the real generators to emit .java", generatedByFile.isEmpty());
    }

    // ------------------------------------------------------------------------
    // Task A load-smoke: the fixture loads with zero errors.
    // ------------------------------------------------------------------------

    @Test
    public void fixtureLoadsWithZeroErrors() {
        // loadFixture already calls loader.init(); a parse/validation error would have
        // thrown. Assert the expected nodes are present so a silently-empty load is loud.
        assertNotNull("loader", loader);
        assertTrue("expected the Author entity in the loaded fixture",
            loader.getMetaObjects().stream().anyMatch(o -> o.getName().endsWith("::Author")));
        assertTrue("expected the Tag entity", hasObject("::Tag"));
        assertTrue("expected the AuthorTag junction", hasObject("::AuthorTag"));
        assertTrue("expected the Address value object", hasObject("::Address"));
        assertTrue("expected at least one unit in the model", !model.units().isEmpty());
    }

    // ------------------------------------------------------------------------
    // 3. Forward accuracy: every documented TYPE name appears in the real output.
    // ------------------------------------------------------------------------

    @Test
    public void everyDocumentedTypeNameAppearsInGeneratedJava() {
        // The generated-TYPE kinds whose symbol.name() is an emitted Java identifier.
        // REST is excluded (it documents "VERB path", handled separately).
        Set<ApiSymbolKind> typeKinds = EnumSet.of(
            ApiSymbolKind.MODEL, ApiSymbolKind.DTO, ApiSymbolKind.DATA_ACCESS,
            ApiSymbolKind.FILTER, ApiSymbolKind.PAYLOAD, ApiSymbolKind.RENDER,
            ApiSymbolKind.PROMPT, ApiSymbolKind.OUTPUT_PARSER, ApiSymbolKind.TRACE,
            // VALIDATION names the DTO record (Jakarta constraints live on it).
            ApiSymbolKind.VALIDATION);

        int checked = 0;
        for (ApiUnit unit : model.units()) {
            for (ApiSymbol sym : unit.symbols()) {
                if (!typeKinds.contains(sym.kind())) continue;
                assertTrue(
                    "documented " + sym.kind() + " symbol '" + sym.name()
                        + "' (unit " + unit.node() + ") was NOT found as an identifier in the "
                        + "generated Java — builder over-documents or names off-seam",
                    containsIdentifier(allGenerated, sym.name()));
                checked++;
            }
        }
        // Aggregate count so a regression that quietly stops documenting symbols is loud.
        assertTrue("expected to have cross-checked several documented type symbols; saw " + checked,
            checked >= 10);
    }

    // ------------------------------------------------------------------------
    // 4. REST accuracy: each "VERB path" maps to a real controller mapping.
    // ------------------------------------------------------------------------

    @Test
    public void everyRestSymbolMapsToARealControllerMapping() {
        String controller = fileEndingWith("AuthorController.java");
        String base = "/api/authors";
        assertTrue("controller must carry the route base via @RequestMapping(\"" + base + "\")",
            controller.contains("@RequestMapping(\"" + base + "\")"));

        ApiUnit author = unit("Author");
        int restChecked = 0;
        for (ApiSymbol sym : author.symbols()) {
            if (sym.kind() != ApiSymbolKind.REST) continue;
            String[] vp = sym.name().split(" ", 2);
            assertEquals("REST symbol name must be 'VERB path'; saw '" + sym.name() + "'", 2, vp.length);
            String verb = vp[0];
            String path = vp[1];
            assertTrue("REST path '" + path + "' must start with the controller base '" + base + "'",
                path.equals(base) || path.startsWith(base + "/"));
            String sub = path.substring(base.length()); // "" | "/{id}" | "/{id}/tags"

            String expectedMapping = mappingFor(verb, sub);
            assertTrue(
                "REST symbol '" + sym.name() + "' has no matching Spring mapping in AuthorController.\n"
                    + "expected to find: " + expectedMapping,
                controller.contains(expectedMapping));
            restChecked++;
        }
        // The fixture's Author yields the 5 CRUD verbs + 1 M:N traversal.
        assertEquals("expected 6 REST symbols on Author (5 CRUD + 1 M:N)", 6, restChecked);
    }

    /** The exact Spring mapping annotation the controller emits for a verb + sub-path. */
    private static String mappingFor(String verb, String sub) {
        switch (verb) {
            case "GET":
                // GET list → bare @GetMapping; GET by id / M:N → @GetMapping("<sub>").
                return sub.isEmpty() ? "@GetMapping\n" : "@GetMapping(\"" + sub + "\")";
            case "POST":
                return "@PostMapping\n";
            case "DELETE":
                return "@DeleteMapping(\"" + sub + "\")";
            case "PATCH":
                // PATCH + PUT share one composed @RequestMapping with method={PATCH, PUT}.
                return "@RequestMapping(value = \"" + sub
                    + "\", method = { RequestMethod.PATCH, RequestMethod.PUT })";
            default:
                throw new AssertionError("unexpected REST verb: " + verb);
        }
    }

    // ------------------------------------------------------------------------
    // 5. Field-set accuracy: documented DTO field set == record component set.
    // ------------------------------------------------------------------------

    @Test
    public void documentedDtoFieldSetEqualsRecordComponentSet() {
        ApiUnit author = unit("Author");
        ApiSymbol dto = symbol(author, ApiSymbolKind.DTO, "AuthorDto");
        assertFalse("AuthorDto must document field shapes", dto.fields().isEmpty());

        Set<String> documented = new TreeSet<>();
        for (FieldShape f : dto.fields()) documented.add(f.name());

        Set<String> components = recordComponents(fileEndingWith("AuthorDto.java"), "AuthorDto");

        // Each documented field appears as a record component...
        for (String name : documented) {
            assertTrue("documented DTO field '" + name + "' is not a component of AuthorDto",
                components.contains(name));
        }
        // ...and the SETS are equal (no missing, no extra).
        assertEquals("documented DTO field set must equal AuthorDto's record component set",
            components, documented);
    }

    // ------------------------------------------------------------------------
    // 6. Inverse: no over-documentation of skip-shapes.
    // ------------------------------------------------------------------------

    @Test
    public void valueObjectIsDocumentedAsModelOnly() {
        ApiUnit address = unit("Address");
        assertEquals("value object Address → MODEL only (no DTO/REST/repository/etc.)",
            EnumSet.of(ApiSymbolKind.MODEL), kinds(address));

        // Explicitly: no over-documented categories for a value object.
        for (ApiSymbol s : address.symbols()) {
            assertEquals("Address must carry only MODEL symbols", ApiSymbolKind.MODEL, s.kind());
        }
        // No AddressController / AddressDto / AddressRepository emitted either (the
        // generators skip value objects), so even the names must be absent.
        assertFalse("no AddressDto should be generated", containsIdentifier(allGenerated, "AddressDto"));
        assertFalse("no AddressController should be generated",
            containsIdentifier(allGenerated, "AddressController"));
        assertFalse("no AddressRepository should be generated",
            containsIdentifier(allGenerated, "AddressRepository"));
    }

    @Test
    public void projectionIsDocumentedAsReadModelAndReadDtoOnly() {
        // A concrete object.projection (read-only-kind source) → MODEL + DTO only.
        // SpringDtoGenerator.appliesTo emits a read DTO for a projection; the write +
        // queryable surfaces (controller/repository/filter/trace) gate on a writable
        // table entity and skip it — so NO VALIDATION/DATA_ACCESS/REST/FILTER/TRACE.
        ApiUnit summary = unit("AuthorSummary");
        assertEquals("object.projection AuthorSummary → projection unit kind",
            "projection", summary.kind());
        assertEquals("object.projection AuthorSummary → MODEL + read DTO only",
            EnumSet.of(ApiSymbolKind.MODEL, ApiSymbolKind.DTO), kinds(summary));

        // Forward-confirm the documented read DTO is really generated...
        assertTrue("documented AuthorSummaryDto must appear in generated Java",
            containsIdentifier(allGenerated, "AuthorSummaryDto"));
        // ...and the skipped write/query surfaces are NOT generated for a projection.
        assertFalse("no AuthorSummaryController should be generated",
            containsIdentifier(allGenerated, "AuthorSummaryController"));
        assertFalse("no AuthorSummaryRepository should be generated",
            containsIdentifier(allGenerated, "AuthorSummaryRepository"));
        assertFalse("no AuthorSummaryFilter should be generated",
            containsIdentifier(allGenerated, "AuthorSummaryFilter"));
    }

    @Test
    public void abstractObjectIsNotDocumented() {
        // An abstract entity cannot be instantiated, so the builder documents no MODEL
        // for it; combined with every entity generator's appliesTo skipping abstracts,
        // it yields NO symbols and therefore NO unit at all (not an empty unit). This
        // gates the DOCUMENTATION side only — whether the legacy base generator emits a
        // class for abstract objects is a separate codegen concern, out of scope here.
        boolean hasUnit = model.units().stream().anyMatch(u -> u.node().equals("BaseNode"));
        assertFalse("abstract object BaseNode must NOT produce a unit (no symbols → no unit)", hasUnit);
    }

    @Test
    public void promptTemplateIsDocumentedAsPayloadOnly() {
        // template.prompt → PAYLOAD only; RENDER/PROMPT/OUTPUT_PARSER require SUBTYPE_OUTPUT.
        ApiUnit classify = unit("ClassifyPrompt");
        assertEquals("template.prompt ClassifyPrompt → PAYLOAD only",
            EnumSet.of(ApiSymbolKind.PAYLOAD), kinds(classify));

        // Forward-confirm the one PAYLOAD it DOES document is real...
        assertTrue("documented ClassifyPromptPayload must appear in generated Java",
            containsIdentifier(allGenerated, "ClassifyPromptPayload"));
        // ...and the skipped categories' names are absent from the generated output.
        assertFalse("no ClassifyPromptRenderHelper should exist",
            containsIdentifier(allGenerated, "ClassifyPromptRenderHelper"));
        assertFalse("no ClassifyPromptPrompt should exist",
            containsIdentifier(allGenerated, "ClassifyPromptPrompt"));
        assertFalse("no ClassifyPromptParser should exist",
            containsIdentifier(allGenerated, "ClassifyPromptParser"));
    }

    @Test
    public void outputTemplateDocumentsAllFourHelperKinds() {
        ApiUnit summary = unit("SummaryOutput");
        assertEquals("json template.output → PAYLOAD/RENDER/PROMPT/OUTPUT_PARSER",
            EnumSet.of(ApiSymbolKind.PAYLOAD, ApiSymbolKind.RENDER,
                       ApiSymbolKind.PROMPT, ApiSymbolKind.OUTPUT_PARSER),
            kinds(summary));
    }

    // ------------------------------------------------------------------------
    // run the REAL generators
    // ------------------------------------------------------------------------

    private void runGenerators(Path out, Path templates) {
        String dir = out.toString();
        String tpl = templates.toString();

        run(new SpringDtoGenerator(), Map.of("outputDir", dir));
        run(new SpringRepositoryGenerator(), Map.of("outputDir", dir));
        run(new SpringControllerGenerator(), Map.of("outputDir", dir));
        run(new SpringFilterAllowlistGenerator(), Map.of("outputDir", dir));
        run(new SpringPayloadGenerator(), Map.of("outputDir", dir, "templateRoot", tpl));
        // The render-helper / output-prompt generators run the build-time render against
        // the on-disk templates (drift gate), so they need the templateRoot.
        run(new SpringRenderHelperGenerator(), Map.of("outputDir", dir, "templateRoot", tpl));
        run(new SpringOutputPromptGenerator(), Map.of("outputDir", dir, "templateRoot", tpl));
        run(new SpringOutputParserGenerator(), Map.of("outputDir", dir, "templateRoot", tpl));
        // Model: pojoAware concrete flavor so a `class <Name>` is emitted per object
        // (this is what the MODEL symbol documents).
        run(new JavaObjectCodeGenerator(),
            Map.of("outputDir", dir, "type", "class", "flavor", "pojoAware"));
    }

    /**
     * Write the on-disk Mustache templates the fixture's {@code template.output} refs
     * point at. Each references ONLY fields present on the matching payload VO so the
     * render-helper's build-time drift gate passes. {@code ClassifyPrompt} is a
     * {@code template.prompt} (skipped by the output-only generators), so it needs none.
     */
    private static void writeTemplates(Path root) throws IOException {
        // SummaryOutput → SummaryPayloadVo { summary }
        writeTemplate(root, "blog/summary.mustache", "Summary: {{summary}}");
        // WelcomeEmail → WelcomePayloadVo { name, headline }
        writeTemplate(root, "email/welcome.subject.mustache", "Welcome {{name}}");
        writeTemplate(root, "email/welcome.html.mustache", "<p>{{headline}}</p>");
        writeTemplate(root, "email/welcome.text.mustache", "{{headline}}");
    }

    private static void writeTemplate(Path root, String relative, String body) throws IOException {
        Path f = root.resolve(relative);
        Files.createDirectories(f.getParent());
        Files.writeString(f, body);
    }

    private void run(com.metaobjects.generator.Generator gen, Map<String, String> args) {
        gen.setArgs(new HashMap<>(args));
        gen.execute(loader);
    }

    // ------------------------------------------------------------------------
    // helpers
    // ------------------------------------------------------------------------

    private static String readFixture() throws IOException {
        try (InputStream in = JavaApiDocsAccuracyTest.class
                .getResourceAsStream("/apidocs-fixture/meta.json")) {
            assertNotNull("apidocs-fixture/meta.json must be on the test classpath", in);
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        }
    }

    private boolean hasObject(String fqnSuffix) {
        return loader.getMetaObjects().stream().anyMatch(o -> o.getName().endsWith(fqnSuffix));
    }

    /** Word-boundary identifier match: `name` must appear as a whole Java identifier. */
    private static boolean containsIdentifier(String haystack, String name) {
        Matcher m = Pattern.compile("(?<![A-Za-z0-9_$])" + Pattern.quote(name) + "(?![A-Za-z0-9_$])")
                           .matcher(haystack);
        return m.find();
    }

    /** Parse the record header `record <Name>( ... ) {` into its component-name set
     *  (the body may be empty `{}` or carry nested enum decls `{ ... }`). */
    private static Set<String> recordComponents(String src, String recordName) {
        int decl = src.indexOf("record " + recordName + "(");
        assertTrue("could not find `record " + recordName + "(` in:\n" + src, decl >= 0);
        int open = src.indexOf('(', decl);
        int close = src.indexOf(") {", open);
        assertTrue("could not find record body open `) {` for " + recordName, close > open);
        String header = src.substring(open + 1, close);

        Set<String> names = new TreeSet<>();
        for (String raw : header.split(",")) {
            String part = raw.trim();
            if (part.isEmpty()) continue;
            // A component is `[annotations...] Type name`; the component name is the last token.
            String[] tokens = part.split("\\s+");
            names.add(tokens[tokens.length - 1]);
        }
        return names;
    }

    private String fileEndingWith(String suffix) {
        for (Map.Entry<String, String> e : generatedByFile.entrySet()) {
            if (e.getKey().endsWith(suffix)) return e.getValue();
        }
        throw new AssertionError("no generated file ending with '" + suffix + "' in "
            + generatedByFile.keySet());
    }

    private ApiUnit unit(String node) {
        for (ApiUnit u : model.units()) if (u.node().equals(node)) return u;
        throw new AssertionError("no unit '" + node + "' in " + model.units());
    }

    private static ApiSymbol symbol(ApiUnit u, ApiSymbolKind kind, String name) {
        for (ApiSymbol s : u.symbols()) if (s.kind() == kind && s.name().equals(name)) return s;
        throw new AssertionError("no " + kind + " '" + name + "' in " + u.symbols());
    }

    private static Set<ApiSymbolKind> kinds(ApiUnit u) {
        Set<ApiSymbolKind> out = EnumSet.noneOf(ApiSymbolKind.class);
        for (ApiSymbol s : u.symbols()) out.add(s.kind());
        return out;
    }
}

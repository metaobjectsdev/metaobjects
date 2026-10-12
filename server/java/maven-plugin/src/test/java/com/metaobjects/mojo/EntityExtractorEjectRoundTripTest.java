package com.metaobjects.mojo;

import com.metaobjects.generator.EmitsObjectExtractors;
import com.metaobjects.generator.Generator;
import com.metaobjects.generator.direct.object.javacode.ExtractorCodeGenerator;
import com.metaobjects.generator.direct.object.javacode.JavaObjectCodeGenerator;
import com.metaobjects.loader.LoaderOptions;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.loader.uri.URIHelper;
import org.apache.maven.plugin.MojoFailureException;
import org.apache.maven.plugin.logging.Log;
import org.apache.maven.project.MavenProject;
import org.junit.After;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import org.mockito.ArgumentCaptor;
import org.mockito.Mockito;

import javax.tools.Diagnostic;
import javax.tools.DiagnosticCollector;
import javax.tools.JavaCompiler;
import javax.tools.JavaFileObject;
import javax.tools.StandardJavaFileManager;
import javax.tools.StandardLocation;
import javax.tools.ToolProvider;
import java.io.File;
import java.io.IOException;
import java.net.URI;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.stream.Collectors;
import java.util.stream.Stream;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

/**
 * The Java {@code entity} and {@code extractor} generators are ejectable, proven five ways
 * (ADR-0034 Amendment 6): {@code mvn metaobjects:eject} copies each one with the rest of its
 * emit, the writers included; the copies, unchanged and compiled against the published jars,
 * write the same bytes as the packaged generator over the shared persistence corpus; an edit
 * to an owned writer changes the class body the owned generator writes; {@code -Dlist}
 * reports them and their owned copies like any other generator; and
 * {@code mvn metaobjects:verify} runs the owned copies when the pom names them.
 *
 * <p>{@link EjectRoundTripTest} is the same proof for {@code names}. These two get their own
 * because they were the two Java generators that could not be ejected: {@code entity}'s
 * class body is emitted by writer classes outside the generator, and {@code extractor} was
 * not a generator a pom could name.</p>
 */
public class EntityExtractorEjectRoundTripTest {

    private static final String OWNED_PACKAGE = "com.acme.codegen";
    private static final String OWNED_ENTITY = OWNED_PACKAGE + ".JavaObjectCodeGenerator";
    private static final String OWNED_EXTRACTOR = OWNED_PACKAGE + ".ExtractorCodeGenerator";

    /** Every file {@code -Dnames=entity,extractor} writes: the two generators, the bases
     *  {@code entity} extends, and the writers that emit the class body. */
    private static final List<String> OWNED_FILES = List.of(
            "JavaObjectCodeGenerator.java", "ExtractorCodeGenerator.java",
            "JavaCodeGenerator.java", "BaseObjectCodeGenerator.java",
            "BaseObjectCodeWriter.java", "JavaCodeWriter.java",
            "PojoAwareCodeWriter.java", "ValueObjectCodeWriter.java");

    @Rule
    public TemporaryFolder tempFolder = new TemporaryFolder();

    private MetaDataLoader loader;
    private Path fitness;
    private URLClassLoader ownedClasses;

    @Before
    public void setUp() throws IOException {
        fitness = findFitnessFixture();
        URI uri = URIHelper.toURI("model:file:" + fitness.toAbsolutePath().toString().replace('\\', '/'));
        loader = new MetaDataLoader(
                LoaderOptions.create(false, false, true),
                MetaDataLoader.SUBTYPE_MANUAL, "entity-extractor-eject-roundtrip");
        loader.setSourceURIs(List.of(uri));
        loader.init();
    }

    @After
    public void closeOwnedClasses() throws IOException {
        if (ownedClasses != null) ownedClasses.close();
    }

    /** Walk up from the test's working dir to the repo root. */
    private static Path findFitnessFixture() {
        Path dir = Path.of(System.getProperty("user.dir")).toAbsolutePath().normalize();
        for (Path p = dir; p != null; p = p.getParent()) {
            Path candidate = p.resolve("fixtures/persistence-conformance/canonical/meta.fitness.json");
            if (Files.exists(candidate)) return candidate;
        }
        throw new IllegalStateException(
                "could not locate fixtures/persistence-conformance/canonical/meta.fitness.json from " + dir);
    }

    // ------------------------------------------------------------------------------------
    // harness
    // ------------------------------------------------------------------------------------

    private MetaDataEjectMojo ejectMojo(Path projectDir) {
        MavenProject project = Mockito.mock(MavenProject.class);
        Mockito.when(project.getBasedir()).thenReturn(projectDir.toFile());
        Mockito.when(project.getGroupId()).thenReturn("com.acme");
        Mockito.when(project.getArtifactId()).thenReturn("widgets");
        Mockito.when(project.getVersion()).thenReturn("1.0.0");
        Mockito.when(project.getDependencies()).thenReturn(List.of());
        MetaDataEjectMojo mojo = new MetaDataEjectMojo();
        mojo.project = project;
        return mojo;
    }

    /** Eject both generators with {@code -Dport=java}; returns the owned source directory. */
    private Path ejectBoth(Path projectDir) throws Exception {
        MetaDataEjectMojo mojo = ejectMojo(projectDir);
        mojo.names = "entity,extractor";
        mojo.port = "java";
        mojo.execute();
        Path dir = projectDir.resolve("codegen/src/main/java/com/acme/codegen");
        try (Stream<Path> files = Files.list(dir)) {
            assertEquals(OWNED_FILES.stream().sorted().collect(Collectors.toList()),
                    files.map(f -> f.getFileName().toString()).sorted().collect(Collectors.toList()));
        }
        return dir;
    }

    /** Compile the owned copies against the published jars, as the adopter's module would. */
    private URLClassLoader compileOwned(Path ownedDir) throws Exception {
        List<File> sources;
        try (Stream<Path> files = Files.list(ownedDir)) {
            sources = files.filter(p -> p.toString().endsWith(".java")).map(Path::toFile)
                    .collect(Collectors.toList());
        }
        Path classes = tempFolder.newFolder().toPath();
        JavaCompiler javac = ToolProvider.getSystemJavaCompiler();
        DiagnosticCollector<JavaFileObject> diagnostics = new DiagnosticCollector<>();
        try (StandardJavaFileManager fm = javac.getStandardFileManager(diagnostics, null, StandardCharsets.UTF_8)) {
            fm.setLocation(StandardLocation.CLASS_OUTPUT, List.of(classes.toFile()));
            boolean ok = javac.getTask(null, fm, diagnostics,
                    List.of("-classpath", System.getProperty("java.class.path")), null,
                    fm.getJavaFileObjectsFromFiles(sources)).call();
            StringBuilder errs = new StringBuilder();
            for (Diagnostic<? extends JavaFileObject> d : diagnostics.getDiagnostics()) errs.append(d).append('\n');
            assertTrue("owned copies failed to compile:\n" + errs, ok);
        }
        ownedClasses = new URLClassLoader(new URL[]{classes.toUri().toURL()},
                Thread.currentThread().getContextClassLoader());
        return ownedClasses;
    }

    private static Generator owned(ClassLoader classes, String classname) throws Exception {
        return (Generator) Class.forName(classname, true, classes).getDeclaredConstructor().newInstance();
    }

    /** Run {@code generator} over the corpus into a fresh directory; every file it wrote. */
    private Map<String, String> generate(Generator generator, Map<String, String> args) throws IOException {
        Path out = tempFolder.newFolder().toPath();
        Map<String, String> all = new HashMap<>(args);
        all.put("outputDir", out.toString());
        generator.setArgs(all);
        generator.execute(loader);
        return tree(out);
    }

    private static Map<String, String> tree(Path root) throws IOException {
        Map<String, String> out = new TreeMap<>();
        try (Stream<Path> walk = Files.walk(root)) {
            for (Path p : walk.filter(Files::isRegularFile).collect(Collectors.toList())) {
                out.put(root.relativize(p).toString().replace('\\', '/'),
                        Files.readString(p, StandardCharsets.UTF_8));
            }
        }
        return out;
    }

    private static void assertSameTree(String label, Map<String, String> packaged, Map<String, String> owned) {
        assertEquals(label + ": same set of generated files",
                new ArrayList<>(packaged.keySet()), new ArrayList<>(owned.keySet()));
        for (Map.Entry<String, String> e : packaged.entrySet()) {
            assertEquals(label + ": content differs for " + e.getKey(), e.getValue(), owned.get(e.getKey()));
        }
    }

    private static final Map<String, String> POJO = Map.of("type", "class", "flavor", "pojoAware");

    // ------------------------------------------------------------------------------------
    // the unchanged copy writes what the packaged generator writes
    // ------------------------------------------------------------------------------------

    @Test
    public void anUnchangedEjectedEntityWritesWhatThePackagedOneWritesInEveryFlavor() throws Exception {
        ClassLoader classes = compileOwned(ejectBoth(tempFolder.newFolder("adopter").toPath()));

        Map<String, Map<String, String>> flavors = new TreeMap<>();
        flavors.put("pojoAware", POJO);
        flavors.put("valueObject", Map.of("type", "class", "flavor", "valueObject"));
        flavors.put("interface", Map.of("type", "interface"));
        // Naming args are read by the generator and by the writer it builds; a copy that
        // dropped one would land its classes somewhere else.
        flavors.put("pojoAware, renamed", Map.of("type", "class", "flavor", "pojoAware",
                "pkgPrefix", "com.example", "pkgSuffix", "model", "namePrefix", "My", "nameSuffix", "Vo"));

        for (Map.Entry<String, Map<String, String>> flavor : flavors.entrySet()) {
            Map<String, String> packaged = generate(new JavaObjectCodeGenerator(), flavor.getValue());
            Map<String, String> copy = generate(owned(classes, OWNED_ENTITY), flavor.getValue());
            assertTrue(flavor.getKey() + ": the corpus generated only " + packaged.size() + " files",
                    packaged.size() >= 17);
            assertSameTree(flavor.getKey(), packaged, copy);
        }
    }

    @Test
    public void anUnchangedEjectedExtractorWritesWhatThePackagedOneAndEntityWrite() throws Exception {
        ClassLoader classes = compileOwned(ejectBoth(tempFolder.newFolder("adopter").toPath()));

        Map<String, String> packaged = generate(new ExtractorCodeGenerator(), Map.of());
        Map<String, String> copy = generate(owned(classes, OWNED_EXTRACTOR), Map.of());
        assertTrue("the corpus generated only " + packaged.size() + " extractors", packaged.size() >= 17);
        assertSameTree("extractor", packaged, copy);

        // And they are the files entity writes when no separate extractor is in the run.
        Map<String, String> fromEntity = new TreeMap<>(generate(new JavaObjectCodeGenerator(), POJO));
        fromEntity.keySet().removeIf(path -> !path.endsWith("Extractor.java"));
        assertSameTree("extractor, against entity's own", fromEntity, copy);
    }

    // ------------------------------------------------------------------------------------
    // an edit to the copy shows in its output
    // ------------------------------------------------------------------------------------

    @Test
    public void anEditToEachOwnedCopyShowsInItsOutput() throws Exception {
        Path ownedDir = ejectBoth(tempFolder.newFolder("adopter").toPath());
        edit(ownedDir.resolve("JavaObjectCodeGenerator.java"),
                " * GENERATED — self-registering ", " * GENERATED (owned entity copy) — self-registering ");
        edit(ownedDir.resolve("ExtractorCodeGenerator.java"),
                " * GENERATED — extractor for {@code ", " * GENERATED (owned extractor copy) — extractor for {@code ");
        ClassLoader classes = compileOwned(ownedDir);

        Map<String, String> entity = generate(owned(classes, OWNED_ENTITY), POJO);
        assertTrue(entity.get("com/metaobjects/generated/GeneratedObjectClassBindingProvider.java")
                .contains("GENERATED (owned entity copy)"));
        // The owned entity writes its extractors through the owned extractor copy beside it, so an
        // edit there reaches the files entity writes too, with no extractor generator in the run.
        assertTrue(entity.get("fitness/ProgramExtractor.java").contains("owned extractor copy"));

        Map<String, String> extractor = generate(owned(classes, OWNED_EXTRACTOR), Map.of());
        assertTrue(extractor.get("fitness/ProgramExtractor.java").contains("GENERATED (owned extractor copy)"));
    }

    /**
     * The class body is owned, not just the generator around it. Each of the four writers is
     * edited where it emits, and each edit has to reach the output of the flavor that writer
     * serves, with no subclass and no change to the owned generator.
     */
    @Test
    public void anEditToEachOwnedWriterChangesTheClassBody() throws Exception {
        Path ownedDir = ejectBoth(tempFolder.newFolder("adopter").toPath());
        edit(ownedDir.resolve("BaseObjectCodeWriter.java"),
                "\"MetaObject:               \" + mo.getName()", "\"MetaObject (owned base):  \" + mo.getName()");
        edit(ownedDir.resolve("JavaCodeWriter.java"),
                "println(true, \"// \"+comment);", "println(true, \"// owned: \"+comment);");
        edit(ownedDir.resolve("PojoAwareCodeWriter.java"),
                "\"return this.\" + fieldName + \";\"", "\"return this.\" + fieldName + \"; // owned pojo\"");
        edit(ownedDir.resolve("ValueObjectCodeWriter.java"),
                "holderName + \".getValue();\"", "holderName + \".getValue(); // owned value object\"");
        ClassLoader classes = compileOwned(ownedDir);

        Map<String, String> valueObject = Map.of("type", "class", "flavor", "valueObject");
        String pojo = generate(owned(classes, OWNED_ENTITY), POJO).get("fitness/Program.java");
        assertTrue(pojo, pojo.contains(" * MetaObject (owned base):  fitness::Program"));
        assertTrue(pojo, pojo.contains("// owned: Methods for MetaField: "));
        assertTrue(pojo, pojo.contains("; // owned pojo"));
        String vo = generate(owned(classes, OWNED_ENTITY), valueObject).get("fitness/Program.java");
        assertTrue(vo, vo.contains(".getValue(); // owned value object"));
        assertTrue(vo, vo.contains(" * MetaObject (owned base):  fitness::Program"));

        // The packaged generator still writes through the packaged writers.
        for (Map<String, String> flavor : List.of(POJO, valueObject)) {
            String packaged = generate(new JavaObjectCodeGenerator(), flavor).get("fitness/Program.java");
            assertTrue(packaged, packaged.contains(" * MetaObject:               fitness::Program"));
            assertFalse(packaged, packaged.contains("// owned"));
        }
    }

    /**
     * The owned extractor reads each class name from the owned writer, so a rename there
     * moves the extractor with the class it casts to. Read from the packaged writer, it
     * would go on naming a class the owned {@code entity} no longer writes.
     */
    @Test
    public void theOwnedExtractorNamesItsClassesThroughTheOwnedWriter() throws Exception {
        Path ownedDir = ejectBoth(tempFolder.newFolder("adopter").toPath());
        edit(ownedDir.resolve("JavaCodeWriter.java"),
                "return GeneratorUtil.toCamelCase(name, true);\n    }\n\n    @Override\n    protected void writeGetter",
                "return GeneratorUtil.toCamelCase(name, true) + \"Row\";\n    }\n\n    @Override\n    protected void writeGetter");
        ClassLoader classes = compileOwned(ownedDir);

        Map<String, String> entity = new HashMap<>(POJO);
        entity.put(EmitsObjectExtractors.ARG_EMIT_EXTRACTORS, "false");
        String program = generate(owned(classes, OWNED_ENTITY), entity).get("fitness/Program.java");
        assertTrue(program, program.contains("public class ProgramRow extends "));

        Map<String, String> extractors = generate(owned(classes, OWNED_EXTRACTOR), Map.of());
        String extractor = extractors.get("fitness/ProgramRowExtractor.java");
        assertTrue(String.valueOf(extractors.keySet()), extractor != null);
        assertTrue(extractor, extractor.contains("public static ProgramRow extract("));
    }

    private static void edit(Path source, String from, String to) throws IOException {
        String original = Files.readString(source, StandardCharsets.UTF_8);
        assertTrue(source.getFileName() + " no longer holds: " + from, original.contains(from));
        Files.writeString(source, original.replace(from, to), StandardCharsets.UTF_8);
    }

    // ------------------------------------------------------------------------------------
    // -Dlist and the eject report
    // ------------------------------------------------------------------------------------

    private static String logged(Log log) {
        ArgumentCaptor<CharSequence> captor = ArgumentCaptor.forClass(CharSequence.class);
        Mockito.verify(log, Mockito.atLeastOnce()).info(captor.capture());
        return captor.getAllValues().stream().map(CharSequence::toString).collect(Collectors.joining("\n"));
    }

    private String list(Path projectDir) throws Exception {
        MetaDataEjectMojo mojo = ejectMojo(projectDir);
        mojo.list = true;
        Log log = Mockito.mock(Log.class);
        mojo.setLog(log);
        mojo.execute();
        return logged(log);
    }

    private static String row(String listing, String name) {
        return listing.lines().filter(l -> l.startsWith("  " + name + " [java]")).findFirst()
                .orElseThrow(() -> new AssertionError("no [java] row for " + name + " in:\n" + listing));
    }

    @Test
    public void theListingReportsBothAsEjectableAndMarksTheirOwnedCopies() throws Exception {
        Path projectDir = tempFolder.newFolder("adopter").toPath();

        String before = list(projectDir);
        for (String name : List.of("entity", "extractor")) {
            assertFalse(row(before, name), row(before, name).contains("not ejectable"));
            assertFalse(row(before, name), row(before, name).contains("[owned"));
        }
        // The one Java generator with nothing to own keeps saying so.
        assertTrue(row(before, "template"), row(before, "template").contains("not ejectable"));

        Path ownedDir = ejectBoth(projectDir);
        String owned = list(projectDir);
        assertTrue(row(owned, "entity"), row(owned, "entity").endsWith("[owned — identical]"));
        assertTrue(row(owned, "extractor"), row(owned, "extractor").endsWith("[owned — identical]"));

        edit(ownedDir.resolve("ExtractorCodeGenerator.java"),
                " * GENERATED — extractor for {@code ", " * GENERATED (mine) — extractor for {@code ");
        String edited = list(projectDir);
        assertTrue(row(edited, "extractor"),
                row(edited, "extractor").endsWith("[owned — DIFFERS: 1 behind, 1 of your own]"));
        // entity copies the extractor too, so an edit to it shows on entity's row as well.
        assertTrue(row(edited, "entity"),
                row(edited, "entity").endsWith("[owned — DIFFERS: 1 behind, 1 of your own]"));

        // A writer is part of the generator it was copied with: an edit to one only entity
        // has shows on entity's row, on top of the extractor edit it already carries, and leaves
        // the extractor's count where it was.
        edit(ownedDir.resolve("PojoAwareCodeWriter.java"),
                "println(true, \"super(mo);\");", "println(true, \"super(mo); // mine\");");
        String writerEdited = list(projectDir);
        assertTrue(row(writerEdited, "entity"),
                row(writerEdited, "entity").endsWith("[owned — DIFFERS: 2 behind, 2 of your own]"));
        assertTrue(row(writerEdited, "extractor"),
                row(writerEdited, "extractor").endsWith("[owned — DIFFERS: 1 behind, 1 of your own]"));
    }

    @Test
    public void ejectingTheExtractorSaysHowToWireAGeneratorThePomMayNotNameYet() throws Exception {
        MetaDataEjectMojo mojo = ejectMojo(tempFolder.newFolder("adopter").toPath());
        mojo.names = "extractor";
        mojo.port = "java";
        Log log = Mockito.mock(Log.class);
        mojo.setLog(log);
        mojo.execute();

        String out = logged(log);
        assertTrue(out, out.contains("<generator><classname>" + OWNED_EXTRACTOR + "</classname></generator>"));
        assertTrue(out, out.contains("`entity` then leaves those files to it"));
    }

    @Test
    public void bothNamesNeedAPortBecauseKotlinEjectsThemToo() throws Exception {
        MetaDataEjectMojo mojo = ejectMojo(tempFolder.newFolder("adopter").toPath());
        mojo.names = "entity,extractor";
        try {
            mojo.execute();
            fail("expected a refusal naming both ports");
        } catch (MojoFailureException e) {
            assertTrue(e.getMessage(), e.getMessage().contains("\"entity\" is ejectable on more than one port"));
            assertTrue(e.getMessage(), e.getMessage().contains("\"extractor\" is ejectable on more than one port"));
        }
    }

    // ------------------------------------------------------------------------------------
    // the drift check runs the owned copies
    // ------------------------------------------------------------------------------------

    /** A generate goal whose project classpath holds the adopter's compiled codegen module. */
    private MetaDataGeneratorMojo generateGoal(ClassLoader classes) {
        return new MetaDataGeneratorMojo() {
            @Override protected ClassLoader createProjectClassLoader() { return classes; }
        };
    }

    private MetaDataVerifyMojo verifyGoal(ClassLoader classes) {
        return new MetaDataVerifyMojo() {
            @Override protected ClassLoader createProjectClassLoader() { return classes; }
        };
    }

    /** A pom that names the owned copies: entity with a concrete flavor, and the extractor. */
    private void configure(AbstractMetaDataMojo mojo, Path outputDir) {
        mojo.setLoader(LoaderParam.builder("entity-extractor-drift")
                .withClassname("com.metaobjects.loader.MetaDataLoader")
                .withSourceDir(fitness.getParent().toString())
                .withSource(fitness.getFileName().toString())
                .build());
        List<GeneratorParam> generators = new ArrayList<>();
        generators.add(GeneratorParam.builder(OWNED_ENTITY)
                .withArg("outputDir", outputDir.toString())
                .withArg("type", "class")
                .withArg("flavor", "pojoAware")
                .build());
        generators.add(GeneratorParam.builder(OWNED_EXTRACTOR)
                .withArg("outputDir", outputDir.toString())
                .build());
        mojo.setGenerators(generators);
        mojo.setGlobals(Collections.emptyMap());
    }

    @Test
    public void theDriftCheckRunsTheOwnedCopiesAndReportsWhatTheyNoLongerProduce() throws Exception {
        Path ownedDir = ejectBoth(tempFolder.newFolder("adopter").toPath());
        // Both copies are edited, so output from the PACKAGED generators would read as drift:
        // an in-sync verdict below can only come from the copies having been the ones run.
        edit(ownedDir.resolve("JavaObjectCodeGenerator.java"),
                " * GENERATED — self-registering ", " * GENERATED (owned entity copy) — self-registering ");
        edit(ownedDir.resolve("ExtractorCodeGenerator.java"),
                " * GENERATED — extractor for {@code ", " * GENERATED (owned extractor copy) — extractor for {@code ");
        ClassLoader classes = compileOwned(ownedDir);

        Path committed = generatedInSync(classes);

        // One emitter per file: with the extractor in <generators>, entity left them to it.
        assertTrue(Files.readString(committed.resolve("fitness/ProgramExtractor.java"))
                .contains("GENERATED (owned extractor copy)"));
        assertTrue(Files.readString(committed.resolve(
                "com/metaobjects/generated/GeneratedObjectClassBindingProvider.java"))
                .contains("GENERATED (owned entity copy)"));

        // What the packaged generators write is drift against the owned copies.
        Files.writeString(committed.resolve("fitness/ProgramExtractor.java"),
                generate(new ExtractorCodeGenerator(), Map.of()).get("fitness/ProgramExtractor.java"),
                StandardCharsets.UTF_8);
        MetaDataVerifyMojo verify = verifyGoal(classes);
        configure(verify, committed);
        try {
            verify.execute();
            fail("expected content drift on the extractor the owned copy no longer writes that way");
        } catch (MojoFailureException e) {
            assertTrue(e.getMessage(), e.getMessage().contains("[content-differs]"));
            assertTrue(e.getMessage(), e.getMessage().contains("ProgramExtractor.java"));
        }
    }

    /**
     * Generate with the owned copies, let the wall clock move on to a later second, and
     * confirm the drift check finds nothing to report.
     *
     * <p>The wait is the point. The verify goal compares bytes, and each class header used
     * to carry a {@code Generated On:} line at second resolution, so the goal reported every
     * class file as drifted unless it ran in the same second as the generate it checked.
     * Generated output carries no clock now, and a verify on an unchanged model has to pass
     * whenever it runs.</p>
     */
    private Path generatedInSync(ClassLoader classes) throws Exception {
        Path committed = tempFolder.newFolder().toPath();
        MetaDataGeneratorMojo gen = generateGoal(classes);
        configure(gen, committed);
        gen.execute();

        long generatedIn = System.currentTimeMillis() / 1000;
        while (System.currentTimeMillis() / 1000 == generatedIn) {
            Thread.sleep(50);
        }

        MetaDataVerifyMojo verify = verifyGoal(classes);
        configure(verify, committed);
        verify.execute();
        return committed;
    }
}

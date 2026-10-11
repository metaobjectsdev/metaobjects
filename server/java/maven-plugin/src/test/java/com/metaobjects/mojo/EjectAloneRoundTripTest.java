package com.metaobjects.mojo;

import com.metaobjects.generator.Generator;
import com.metaobjects.generator.GeneratorRegistry;
import com.metaobjects.loader.LoaderOptions;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.loader.uri.URIHelper;
import org.apache.maven.project.MavenProject;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import org.mockito.Mockito;

import javax.tools.Diagnostic;
import javax.tools.DiagnosticCollector;
import javax.tools.ForwardingJavaFileManager;
import javax.tools.JavaCompiler;
import javax.tools.JavaFileManager;
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
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.stream.Collectors;
import java.util.stream.Stream;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * Eject proof, one generator at a time: an adopter ejects the generator they want to change,
 * not the whole tier, and what {@code mvn metaobjects:eject} writes for that one name must
 * compile on its own and own every emit rule it applies.
 *
 * <p>The Java routes, DTO, repository and value-object generators share emit rules through
 * {@code SpringGeneratorSupport}. Eject hands that class over with them, so each proof here
 * compiles what the real mojo wrote with the PACKAGED support class hidden from javac: a
 * copy that still resolved the packaged class would fail to compile.
 * <ol>
 *   <li><b>Alone.</b> Every ejectable Java generator, ejected by itself, compiles.</li>
 *   <li><b>Unchanged.</b> The owned generators emit byte for byte what the packaged ones do.</li>
 *   <li><b>Owned.</b> An edit to the owned support copy changes what two owned generators
 *       emit, and they still agree with each other. That holds for a rule a packaged helper
 *       used to answer on the owned generator's behalf too: which fields a DTO carries
 *       decides the record, its stamp methods and the controller's stamp calls together.</li>
 * </ol>
 * The list of generators comes from the registry, never a hand-typed one. No Kotlin generator
 * can reach the support class ({@code codegen-kotlin} does not depend on {@code
 * codegen-spring}); the Kotlin copies are compiled alone in that module.
 */
public class EjectAloneRoundTripTest {

    @Rule
    public TemporaryFolder tempFolder = new TemporaryFolder();

    private Path canonical;
    private MetaDataLoader loader;

    @Before
    public void setUp() {
        canonical = findCanonical();
        loader = load(canonical.resolve("meta.fitness.json"), "eject-alone-test");
    }

    private static MetaDataLoader load(Path model, String name) {
        URI uri = URIHelper.toURI("model:file:" + model.toAbsolutePath().toString().replace('\\', '/'));
        MetaDataLoader loader = new MetaDataLoader(LoaderOptions.create(false, false, true),
                MetaDataLoader.SUBTYPE_MANUAL, name);
        loader.setSourceURIs(List.of(uri));
        loader.init();
        return loader;
    }

    private static Path findCanonical() {
        Path dir = Path.of(System.getProperty("user.dir")).toAbsolutePath().normalize();
        for (Path p = dir; p != null; p = p.getParent()) {
            Path c = p.resolve("fixtures/persistence-conformance/canonical");
            if (Files.isDirectory(c)) return c;
        }
        throw new IllegalStateException("could not locate fixtures/persistence-conformance/canonical from " + dir);
    }

    private Map<String, String> args(Path outDir) {
        return args(outDir, "fitness");
    }

    private Map<String, String> args(Path outDir, String packageName) {
        Map<String, String> a = new LinkedHashMap<>();
        a.put("outputDir", outDir.toString());
        a.put("packageName", packageName);
        a.put("templateRoot", canonical.resolve("prompts").toString());
        return a;
    }

    private MetaDataEjectMojo mojo(Path projectDir, String names) {
        MavenProject project = Mockito.mock(MavenProject.class);
        Mockito.when(project.getBasedir()).thenReturn(projectDir.toFile());
        Mockito.when(project.getGroupId()).thenReturn("com.acme");
        Mockito.when(project.getArtifactId()).thenReturn("widgets");
        Mockito.when(project.getVersion()).thenReturn("1.0.0");
        Mockito.when(project.getDependencies()).thenReturn(List.of());
        MetaDataEjectMojo mojo = new MetaDataEjectMojo();
        mojo.project = project;
        mojo.names = names;
        mojo.port = "java";
        return mojo;
    }

    private static List<EjectSupport.Entry> javaEjectable() {
        return EjectSupport.allEntries().stream()
                .filter(e -> e.port == EjectSupport.Port.JAVA && e.resourcePath != null)
                .collect(Collectors.toList());
    }

    // ---------------------------------------------------------------------------------
    // 1. alone
    // ---------------------------------------------------------------------------------

    @Test
    public void everyJavaGeneratorEjectedAloneCompilesWithoutThePackagedSupport() throws Exception {
        List<String> failures = new ArrayList<>();
        List<EjectSupport.Entry> entries = javaEjectable();
        assertFalse("expected the registry to name ejectable Java generators", entries.isEmpty());
        for (EjectSupport.Entry e : entries) {
            Path projectDir = tempFolder.newFolder("alone-" + e.stableName).toPath();
            mojo(projectDir, e.stableName).execute();
            String errors = compileHidingPackagedSupport(
                    projectDir.resolve("codegen/src/main/java"), tempFolder.newFolder().toPath());
            if (!errors.isEmpty()) {
                failures.add(e.stableName + " (" + e.simpleName() + ") does not compile alone:\n" + errors);
            }
        }
        assertTrue(String.join("\n", failures), failures.isEmpty());
    }

    /** The control for every compile in this class: javac really cannot see the packaged
     *  support classes, so a copy that named one would not compile. */
    @Test
    public void aSourceNamingThePackagedSupportDoesNotCompileHere() throws Exception {
        for (String simple : GeneratorRegistry.EJECT_SUPPORT) {
            Path src = tempFolder.newFolder().toPath();
            Path dir = src.resolve("com/acme/probe");
            Files.createDirectories(dir);
            Files.writeString(dir.resolve("Probe.java"), "package com.acme.probe;\n"
                    + "public class Probe { Class<?> c = " + GeneratorRegistry.SUPPORT_PACKAGE + "."
                    + simple + ".class; }\n", StandardCharsets.UTF_8);
            assertEquals("the probe is valid Java when the class is visible",
                    "", compile(src, tempFolder.newFolder().toPath(), false));
            assertFalse(simple + " must be hidden from the compile",
                    compileHidingPackagedSupport(src, tempFolder.newFolder().toPath()).isEmpty());
        }
    }

    // ---------------------------------------------------------------------------------
    // 2. unchanged
    // ---------------------------------------------------------------------------------

    private static final List<String> WEB_TIER =
            List.of("routes", "dto", "repository", "filter-allowlist", "value-object", "names");

    @Test
    public void theOwnedGeneratorsEmitByteForByteWhatThePackagedOnesEmit() throws Exception {
        Path projectDir = tempFolder.newFolder("adopter").toPath();
        mojo(projectDir, String.join(",", WEB_TIER)).execute();

        Path packagedOut = tempFolder.newFolder("packaged-out").toPath();
        for (String stable : WEB_TIER) {
            Generator gen = (Generator) Class.forName(GeneratorRegistry.get(stable).classname())
                    .getDeclaredConstructor().newInstance();
            Map<String, String> a = args(packagedOut);
            // The one deliberate difference: an owned generator's output imports the owned runtime.
            a.put("runtimePackage", "com.acme.runtime");
            gen.setArgs(a).execute(loader);
        }
        Path ownedOut = runOwned(projectDir, WEB_TIER);

        Map<String, String> packaged = tree(packagedOut);
        Map<String, String> owned = tree(ownedOut);
        assertFalse("the generators emitted nothing", packaged.isEmpty());
        assertEquals(packaged.keySet(), owned.keySet());
        for (Map.Entry<String, String> f : packaged.entrySet()) {
            assertEquals(f.getKey(), f.getValue(), owned.get(f.getKey()));
        }
    }

    // ---------------------------------------------------------------------------------
    // 3. owned
    // ---------------------------------------------------------------------------------

    @Test
    public void anEditToTheOwnedSupportChangesWhatTheOwnedGeneratorsEmit() throws Exception {
        Path projectDir = tempFolder.newFolder("adopter-edit").toPath();
        mojo(projectDir, "routes,repository").execute();

        // The fitness corpus declares Post.tags, an M:N relationship: the repository declares
        // its finder and the controller calls it, both by the name this one rule returns.
        Path support = projectDir.resolve("codegen/src/main/java/com/acme/codegen/SpringGeneratorSupport.java");
        String src = Files.readString(support, StandardCharsets.UTF_8);
        String edited = src.replace("return \"find\" + Character.toUpperCase(",
                "return \"lookup\" + Character.toUpperCase(");
        assertFalse("the reference finder-name rule changed shape; update this test's edit", edited.equals(src));
        Files.writeString(support, edited, StandardCharsets.UTF_8);

        Path out = runOwned(projectDir, List.of("routes", "repository"));
        String repository = Files.readString(out.resolve("fitness/PostRepository.java"), StandardCharsets.UTF_8);
        String controller = Files.readString(out.resolve("fitness/PostController.java"), StandardCharsets.UTF_8);
        assertTrue(repository.contains(" lookupTags("));
        assertTrue(controller.contains(".lookupTags("));
        assertFalse(repository.contains("findTags("));
        assertFalse(controller.contains("findTags("));
    }

    /**
     * The docs' own example of an owned rule: which fields a DTO carries. The api-contract
     * corpus declares {@code Author.autoCreatedAt} ({@code @autoSet: onCreate}) and
     * {@code autoUpdatedAt} ({@code onUpdate}), so the reference DTO stamps both and the
     * controller calls the stamp methods. Dropping the {@code @autoSet} columns from the
     * owned rule must remove the components, the stamp methods AND the controller's calls: a
     * stamp method left behind would assign a component the record no longer has.
     */
    @Test
    public void anEditToWhichFieldsADtoCarriesMovesTheStampMethodsAndTheControllerToo() throws Exception {
        MetaDataLoader blog = load(canonical.getParent().getParent()
                .resolve("api-contract-conformance/meta.json"), "eject-alone-autoset");
        List<String> names = List.of("routes", "dto");

        Path reference = tempFolder.newFolder("adopter-reference").toPath();
        mojo(reference, String.join(",", names)).execute();
        Path referenceOut = runOwned(reference, names, blog, "blog");
        String referenceDto = emitted(referenceOut, "AuthorDto.java");
        String referencePatch = emitted(referenceOut, "AuthorPatch.java");
        String referenceController = emitted(referenceOut, "AuthorController.java");
        assertTrue(referenceDto.contains("autoCreatedAt") && referenceDto.contains("stampForInsert("));
        assertTrue(referencePatch.contains("stampAutoSetOnUpdate("));
        assertTrue(referenceController.contains("AuthorDto.stampForInsert(dto)"));
        assertTrue(referenceController.contains("patch.stampAutoSetOnUpdate()"));

        Path projectDir = tempFolder.newFolder("adopter-fields").toPath();
        mojo(projectDir, String.join(",", names)).execute();
        Path support = projectDir.resolve("codegen/src/main/java/com/acme/codegen/SpringGeneratorSupport.java");
        String src = Files.readString(support, StandardCharsets.UTF_8);
        String rule = "    public static List<MetaField> dtoComponentFields(MetaObject entity) {\n"
                + "        List<MetaField> out = new ArrayList<>();\n"
                + "        for (MetaField field : entity.getMetaFields()) {\n";
        String edited = src.replace(rule, rule + "            if (AutoSetSupport.isAutoSet(field)) continue;\n");
        assertFalse("the reference DTO-field rule changed shape; update this test's edit", edited.equals(src));
        Files.writeString(support, edited, StandardCharsets.UTF_8);

        Path out = runOwned(projectDir, names, blog, "blog");
        String dto = emitted(out, "AuthorDto.java");
        String patch = emitted(out, "AuthorPatch.java");
        String controller = emitted(out, "AuthorController.java");
        for (String record : List.of(dto, patch)) {
            assertFalse(record, record.contains("autoCreatedAt"));
            assertFalse(record, record.contains("autoUpdatedAt"));
        }
        for (String emitted : List.of(dto, patch, controller)) {
            assertFalse(emitted, emitted.contains("stampForInsert"));
            assertFalse(emitted, emitted.contains("stampAutoSetOnUpdate"));
        }
        // The rest of the record is untouched: the edit removed two columns, not the DTO.
        assertTrue(dto.contains("issuedCurrency"));
    }

    /** Ejecting a second generator later shares the one support copy, edits and all. */
    @Test
    public void reEjectingKeepsAnEditedSupportCopyUnlessForced() throws Exception {
        Path projectDir = tempFolder.newFolder("adopter-reeject").toPath();
        mojo(projectDir, "dto").execute();
        Path support = projectDir.resolve("codegen/src/main/java/com/acme/codegen/SpringGeneratorSupport.java");
        String reference = Files.readString(support, StandardCharsets.UTF_8);
        String mine = reference + "\n// mine\n";
        Files.writeString(support, mine, StandardCharsets.UTF_8);

        mojo(projectDir, "routes").execute();
        assertEquals(mine, Files.readString(support, StandardCharsets.UTF_8));

        MetaDataEjectMojo forced = mojo(projectDir, "routes");
        forced.force = true;
        forced.execute();
        assertEquals(reference, Files.readString(support, StandardCharsets.UTF_8));
    }

    // ---------------------------------------------------------------------------------
    // helpers
    // ---------------------------------------------------------------------------------

    /** Compile the owned generators under codegen/ and run the named ones into a fresh dir. */
    private Path runOwned(Path projectDir, List<String> stableNames) throws Exception {
        return runOwned(projectDir, stableNames, loader, "fitness");
    }

    private Path runOwned(Path projectDir, List<String> stableNames, MetaDataLoader model,
                          String packageName) throws Exception {
        Path classes = tempFolder.newFolder().toPath();
        assertEquals("", compileHidingPackagedSupport(projectDir.resolve("codegen/src/main/java"), classes));
        Path out = tempFolder.newFolder().toPath();
        try (URLClassLoader cl = new URLClassLoader(new URL[]{classes.toUri().toURL()},
                getClass().getClassLoader())) {
            for (String stable : stableNames) {
                String simple = GeneratorRegistry.get(stable).classname();
                simple = simple.substring(simple.lastIndexOf('.') + 1);
                Generator gen = (Generator) Class.forName("com.acme.codegen." + simple, true, cl)
                        .getDeclaredConstructor().newInstance();
                gen.setArgs(args(out, packageName)).execute(model);
            }
        }
        return out;
    }

    /** The one generated file named {@code fileName} under {@code root}. */
    private static String emitted(Path root, String fileName) throws IOException {
        try (Stream<Path> s = Files.walk(root)) {
            List<Path> found = s.filter(p -> p.getFileName().toString().equals(fileName))
                    .collect(Collectors.toList());
            assertEquals("expected exactly one " + fileName + " under " + root, 1, found.size());
            return Files.readString(found.get(0), StandardCharsets.UTF_8);
        }
    }

    /** Every file under {@code root}, by relative path. */
    private static Map<String, String> tree(Path root) throws IOException {
        Map<String, String> out = new TreeMap<>();
        try (Stream<Path> s = Files.walk(root)) {
            for (Path p : s.filter(Files::isRegularFile).collect(Collectors.toList())) {
                out.put(root.relativize(p).toString(), Files.readString(p, StandardCharsets.UTF_8));
            }
        }
        return out;
    }

    private static String compileHidingPackagedSupport(Path sourceRoot, Path out) throws IOException {
        return compile(sourceRoot, out, true);
    }

    /** Compile every source under {@code sourceRoot} against the test classpath; return the
     *  errors, or "". With {@code hideSupport}, javac is not shown the packaged support classes. */
    private static String compile(Path sourceRoot, Path out, boolean hideSupport) throws IOException {
        List<File> files = new ArrayList<>();
        try (Stream<Path> s = Files.walk(sourceRoot)) {
            s.filter(p -> p.toString().endsWith(".java")).forEach(p -> files.add(p.toFile()));
        }
        assertFalse("nothing to compile under " + sourceRoot, files.isEmpty());
        Set<String> hidden = GeneratorRegistry.EJECT_SUPPORT.stream()
                .map(n -> GeneratorRegistry.SUPPORT_PACKAGE + "." + n).collect(Collectors.toSet());
        JavaCompiler javac = ToolProvider.getSystemJavaCompiler();
        DiagnosticCollector<JavaFileObject> diagnostics = new DiagnosticCollector<>();
        try (StandardJavaFileManager std = javac.getStandardFileManager(diagnostics, null, StandardCharsets.UTF_8)) {
            std.setLocation(StandardLocation.CLASS_OUTPUT, List.of(out.toFile()));
            JavaFileManager fm = !hideSupport ? std : new ForwardingJavaFileManager<>(std) {
                @Override
                public Iterable<JavaFileObject> list(Location location, String packageName,
                                                     Set<JavaFileObject.Kind> kinds, boolean recurse)
                        throws IOException {
                    List<JavaFileObject> kept = new ArrayList<>();
                    for (JavaFileObject f : super.list(location, packageName, kinds, recurse)) {
                        String binary = f.getKind() == JavaFileObject.Kind.CLASS
                                ? std.inferBinaryName(location, f) : null;
                        String outer = binary == null ? null : binary.split("\\$", 2)[0];
                        if (!hidden.contains(outer)) kept.add(f);
                    }
                    return kept;
                }
            };
            List<String> options = List.of("-proc:none", "-classpath", System.getProperty("java.class.path"));
            javac.getTask(null, fm, diagnostics, options, null, std.getJavaFileObjectsFromFiles(files)).call();
        }
        StringBuilder errors = new StringBuilder();
        for (Diagnostic<? extends JavaFileObject> d : diagnostics.getDiagnostics()) {
            if (d.getKind() == Diagnostic.Kind.ERROR) errors.append("  ").append(d).append('\n');
        }
        return errors.toString();
    }
}

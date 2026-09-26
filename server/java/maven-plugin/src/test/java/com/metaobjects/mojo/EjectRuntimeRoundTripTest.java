package com.metaobjects.mojo;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.metaobjects.generator.Generator;
import com.metaobjects.generator.GeneratorRegistry;
import com.metaobjects.generator.kotlin.GeneratorInfo;
import com.metaobjects.generator.kotlin.GeneratorRegistryKt;
import com.metaobjects.loader.LoaderOptions;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.loader.uri.URIHelper;
import org.apache.maven.plugin.MojoFailureException;
import org.apache.maven.project.MavenProject;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
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
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
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
import java.util.TreeSet;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;
import java.util.stream.Stream;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

/**
 * An ejected generator's output must depend on code the adopter OWNS (ADR-0034 Amendment 3):
 * {@code mvn metaobjects:eject} hands over the helper runtime the output imports, and the
 * owned output imports that copy, not {@code com.metaobjects.generator.spring.runtime}.
 *
 * <p>Three kinds of proof, all executing real code:
 * <ol>
 *   <li><b>The declared runtime sets are exact.</b> Every ejectable generator in both ports is
 *       run against the shared fitness corpus; the helper classes its output imports must be
 *       precisely what its registry entry declares (so eject copies neither too little nor
 *       too much), each set must compile on the JDK alone (closed, no MetaObjects on the
 *       classpath), and no Kotlin output imports helper runtime at all.</li>
 *   <li><b>The round trip.</b> Eject the whole Spring web tier into a temp project, compile
 *       and run the owned generators, and compile their output together with the owned
 *       runtime on a classpath holding NO MetaObjects artifact.</li>
 *   <li><b>Ownership is real.</b> An edit to the owned runtime copy changes what the
 *       generated code does at run time.</li>
 * </ol>
 * Plus the drift gate: an owned runtime file sitting in a generator's output directory is not
 * reported as stale output.
 */
public class EjectRuntimeRoundTripTest {

    @Rule
    public TemporaryFolder tempFolder = new TemporaryFolder();

    private static final String REFERENCE_RUNTIME = GeneratorRegistry.RUNTIME_PACKAGE;
    private static final Pattern IMPORT = Pattern.compile("(?m)^import\\s+([\\w.]+)\\s*;?\\s*$");

    private Path canonical;
    private MetaDataLoader loader;

    @Before
    public void setUp() {
        canonical = findCanonical();
        URI uri = URIHelper.toURI("model:file:"
                + canonical.resolve("meta.fitness.json").toAbsolutePath().toString().replace('\\', '/'));
        loader = new MetaDataLoader(LoaderOptions.create(false, false, true),
                MetaDataLoader.SUBTYPE_MANUAL, "eject-runtime-test");
        loader.setSourceURIs(List.of(uri));
        loader.init();
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
        Map<String, String> a = new LinkedHashMap<>();
        a.put("outputDir", outDir.toString());
        a.put("packageName", "fitness");
        a.put("templateRoot", canonical.resolve("prompts").toString());
        return a;
    }

    // ---------------------------------------------------------------------------------
    // 1. the declared sets are exact
    // ---------------------------------------------------------------------------------

    /** Every {@code import} line in every file under {@code dir}. */
    private static Set<String> imports(Path dir) throws IOException {
        Set<String> out = new TreeSet<>();
        if (!Files.isDirectory(dir)) return out;
        try (Stream<Path> s = Files.walk(dir)) {
            for (Path p : s.filter(Files::isRegularFile).collect(Collectors.toList())) {
                Matcher m = IMPORT.matcher(Files.readString(p, StandardCharsets.UTF_8));
                while (m.find()) out.add(m.group(1));
            }
        }
        return out;
    }

    @Test
    public void eachJavaGeneratorsOutputImportsExactlyTheRuntimeItsEntryDeclares() throws Exception {
        String probe = "probe.owned.runtime";
        int withRuntime = 0;
        for (EjectSupport.Entry e : EjectSupport.allEntries()) {
            if (e.port != EjectSupport.Port.JAVA || e.resourcePath == null) continue;
            Path out = tempFolder.newFolder("declared-" + e.stableName).toPath();
            Generator gen = (Generator) Class.forName(e.classname).getDeclaredConstructor().newInstance();
            Map<String, String> a = args(out);
            a.put("runtimePackage", probe);
            gen.setArgs(a).execute(loader);

            Set<String> all = imports(out);
            for (String imp : all) {
                assertFalse(e.stableName + " output still imports the reference runtime: " + imp,
                        imp.startsWith(REFERENCE_RUNTIME + "."));
                assertFalse(e.stableName + " output imports a codegen (helper) class eject does not hand over: " + imp,
                        imp.startsWith("com.metaobjects.generator."));
            }
            Set<String> used = all.stream().filter(i -> i.startsWith(probe + "."))
                    .map(i -> i.substring(probe.length() + 1)).collect(Collectors.toCollection(TreeSet::new));
            Set<String> declared = new TreeSet<>(e.runtime);
            // Imports alone under-count a closure (FilterParser uses FilterParseResult without
            // importing it — same package), so compare the CLOSURE of what is imported.
            assertEquals(e.stableName + ": the runtime eject copies must be exactly what the output needs",
                    declared, closure(used));
            if (!declared.isEmpty()) withRuntime++;
        }
        assertEquals("routes, dto and repository carry runtime", 3, withRuntime);
    }

    /** {@code names} plus every runtime class their sources mention by simple name. */
    private Set<String> closure(Set<String> names) throws IOException {
        Set<String> out = new TreeSet<>(names);
        Set<String> all = new TreeSet<>();
        for (EjectSupport.Entry e : EjectSupport.allEntries()) all.addAll(e.runtime);
        boolean grew = true;
        while (grew) {
            grew = false;
            for (String n : new ArrayList<>(out)) {
                // Code only: a class named in a comment is not a dependency.
                String src = readRuntimeResource(n)
                        .replaceAll("(?s)/\\*.*?\\*/", "")
                        .replaceAll("(?m)//.*$", "");
                for (String other : all) {
                    if (!out.contains(other) && Pattern.compile("\\b" + other + "\\b").matcher(src).find()) {
                        out.add(other);
                        grew = true;
                    }
                }
            }
        }
        return out;
    }

    private static String readRuntimeResource(String simpleName) throws IOException {
        String path = GeneratorRegistry.EJECT_RUNTIME_RESOURCE_ROOT + simpleName + ".java";
        try (var in = EjectRuntimeRoundTripTest.class.getClassLoader().getResourceAsStream(path)) {
            assertNotNull("runtime source not shipped: " + path, in);
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        }
    }

    @Test
    public void eachDeclaredRuntimeSetCompilesOnTheJdkAlone() throws Exception {
        for (EjectSupport.Entry e : EjectSupport.allEntries()) {
            if (e.runtime.isEmpty()) continue;
            Path dir = tempFolder.newFolder("closed-" + e.stableName).toPath().resolve("acme/rt");
            Files.createDirectories(dir);
            for (String n : e.runtime) {
                Files.writeString(dir.resolve(n + ".java"),
                        EjectSupport.ownedRuntimeSource(readRuntimeResource(n), n, "acme.rt"),
                        StandardCharsets.UTF_8);
            }
            compile(List.of(dir), "", tempFolder.newFolder("closed-classes-" + e.stableName).toPath());
        }
    }

    @Test
    public void noKotlinGeneratorsOutputImportsHelperRuntime() throws Exception {
        int ran = 0;
        for (Map.Entry<String, GeneratorInfo> entry : GeneratorRegistryKt.getGENERATOR_REGISTRY().entrySet()) {
            Path out = tempFolder.newFolder("kt-" + entry.getKey()).toPath();
            Generator gen = entry.getValue().getFactory().invoke();
            gen.setArgs(args(out)).execute(loader);
            for (String imp : imports(out)) {
                assertFalse("Kotlin " + entry.getKey() + " output imports helper code eject would have to "
                        + "hand over: " + imp, imp.startsWith("com.metaobjects.generator."));
            }
            ran++;
        }
        assertTrue(ran >= 14);
        for (EjectSupport.Entry e : EjectSupport.allEntries()) {
            if (e.port == EjectSupport.Port.KOTLIN) assertTrue(e.stableName, e.runtime.isEmpty());
        }
    }

    // ---------------------------------------------------------------------------------
    // 2 + 3. the round trip, and an owned edit taking effect
    // ---------------------------------------------------------------------------------

    private static final List<String> WEB_TIER =
            List.of("routes", "dto", "repository", "filter-allowlist", "value-object", "names");

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

    @Test
    public void ejectHandsOverTheRuntimeAndTheOwnedOutputUsesIt() throws Exception {
        Path projectDir = tempFolder.newFolder("adopter").toPath();
        mojo(projectDir, String.join(",", WEB_TIER)).execute();

        // The runtime landed where the generated code compiles, package-renamed and marked.
        Path runtimeDir = projectDir.resolve("src/main/java/com/acme/runtime");
        Set<String> expected = new TreeSet<>(GeneratorRegistry.get("routes").ejectRuntime());
        Set<String> written;
        try (Stream<Path> s = Files.list(runtimeDir)) {
            written = s.map(p -> p.getFileName().toString().replace(".java", ""))
                    .collect(Collectors.toCollection(TreeSet::new));
        }
        assertEquals(expected, written);
        for (String n : written) {
            String src = Files.readString(runtimeDir.resolve(n + ".java"), StandardCharsets.UTF_8);
            assertTrue(n, EjectSupport.isOwnedRuntime(src));
            assertTrue(n, src.contains("\npackage com.acme.runtime;"));
            assertFalse(n, src.contains("package " + REFERENCE_RUNTIME));
        }

        // The owned generators compile and run; their output imports the owned runtime.
        Path genDir = runOwnedGenerators(projectDir);
        Set<String> imps = imports(genDir);
        assertTrue(imps.contains("com.acme.runtime.FilterParser"));
        assertTrue(imps.contains("com.acme.runtime.PatchValidationException"));
        assertTrue(imps.contains("com.acme.runtime.ConstraintErrors"));
        try (Stream<Path> s = Files.walk(genDir)) {
            for (Path p : s.filter(Files::isRegularFile).collect(Collectors.toList())) {
                assertFalse(p + " still names the reference runtime",
                        Files.readString(p, StandardCharsets.UTF_8).contains(REFERENCE_RUNTIME));
            }
        }

        // The owned output + owned runtime compile with NO MetaObjects artifact on the classpath.
        compile(List.of(genDir, projectDir.resolve("src/main/java")), withoutMetaObjects(),
                tempFolder.newFolder("app-classes").toPath());
    }

    @Test
    public void anEditToTheOwnedRuntimeChangesWhatGeneratedCodeDoes() throws Exception {
        Path projectDir = tempFolder.newFolder("adopter-edit").toPath();
        mojo(projectDir, String.join(",", WEB_TIER)).execute();

        Path owned = projectDir.resolve("src/main/java/com/acme/runtime/PatchValidationException.java");
        String src = Files.readString(owned, StandardCharsets.UTF_8);
        String edited = src.replace("super(\"field '\" + field + \"' cannot be null\");",
                "super(\"OWNED EDIT: \" + field + \" is required\");");
        assertFalse("the reference constructor changed shape; update this test's edit", edited.equals(src));
        Files.writeString(owned, edited, StandardCharsets.UTF_8);

        Path genDir = runOwnedGenerators(projectDir);
        Path classes = tempFolder.newFolder("edit-classes").toPath();
        compile(List.of(genDir, projectDir.resolve("src/main/java")), withoutMetaObjects(), classes);

        try (URLClassLoader cl = new URLClassLoader(new URL[]{classes.toUri().toURL()},
                getClass().getClassLoader())) {
            Class<?> patch = Class.forName("fitness.ProgramPatch", true, cl);
            Method fromJson = patch.getMethod("fromJson",
                    com.fasterxml.jackson.databind.JsonNode.class, ObjectMapper.class);
            ObjectMapper mapper = new ObjectMapper();
            try {
                fromJson.invoke(null, mapper.readTree("{\"title\": null}"), mapper);
                fail("an explicit null on a @required field must be rejected");
            } catch (InvocationTargetException ex) {
                Throwable cause = ex.getCause();
                assertEquals("com.acme.runtime.PatchValidationException", cause.getClass().getName());
                assertEquals("OWNED EDIT: title is required", cause.getMessage());
            }
        }
    }

    @Test
    public void reEjectingKeepsAnEditedRuntimeCopy() throws Exception {
        Path projectDir = tempFolder.newFolder("adopter-reeject").toPath();
        mojo(projectDir, "dto").execute();
        Path owned = projectDir.resolve("src/main/java/com/acme/runtime/PatchValidationException.java");
        Files.writeString(owned, Files.readString(owned, StandardCharsets.UTF_8) + "\n// mine\n",
                StandardCharsets.UTF_8);
        String before = Files.readString(owned, StandardCharsets.UTF_8);

        // Ejecting another generator that needs the same class must not clobber the edit.
        MetaDataEjectMojo again = mojo(projectDir, "routes");
        again.execute();
        assertEquals(before, Files.readString(owned, StandardCharsets.UTF_8));
    }

    @Test
    public void aGeneratorWithNoRuntimeCopiesNone() throws Exception {
        Path projectDir = tempFolder.newFolder("adopter-names").toPath();
        mojo(projectDir, "names").execute();
        assertFalse(Files.exists(projectDir.resolve("src/main/java")));
    }

    @Test
    public void anAggregatorWithNoObviousAppModuleEjectsNothing() throws Exception {
        Path projectDir = tempFolder.newFolder("aggregator").toPath();
        MetaDataEjectMojo m = mojo(projectDir, "dto");
        Mockito.when(m.project.getPackaging()).thenReturn("pom");
        Mockito.when(m.project.getModules()).thenReturn(List.of());
        try {
            m.execute();
            fail("expected the aggregator to be refused without -DruntimeDir");
        } catch (MojoFailureException expected) {
            assertTrue(expected.getMessage().contains("-DruntimeDir"));
        }
        assertFalse(Files.exists(projectDir.resolve("codegen")));

        // One child configures the plugin: the runtime goes there.
        Path app = projectDir.resolve("app");
        Files.createDirectories(app);
        Files.writeString(app.resolve("pom.xml"), "<project><build><plugins><plugin>"
                + "<artifactId>metaobjects-maven-plugin</artifactId></plugin></plugins></build></project>");
        Mockito.when(m.project.getModules()).thenReturn(List.of("app"));
        m.execute();
        assertTrue(Files.exists(app.resolve("src/main/java/com/acme/runtime/PatchValidationException.java")));
    }

    /** Compile the owned generators under codegen/ and run them into a fresh dir. */
    private Path runOwnedGenerators(Path projectDir) throws Exception {
        Path ownedSrc = projectDir.resolve("codegen/src/main/java");
        Path classes = tempFolder.newFolder().toPath();
        compile(List.of(ownedSrc), System.getProperty("java.class.path"), classes);
        Path genDir = tempFolder.newFolder().toPath();
        try (URLClassLoader cl = new URLClassLoader(new URL[]{classes.toUri().toURL()},
                getClass().getClassLoader())) {
            for (String stable : WEB_TIER) {
                String simple = EjectSupport.ejectableByStableName().get(stable).stream()
                        .filter(e -> e.port == EjectSupport.Port.JAVA).findFirst().orElseThrow().simpleName();
                Generator gen = (Generator) Class.forName("com.acme.codegen." + simple, true, cl)
                        .getDeclaredConstructor().newInstance();
                gen.setArgs(args(genDir)).execute(loader);
            }
        }
        return genDir;
    }

    /** The test classpath with every MetaObjects artifact removed (reactor module output or
     *  a {@code com/metaobjects} jar). */
    private static String withoutMetaObjects() {
        return Stream.of(System.getProperty("java.class.path").split(File.pathSeparator))
                .filter(e -> {
                    String n = e.replace('\\', '/');
                    return !n.contains("/com/metaobjects/") && !n.contains("/server/java/");
                })
                .collect(Collectors.joining(File.pathSeparator));
    }

    private static void compile(List<Path> sourceRoots, String classpath, Path out) throws IOException {
        List<File> files = new ArrayList<>();
        for (Path root : sourceRoots) {
            try (Stream<Path> s = Files.walk(root)) {
                s.filter(p -> p.toString().endsWith(".java")).forEach(p -> files.add(p.toFile()));
            }
        }
        assertFalse("nothing to compile under " + sourceRoots, files.isEmpty());
        JavaCompiler javac = ToolProvider.getSystemJavaCompiler();
        DiagnosticCollector<JavaFileObject> diagnostics = new DiagnosticCollector<>();
        try (StandardJavaFileManager fm = javac.getStandardFileManager(diagnostics, null, StandardCharsets.UTF_8)) {
            fm.setLocation(StandardLocation.CLASS_OUTPUT, List.of(out.toFile()));
            List<String> options = new ArrayList<>(List.of("-proc:none", "-classpath", classpath));
            boolean ok = javac.getTask(null, fm, diagnostics, options, null,
                    fm.getJavaFileObjectsFromFiles(files)).call();
            if (!ok) {
                StringBuilder errs = new StringBuilder();
                for (Diagnostic<? extends JavaFileObject> d : diagnostics.getDiagnostics()) {
                    if (d.getKind() == Diagnostic.Kind.ERROR) errs.append(d).append('\n');
                }
                throw new AssertionError("compile failed:\n" + errs);
            }
        }
    }
}

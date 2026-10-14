package com.metaobjects.mojo;

import com.metaobjects.generator.Generator;
import com.metaobjects.loader.InMemoryStringSource;
import com.metaobjects.loader.LoaderOptions;
import com.metaobjects.loader.MetaDataLoader;
import com.tschuchort.compiletesting.KotlinCompilation;
import com.tschuchort.compiletesting.SourceFile;
import org.apache.maven.model.Dependency;
import org.apache.maven.model.Model;
import org.apache.maven.model.Plugin;
import org.apache.maven.model.io.xpp3.MavenXpp3Reader;
import org.apache.maven.plugin.logging.Log;
import org.apache.maven.project.MavenProject;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.codehaus.plexus.util.xml.Xpp3Dom;
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
import java.io.OutputStream;
import java.io.Reader;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
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
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

/**
 * A project that documents both languages (an {@code api-docs} {@code <generator>} entry for each)
 * can own both generators in ONE {@code codegen/} module. The two ports name
 * their page model and path classes alike ({@code ApiUnit}, {@code ApiSymbol}, {@code FieldShape},
 * {@code ApiSymbolKind}, {@code DocsPaths}), so the copies have to land where no class is declared
 * twice.
 *
 * <p>Runs the real mojo once per port into one project, then compiles what it wrote with each
 * language's own compiler. The classname eject prints for each port has to load, from that
 * compile, as a generator that writes that language's pages.</p>
 */
public class ApiDocsEjectBothPortsTest {

    @Rule
    public TemporaryFolder tempFolder = new TemporaryFolder();

    private Path basedir;
    private MavenProject project;

    @Before
    public void setUp() throws IOException {
        basedir = tempFolder.newFolder("adopter-app").toPath();
        project = Mockito.mock(MavenProject.class);
        Mockito.when(project.getBasedir()).thenReturn(basedir.toFile());
        Mockito.when(project.getGroupId()).thenReturn("com.acme");
        Mockito.when(project.getArtifactId()).thenReturn("widgets");
        Mockito.when(project.getVersion()).thenReturn("1.0.0");
        Mockito.when(project.getDependencies()).thenReturn(List.of());
    }

    private static final Pattern CLASSNAME_CHANGE = Pattern.compile("^\\s*api-docs: \\S+\\s+->\\s+(\\S+)$");

    /** Eject {@code api-docs} for one port, and return the log eject wrote to. */
    private Log eject(String port) throws Exception {
        return eject("api-docs", port, false);
    }

    private Log eject(String names, String port, boolean force) throws Exception {
        MetaDataEjectMojo mojo = new MetaDataEjectMojo();
        mojo.project = project;
        mojo.names = names;
        mojo.port = port;
        mojo.force = force;
        Log log = Mockito.mock(Log.class);
        mojo.setLog(log);
        mojo.execute();
        return log;
    }

    private Model codegenPom() throws Exception {
        try (Reader in = Files.newBufferedReader(basedir.resolve("codegen/pom.xml"), StandardCharsets.UTF_8)) {
            return new MavenXpp3Reader().read(in);
        }
    }

    /**
     * The pom builds both ports' copies: it depends on both codegen artifacts, leaves Maven's
     * source root at its default ({@code src/main/java}, which javac compiles), and gives the
     * Kotlin plugin {@code src/main/kotlin} itself. Read through Maven's own model reader.
     *
     * <p>The module is not built by Maven here: its dependencies are this reactor's artifacts,
     * which no repository holds while these tests run. Both source trees are compiled, by each
     * language's compiler, in {@link #bothPortsEjectedIntoOneModuleCompileAndDeclareNoClassTwice}.</p>
     */
    private void assertPomBuildsBothPorts() throws Exception {
        Model pom = codegenPom();
        Set<String> dependencies = pom.getDependencies().stream()
                .map(Dependency::getArtifactId).collect(Collectors.toCollection(TreeSet::new));
        assertEquals(Set.of("metaobjects-codegen-kotlin", "metaobjects-codegen-spring"), dependencies);
        assertNull("a source root set here replaces Maven's default, src/main/java",
                pom.getBuild().getSourceDirectory());
        Plugin kotlin = pom.getBuild().getPlugins().stream()
                .filter(p -> p.getArtifactId().equals("kotlin-maven-plugin")).findFirst().orElseThrow();
        Xpp3Dom sourceDirs = ((Xpp3Dom) kotlin.getConfiguration()).getChild("sourceDirs");
        assertEquals(1, sourceDirs.getChildCount());
        assertEquals("${project.basedir}/src/main/kotlin", sourceDirs.getChild(0).getValue());
    }

    /** Eject {@code api-docs} for one port, and return the owned classname eject printed for it. */
    private String ejectApiDocs(String port) throws Exception {
        ArgumentCaptor<CharSequence> captor = ArgumentCaptor.forClass(CharSequence.class);
        Mockito.verify(eject(port), Mockito.atLeastOnce()).info(captor.capture());
        List<String> printed = new ArrayList<>();
        for (CharSequence line : captor.getAllValues()) {
            Matcher m = CLASSNAME_CHANGE.matcher(line);
            if (m.matches()) printed.add(m.group(1));
        }
        assertEquals(port + ": eject prints one <classname> change for api-docs", 1, printed.size());
        // The wiring note names the same class for the <generator> entry to add.
        String owned = printed.get(0);
        assertTrue(port + ": no wiring note names " + owned, captor.getAllValues().stream()
                .anyMatch(line -> line.toString().contains("<classname>" + owned + "</classname>")));
        return owned;
    }

    /** Everything eject warned about, one printed line per element. */
    private static List<String> warnings(Log log) {
        ArgumentCaptor<CharSequence> captor = ArgumentCaptor.forClass(CharSequence.class);
        Mockito.verify(log, Mockito.atLeast(0)).warn(captor.capture());
        return captor.getAllValues().stream().map(line -> line.toString().strip()).collect(Collectors.toList());
    }

    private static List<File> sourcesUnder(Path root, String extension) throws IOException {
        try (Stream<Path> s = Files.walk(root)) {
            return s.filter(p -> p.toString().endsWith(extension)).map(Path::toFile).collect(Collectors.toList());
        }
    }

    /** Every class file under {@code classes}, as a path relative to it: one per declared class. */
    private static Set<String> declared(Path classes) throws IOException {
        try (Stream<Path> s = Files.walk(classes)) {
            return s.filter(p -> p.toString().endsWith(".class"))
                    .map(p -> classes.relativize(p).toString().replace(File.separatorChar, '/'))
                    .collect(Collectors.toCollection(TreeSet::new));
        }
    }

    private Path compileJava(Path sourceRoot) throws IOException {
        List<File> sources = sourcesUnder(sourceRoot, ".java");
        assertFalse("eject wrote no Java source", sources.isEmpty());
        Path classes = tempFolder.newFolder("java-classes").toPath();
        JavaCompiler javac = ToolProvider.getSystemJavaCompiler();
        DiagnosticCollector<JavaFileObject> diagnostics = new DiagnosticCollector<>();
        try (StandardJavaFileManager fm = javac.getStandardFileManager(diagnostics, null, StandardCharsets.UTF_8)) {
            fm.setLocation(StandardLocation.CLASS_OUTPUT, List.of(classes.toFile()));
            javac.getTask(null, fm, diagnostics,
                    List.of("-proc:none", "-classpath", System.getProperty("java.class.path")),
                    null, fm.getJavaFileObjectsFromFiles(sources)).call();
        }
        String errors = diagnostics.getDiagnostics().stream()
                .filter(d -> d.getKind() == Diagnostic.Kind.ERROR).map(d -> "  " + d).collect(Collectors.joining("\n"));
        assertEquals("the Java api-docs copy does not compile", "", errors);
        return classes;
    }

    private KotlinCompilation.Result compileKotlin(Path sourceRoot) throws IOException {
        List<SourceFile> sources = new ArrayList<>();
        for (File file : sourcesUnder(sourceRoot, ".kt")) sources.add(SourceFile.Companion.fromPath(file, false));
        assertFalse("eject wrote no Kotlin source", sources.isEmpty());
        KotlinCompilation compilation = new KotlinCompilation();
        compilation.setSources(sources);
        compilation.setInheritClassPath(true);
        compilation.setMessageOutputStream(OutputStream.nullOutputStream());
        KotlinCompilation.Result result = compilation.compile();
        assertEquals("the Kotlin api-docs copy does not compile:\n" + result.getMessages(),
                KotlinCompilation.ExitCode.OK, result.getExitCode());
        return result;
    }

    private static final String MODEL = "{ \"metadata.root\": { \"package\": \"acme::shop\", \"children\": ["
            + " { \"object.value\": { \"name\": \"Money\", \"children\": ["
            + " { \"field.string\": { \"name\": \"code\" } } ]}} ]}}";

    /** Run the owned generator the way a {@code <generator>} entry does, and require the pages of
     *  {@code language} and nothing outside them. */
    private void assertWritesTheApiReferenceOf(String language, String classname, ClassLoader loader)
            throws Exception {
        Generator generator = (Generator) Class.forName(classname, true, loader)
                .getDeclaredConstructor().newInstance();
        MetaDataLoader model = new MetaDataLoader(
                LoaderOptions.create(false, false, true), MetaDataLoader.SUBTYPE_MANUAL, "owned-api-docs-" + language);
        model.init();
        model.load(List.of(new InMemoryStringSource(MODEL, "owned-api-docs/meta.json")));
        Path out = tempFolder.newFolder("docs-" + language).toPath();
        generator.setArgs(Map.of("outputDir", out.toString()));
        generator.execute(model);

        Set<String> written = new TreeSet<>();
        try (Stream<Path> s = Files.walk(out)) {
            s.filter(Files::isRegularFile).forEach(p -> written.add(out.relativize(p).toString()
                    .replace(File.separatorChar, '/')));
        }
        assertEquals(classname, Set.of("api/" + language + "/AGENT-API.md", "api/" + language + "/Money.md",
                "api/" + language + "/README.md"), written);
    }

    // The pom eject writes builds every port the module holds then. It is never edited afterwards,
    // so a port ejected later is left out of the build unless eject says what the pom has to gain. What each
    // port needs is fixed by Maven and by where eject writes: its codegen artifact, a compiler for
    // its language, and its directory as a source root.

    @Test
    public void aPomWrittenForThePortBeingEjectedDrawsNoWarning() throws Exception {
        assertEquals(List.of(), warnings(eject("java")));
        assertEquals("the same port again, into the pom written for it", List.of(), warnings(eject("java")));
    }

    @Test
    public void oneCallThatNamesBothPortsWritesAPomThatBuildsBothAndWarnsOfNothing() throws Exception {
        // A Java-only name beside a Kotlin-only one: no -Dport, and one call holds both ports.
        Log log = eject("html-docs,exposed-table", null, false);

        assertFalse(sourcesUnder(basedir.resolve("codegen/src/main/java"), ".java").isEmpty());
        assertFalse(sourcesUnder(basedir.resolve("codegen/src/main/kotlin"), ".kt").isEmpty());
        assertPomBuildsBothPorts();
        assertEquals(List.of(), warnings(log));
    }

    @Test
    public void aForcedEjectRewritesThePomForEveryPortTheModuleHolds() throws Exception {
        eject("java");
        eject("kotlin");

        Log log = eject("api-docs", "kotlin", true);

        assertPomBuildsBothPorts();
        assertEquals(List.of(), warnings(log));
    }

    @Test
    public void kotlinEjectedIntoAJavaModulePrintsTheDependencyAndTheCompilerItsPomLacks() throws Exception {
        eject("java");
        Path pom = basedir.resolve("codegen/pom.xml");
        String before = Files.readString(pom, StandardCharsets.UTF_8);

        List<String> warned = warnings(eject("kotlin"));

        assertEquals("eject never edits an existing pom", before, Files.readString(pom, StandardCharsets.UTF_8));
        assertTrue(warned.toString(), warned.contains("<artifactId>metaobjects-codegen-kotlin</artifactId>"));
        assertTrue(warned.toString(), warned.contains("<artifactId>kotlin-maven-plugin</artifactId>"));
        // The plugin is given the Kotlin root itself: the pom's own source root stays Java's.
        assertTrue(warned.toString(), warned.contains("<sourceDir>${project.basedir}/src/main/kotlin</sourceDir>"));
        assertTrue(warned.toString(), warned.contains("<kotlin.compiler.jvmTarget>21</kotlin.compiler.jvmTarget>"));
        // The Java port's needs are met by the pom written for it.
        assertFalse(warned.toString(), warned.contains("<artifactId>metaobjects-codegen-spring</artifactId>"));
        assertFalse(warned.toString(), warned.stream().anyMatch(line -> line.contains("<sourceDirectory>")));
    }

    @Test
    public void javaEjectedIntoAKotlinModulePrintsTheDependencyAndTheSourceRootItsPomLacks() throws Exception {
        eject("kotlin");
        Path pom = basedir.resolve("codegen/pom.xml");
        String before = Files.readString(pom, StandardCharsets.UTF_8);

        List<String> warned = warnings(eject("java"));

        assertEquals("eject never edits an existing pom", before, Files.readString(pom, StandardCharsets.UTF_8));
        assertTrue(warned.toString(), warned.contains("<artifactId>metaobjects-codegen-spring</artifactId>"));
        // The Kotlin pom's source root is src/main/kotlin, which leaves src/main/java uncompiled.
        assertTrue(warned.toString(), warned.stream().anyMatch(line ->
                line.startsWith("Remove <sourceDirectory>src/main/kotlin</sourceDirectory>")
                        && line.contains("src/main/java")));
        assertTrue(warned.toString(), warned.contains("<sourceDir>${project.basedir}/src/main/kotlin</sourceDir>"));
        // The Kotlin port's needs are met by the pom written for it.
        assertFalse(warned.toString(), warned.contains("<artifactId>metaobjects-codegen-kotlin</artifactId>"));
        assertFalse(warned.toString(), warned.contains("<artifactId>kotlin-maven-plugin</artifactId>"));
    }

    @Test
    public void bothPortsEjectedIntoOneModuleCompileAndDeclareNoClassTwice() throws Exception {
        String ownedJava = ejectApiDocs("java");
        String ownedKotlin = ejectApiDocs("kotlin");

        Path codegen = basedir.resolve("codegen");
        Path javaClasses = compileJava(codegen.resolve("src/main/java"));
        KotlinCompilation.Result kotlin = compileKotlin(codegen.resolve("src/main/kotlin"));

        // One module has one class output: a class both languages declare is a build failure.
        Set<String> twice = declared(javaClasses);
        twice.retainAll(declared(kotlin.getOutputDirectory().toPath()));
        assertEquals("classes the Java and the Kotlin api-docs copies both declare", Set.of(), twice);

        URL[] javaUrls = {javaClasses.toUri().toURL(), codegen.resolve("src/main/resources/").toUri().toURL()};
        try (URLClassLoader java = new URLClassLoader(javaUrls, getClass().getClassLoader())) {
            assertWritesTheApiReferenceOf("java", ownedJava, java);
        }
        assertWritesTheApiReferenceOf("kotlin", ownedKotlin, kotlin.getClassLoader());
    }
}

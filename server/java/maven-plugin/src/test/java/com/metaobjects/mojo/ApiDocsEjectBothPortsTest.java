package com.metaobjects.mojo;

import com.metaobjects.generator.DocsGenerator;
import com.tschuchort.compiletesting.KotlinCompilation;
import com.tschuchort.compiletesting.SourceFile;
import org.apache.maven.plugin.logging.Log;
import org.apache.maven.project.MavenProject;
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
import java.io.OutputStream;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;
import java.util.stream.Stream;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * A project that documents both surfaces ({@code metaobjects:docs} with {@code language=java,kotlin})
 * can own both {@code api-docs} generators in ONE {@code codegen/} module. The two ports name
 * their page model and path classes alike ({@code ApiUnit}, {@code ApiSymbol}, {@code FieldShape},
 * {@code ApiSymbolKind}, {@code DocsPaths}), so the copies have to land where no class is declared
 * twice.
 *
 * <p>Runs the real mojo once per port into one project, then compiles what it wrote with each
 * language's own compiler. The classname eject prints for each port has to load, from that
 * compile, as the docs generator of that surface.</p>
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

    /** Eject {@code api-docs} for one port, and return the owned classname eject printed for it. */
    private String ejectApiDocs(String port) throws Exception {
        MetaDataEjectMojo mojo = new MetaDataEjectMojo();
        mojo.project = project;
        mojo.names = "api-docs";
        mojo.port = port;
        Log log = Mockito.mock(Log.class);
        mojo.setLog(log);
        mojo.execute();

        ArgumentCaptor<CharSequence> captor = ArgumentCaptor.forClass(CharSequence.class);
        Mockito.verify(log, Mockito.atLeastOnce()).info(captor.capture());
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

    private static void assertDocsGeneratorOf(String surface, String classname, ClassLoader loader) throws Exception {
        Object generator = Class.forName(classname, true, loader).getDeclaredConstructor().newInstance();
        assertTrue(classname + " is not a DocsGenerator", generator instanceof DocsGenerator);
        assertEquals(classname, surface, ((DocsGenerator) generator).surface());
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
            assertDocsGeneratorOf("java", ownedJava, java);
        }
        assertDocsGeneratorOf("kotlin", ownedKotlin, kotlin.getClassLoader());
    }
}

package com.metaobjects.mojo;

import com.metaobjects.generator.Generator;
import com.metaobjects.generator.spring.SpringNamesGenerator;
import com.metaobjects.loader.LoaderOptions;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.loader.uri.URIHelper;
import org.apache.maven.project.MavenProject;
import org.junit.Before;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import org.junit.Rule;
import org.mockito.Mockito;

import javax.tools.Diagnostic;
import javax.tools.DiagnosticCollector;
import javax.tools.JavaCompiler;
import javax.tools.JavaFileObject;
import javax.tools.StandardJavaFileManager;
import javax.tools.StandardLocation;
import javax.tools.ToolProvider;
import java.io.IOException;
import java.net.URI;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.charset.StandardCharsets;
import java.nio.file.FileVisitResult;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.SimpleFileVisitor;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * Eject proofs (b) and (c) — the round trip {@code mvn metaobjects:eject} exists for.
 *
 * <p>(b) An UNCHANGED ejected copy, run through the real generator SPI against the shared
 * cross-port fixture ({@code fixtures/persistence-conformance/canonical/meta.fitness.json}),
 * must produce output byte-identical to the packaged generator's.
 *
 * <p>(c) An EDIT to the ejected copy must appear in its output.
 *
 * <p>Uses the "names" generator (Java's {@code SpringNamesGenerator}) — the simplest
 * ejectable Java generator (one {@code outputDir} arg, no cross-entity wiring) — as the one
 * concrete round-trip subject. The mojo-level behavior (unknown-name / refuse-overwrite /
 * force / port resolution / package override) is covered generically for every ejectable
 * name in {@link MetaDataEjectMojoTest} and {@link EjectSupportTest}; this test is the one
 * that actually EXECUTES an ejected copy's generated code and diffs it against the
 * packaged generator's.
 */
public class EjectRoundTripTest {

    @Rule
    public TemporaryFolder tempFolder = new TemporaryFolder();

    private MetaDataLoader loader;

    @Before
    public void setUp() throws IOException {
        Path fitness = findFitnessFixture();
        URI uri = URIHelper.toURI("model:file:" + fitness.toAbsolutePath().toString().replace('\\', '/'));
        loader = new MetaDataLoader(
                LoaderOptions.create(false, false, true),
                MetaDataLoader.SUBTYPE_MANUAL, "eject-roundtrip-test");
        loader.setSourceURIs(List.of(uri));
        loader.init();
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

    private Path runPackagedNamesGenerator() throws IOException {
        Path outDir = tempFolder.newFolder("packaged-out").toPath();
        Generator gen = new SpringNamesGenerator();
        gen.setArgs(Map.of("outputDir", outDir.toString()));
        gen.execute(loader);
        return outDir;
    }

    /** Eject "names" (-Dport=java, unambiguous target package) into a fresh temp project. */
    private Path ejectNames(Path projectDir) throws Exception {
        MavenProject project = Mockito.mock(MavenProject.class);
        Mockito.when(project.getBasedir()).thenReturn(projectDir.toFile());
        Mockito.when(project.getGroupId()).thenReturn("com.acme");
        Mockito.when(project.getArtifactId()).thenReturn("widgets");
        Mockito.when(project.getVersion()).thenReturn("1.0.0");
        Mockito.when(project.getDependencies()).thenReturn(List.of());

        MetaDataEjectMojo mojo = new MetaDataEjectMojo();
        mojo.project = project;
        mojo.names = "names";
        mojo.port = "java";
        mojo.execute();

        return projectDir.resolve("codegen/src/main/java/com/acme/codegen/SpringNamesGenerator.java");
    }

    /** Compile {@code source} (a package-renamed copy) and run it as a {@link Generator}
     *  against {@link #loader}, into a fresh output dir. Returns that dir. */
    private Path compileAndRun(Path source, Path classesOut) throws Exception {
        JavaCompiler javac = ToolProvider.getSystemJavaCompiler();
        DiagnosticCollector<JavaFileObject> diagnostics = new DiagnosticCollector<>();
        try (StandardJavaFileManager fm = javac.getStandardFileManager(diagnostics, null, StandardCharsets.UTF_8)) {
            fm.setLocation(StandardLocation.CLASS_OUTPUT, List.of(classesOut.toFile()));
            Iterable<? extends JavaFileObject> units = fm.getJavaFileObjectsFromFiles(List.of(source.toFile()));
            List<String> options = List.of("-classpath", System.getProperty("java.class.path"));
            boolean ok = javac.getTask(null, fm, diagnostics, options, null, units).call();
            if (!ok) {
                StringBuilder errs = new StringBuilder();
                for (Diagnostic<? extends JavaFileObject> d : diagnostics.getDiagnostics()) errs.append(d).append('\n');
                throw new AssertionError("owned copy failed to compile:\n" + errs);
            }
        }

        try (URLClassLoader child = new URLClassLoader(
                new URL[]{classesOut.toUri().toURL()}, Thread.currentThread().getContextClassLoader())) {
            Class<?> cls = Class.forName("com.acme.codegen.SpringNamesGenerator", true, child);
            Generator gen = (Generator) cls.getDeclaredConstructor().newInstance();
            Path outDir = classesOut.resolveSibling(classesOut.getFileName() + "-out");
            gen.setArgs(Map.of("outputDir", outDir.toString()));
            gen.execute(loader);
            return outDir;
        }
    }

    private static Set<String> relativeFiles(Path root) throws IOException {
        Set<String> out = new LinkedHashSet<>();
        if (!Files.isDirectory(root)) return out;
        Files.walkFileTree(root, new SimpleFileVisitor<>() {
            @Override
            public FileVisitResult visitFile(Path file, BasicFileAttributes attrs) {
                out.add(root.relativize(file).toString());
                return FileVisitResult.CONTINUE;
            }
        });
        return out;
    }

    private static void assertTreesByteIdentical(Path a, Path b) throws IOException {
        Set<String> filesA = relativeFiles(a);
        Set<String> filesB = relativeFiles(b);
        assertEquals("same set of generated files", new TreeSet<>(filesA), new TreeSet<>(filesB));
        for (String rel : filesA) {
            byte[] ca = Files.readAllBytes(a.resolve(rel));
            byte[] cb = Files.readAllBytes(b.resolve(rel));
            assertTrue("content differs for " + rel, java.util.Arrays.equals(ca, cb));
        }
    }

    @Test
    public void proofB_anUnchangedEjectedCopyProducesByteIdenticalOutput() throws Exception {
        Path packagedOut = runPackagedNamesGenerator();

        Path projectDir = tempFolder.newFolder("adopter-b").toPath();
        Path ejectedSource = ejectNames(projectDir);
        assertTrue(Files.exists(ejectedSource));

        Path ownedOut = compileAndRun(ejectedSource, tempFolder.newFolder("owned-b-classes").toPath());

        assertTreesByteIdentical(packagedOut, ownedOut);
    }

    @Test
    public void proofC_anEditedEjectedCopysChangeAppearsInItsOutput() throws Exception {
        Path projectDir = tempFolder.newFolder("adopter-c").toPath();
        Path ejectedSource = ejectNames(projectDir);

        String original = Files.readString(ejectedSource, StandardCharsets.UTF_8);
        assertTrue(original.contains(" * GENERATED — per-object physical database names for "));
        String edited = original.replace(
                " * GENERATED — per-object physical database names for ",
                " * GENERATED (OWNED COPY, EDITED BY THE ADOPTER) — per-object physical database names for ");
        assertFalse(edited.equals(original));
        Files.writeString(ejectedSource, edited, StandardCharsets.UTF_8);

        Path ownedOut = compileAndRun(ejectedSource, tempFolder.newFolder("owned-c-classes").toPath());

        boolean sawEdit = false;
        for (String rel : relativeFiles(ownedOut)) {
            String content = Files.readString(ownedOut.resolve(rel), StandardCharsets.UTF_8);
            if (content.contains("OWNED COPY, EDITED BY THE ADOPTER")) {
                sawEdit = true;
                break;
            }
        }
        assertTrue("expected the hand-edit to appear in at least one generated file", sawEdit);
    }
}

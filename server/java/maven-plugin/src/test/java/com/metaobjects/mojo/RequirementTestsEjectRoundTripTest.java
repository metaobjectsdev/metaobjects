package com.metaobjects.mojo;

import com.metaobjects.generator.Generator;
import com.metaobjects.generator.spring.JUnitRequirementTestsGenerator;
import com.metaobjects.loader.DirectorySource;
import com.metaobjects.loader.LoaderOptions;
import com.metaobjects.loader.MetaDataLoader;
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
import java.io.IOException;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.charset.StandardCharsets;
import java.nio.file.FileVisitResult;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.SimpleFileVisitor;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * Eject proof (b) for {@code requirement-tests}: the UNCHANGED ejected copy, compiled, emits the
 * same bytes as the packaged generator. The model is the identity corpus's {@code worked-example}
 * and the args are NOT the defaults ({@code grain=member}, another {@code testPackage}), so a copy
 * that read a default instead of its arg, or that carried the generator's own package or class
 * name into its output, would differ. {@link EjectRoundTripTest} does the same for the names
 * generator over the persistence corpus, which has no requirement.
 */
public class RequirementTestsEjectRoundTripTest {

    @Rule
    public TemporaryFolder tempFolder = new TemporaryFolder();

    private MetaDataLoader loader;

    private static final Map<String, String> ARGS = Map.of(
        "testPackage", "com.example.requirements",
        "witnessClass", "com.example.Witnesses",
        "grain", "member");

    @Before
    public void loadWorkedExample() throws IOException {
        Path input = null;
        for (Path p = Path.of("").toAbsolutePath(); p != null && input == null; p = p.getParent()) {
            Path candidate = p.resolve("fixtures/requirement-test-identity-conformance/worked-example/input");
            if (Files.isDirectory(candidate)) input = candidate;
        }
        assertTrue("worked-example corpus case not found", input != null);
        loader = new MetaDataLoader(LoaderOptions.create(false, false, true),
            MetaDataLoader.SUBTYPE_MANUAL, "requirement-tests-eject-roundtrip");
        loader.init();
        loader.load(new DirectorySource(input, new DirectorySource.Options()).expandToList());
        assertTrue(loader.getErrors().toString(), loader.getErrors().isEmpty());
    }

    private Path eject(Path projectDir) throws Exception {
        MavenProject project = Mockito.mock(MavenProject.class);
        Mockito.when(project.getBasedir()).thenReturn(projectDir.toFile());
        Mockito.when(project.getGroupId()).thenReturn("com.acme");
        Mockito.when(project.getArtifactId()).thenReturn("widgets");
        Mockito.when(project.getVersion()).thenReturn("1.0.0");
        Mockito.when(project.getDependencies()).thenReturn(List.of());

        MetaDataEjectMojo mojo = new MetaDataEjectMojo();
        mojo.project = project;
        mojo.names = "requirement-tests";
        mojo.port = "java";
        mojo.execute();
        return projectDir.resolve("codegen/src/main/java/com/acme/codegen/JUnitRequirementTestsGenerator.java");
    }

    private Path generate(Generator gen, String label) throws IOException {
        Path out = tempFolder.newFolder(label).toPath();
        Map<String, String> args = new java.util.HashMap<>(ARGS);
        args.put("outputDir", out.toString());
        gen.setArgs(args);
        gen.execute(loader);
        return out;
    }

    private static Set<String> relativeFiles(Path root) throws IOException {
        Set<String> out = new TreeSet<>();
        Files.walkFileTree(root, new SimpleFileVisitor<>() {
            @Override
            public FileVisitResult visitFile(Path file, BasicFileAttributes attrs) {
                out.add(root.relativize(file).toString());
                return FileVisitResult.CONTINUE;
            }
        });
        return out;
    }

    @Test
    public void anUnchangedEjectedCopyProducesByteIdenticalOutput() throws Exception {
        Path packaged = generate(new JUnitRequirementTestsGenerator(), "packaged");

        Path source = eject(tempFolder.newFolder("adopter").toPath());
        assertTrue(Files.exists(source));
        String copy = Files.readString(source, StandardCharsets.UTF_8);
        assertTrue("the copy is package-renamed", copy.contains("package com.acme.codegen;"));
        assertFalse(copy.contains("package com.metaobjects.generator.spring;"));

        Path classes = tempFolder.newFolder("owned-classes").toPath();
        JavaCompiler javac = ToolProvider.getSystemJavaCompiler();
        DiagnosticCollector<JavaFileObject> diagnostics = new DiagnosticCollector<>();
        try (StandardJavaFileManager fm = javac.getStandardFileManager(diagnostics, null, StandardCharsets.UTF_8)) {
            fm.setLocation(StandardLocation.CLASS_OUTPUT, List.of(classes.toFile()));
            boolean ok = javac.getTask(null, fm, diagnostics, List.of("-classpath", System.getProperty("java.class.path")),
                null, fm.getJavaFileObjectsFromFiles(List.of(source.toFile()))).call();
            StringBuilder errs = new StringBuilder();
            for (Diagnostic<? extends JavaFileObject> d : diagnostics.getDiagnostics()) errs.append(d).append('\n');
            assertTrue("owned copy failed to compile:\n" + errs, ok);
        }

        Path owned;
        try (URLClassLoader child = new URLClassLoader(new URL[]{classes.toUri().toURL()},
            Thread.currentThread().getContextClassLoader())) {
            Generator gen = (Generator) Class.forName("com.acme.codegen.JUnitRequirementTestsGenerator", true, child)
                .getDeclaredConstructor().newInstance();
            owned = generate(gen, "owned");
        }

        Set<String> files = relativeFiles(packaged);
        assertEquals(new TreeSet<>(Arrays.asList(
            "com/example/requirements/Requirements_acme_shop_Test.java",
            "com/example/requirements/Requirements_acme_shop_Witnesses.java")), files);
        assertEquals("same set of generated files", files, relativeFiles(owned));
        for (String rel : files) {
            assertEquals("content differs for " + rel,
                Files.readString(packaged.resolve(rel), StandardCharsets.UTF_8),
                Files.readString(owned.resolve(rel), StandardCharsets.UTF_8));
        }
        // member grain, not the default: the unit is the reference as authored.
        assertTrue(Files.readString(owned.resolve("com/example/requirements/Requirements_acme_shop_Test.java"))
            .contains("req_acme_shop_Orders_Recorded__Order()"));
    }
}

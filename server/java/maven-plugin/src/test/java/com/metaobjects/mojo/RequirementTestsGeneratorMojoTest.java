package com.metaobjects.mojo;

import com.metaobjects.generator.spring.JUnitRequirementTestsGenerator;
import org.apache.maven.plugin.MojoExecution;
import org.apache.maven.plugin.MojoFailureException;
import org.apache.maven.project.MavenProject;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import org.mockito.Mockito;

import javax.tools.JavaCompiler;
import javax.tools.StandardJavaFileManager;
import javax.tools.StandardLocation;
import javax.tools.ToolProvider;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.stream.Stream;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

/**
 * {@code requirement-tests} through the real goals: a {@code filter} class that lives only on the
 * PROJECT's classpath is found (the plugin's own class loader cannot see it, which is why
 * {@code buildGenerators} hands the project loader to a {@link
 * com.metaobjects.generator.ProjectClassLoaderAware} generator), and {@code metaobjects:verify}
 * reports the two files of a package that lost its last requirement as {@code [stale-in-repo]}.
 */
public class RequirementTestsGeneratorMojoTest {

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    private static final String ORDER_ENTITY = """
        { "object.entity": { "name": "Order", "children": [
            { "field.long": { "name": "id" } },
            { "identity.primary": { "name": "pk", "@fields": ["id"] } } ] } }""";

    private static final String L3_PARENT = """
        { "requirement.functional": { "name": "Orders", "@level": 3, "@status": "live",
            "@statement": "Every placed order is kept.", "@counterexample": "A placed order is lost." } }""";

    private static final String L4_ORDER = """
        { "requirement.functional": { "name": "Recorded", "@level": 4, "@status": "live",
            "@statement": "An order is recorded.", "@counterexample": "A placed order has no row.",
            "@implementedBy": ["Order"] } }""";

    private Path model(String... children) throws IOException {
        Path dir = tmp.newFolder().toPath();
        Files.writeString(dir.resolve("meta.app.json"), "{ \"metadata.root\": { \"package\": \"acme::shop\", \"children\": [\n"
            + String.join(",\n", children) + "\n] } }", StandardCharsets.UTF_8);
        return dir;
    }

    private void configure(AbstractMetaDataMojo mojo, Path modelDir, Path outputDir, String... extraArgs) {
        mojo.setLoader(LoaderParam.builder("requirement-tests-mojo")
            .withClassname("com.metaobjects.loader.MetaDataLoader")
            .withSourceDir(modelDir.toString())
            .withSource("meta.app.json")
            .build());
        GeneratorParam.Builder gen = GeneratorParam.builder(JUnitRequirementTestsGenerator.class.getName())
            .withArg("outputDir", outputDir.toString())
            .withArg("testPackage", "com.acme.requirements")
            .withArg("witnessClass", "com.acme.Witnesses");
        for (int i = 0; i < extraArgs.length; i += 2) gen.withArg(extraArgs[i], extraArgs[i + 1]);
        mojo.setGenerators(new ArrayList<>(List.of(gen.build())));
        mojo.setGlobals(Collections.emptyMap());
    }

    /** Compile a filter into a directory that is on no ambient class path. */
    private Path compileProjectFilter() throws IOException {
        Path src = tmp.newFolder().toPath().resolve("com/acme/ProjectOnlyFilter.java");
        Files.createDirectories(src.getParent());
        Files.writeString(src, "package com.acme;\npublic class ProjectOnlyFilter implements com.metaobjects.requirement.RequirementTestFilter {\n"
            + "  public boolean include(com.metaobjects.requirement.RequirementTestIdentities.View v) { return true; }\n}\n");
        Path classes = tmp.newFolder().toPath();
        JavaCompiler javac = ToolProvider.getSystemJavaCompiler();
        try (StandardJavaFileManager fm = javac.getStandardFileManager(null, null, StandardCharsets.UTF_8)) {
            fm.setLocation(StandardLocation.CLASS_OUTPUT, List.of(classes.toFile()));
            assertTrue(javac.getTask(null, fm, null, List.of("-classpath", System.getProperty("java.class.path")), null,
                fm.getJavaFileObjectsFromFiles(List.of(src.toFile()))).call());
        }
        return classes;
    }

    private MetaDataGeneratorMojo genMojoWithProjectClasspath(Path projectClasses) throws Exception {
        MavenProject project = Mockito.mock(MavenProject.class);
        Mockito.when(project.getBasedir()).thenReturn(tmp.getRoot());
        Mockito.when(project.getRuntimeClasspathElements()).thenReturn(List.of());
        Mockito.when(project.getCompileClasspathElements()).thenReturn(List.of(projectClasses.toString()));
        Mockito.when(project.getTestClasspathElements()).thenReturn(List.of());
        MojoExecution execution = Mockito.mock(MojoExecution.class);
        Mockito.when(execution.getLifecyclePhase()).thenReturn(AbstractMetaDataMojo.PHASE_GENERATE_SOURCES);
        MetaDataGeneratorMojo mojo = new MetaDataGeneratorMojo();
        mojo.project = project;
        mojo.execution = execution;
        return mojo;
    }

    @Test
    public void aFilterClassOnlyTheProjectClasspathHoldsIsFoundThroughTheGenerateGoal() throws Exception {
        Path model = model(ORDER_ENTITY, L3_PARENT, L4_ORDER);
        Path projectClasses = compileProjectFilter();

        Path out = tmp.newFolder().toPath();
        MetaDataGeneratorMojo gen = genMojoWithProjectClasspath(projectClasses);
        configure(gen, model, out, "filter", "com.acme.ProjectOnlyFilter");
        gen.execute();
        String test = Files.readString(out.resolve("com/acme/requirements/Requirements_acme_shop_Test.java"), StandardCharsets.UTF_8);
        assertTrue("the project's filter kept the L3 requirement the default drops: " + test, test.contains("// acme::shop::Orders [*]"));

        // The same configuration with no project classpath: the class is not found, said plainly.
        MetaDataGeneratorMojo bare = new MetaDataGeneratorMojo();
        configure(bare, model, tmp.newFolder().toPath(), "filter", "com.acme.ProjectOnlyFilter");
        Exception e = assertThrows(Exception.class, bare::execute);
        assertTrue(e.toString(), e.toString().contains("com.acme.ProjectOnlyFilter"));
    }

    @Test
    public void verifyReportsTheFilesOfAPackageThatLostItsLastRequirementAsStaleInRepo() throws Exception {
        Path out = tmp.newFolder().toPath();
        MetaDataGeneratorMojo gen = new MetaDataGeneratorMojo();
        configure(gen, model(ORDER_ENTITY, L3_PARENT, L4_ORDER), out);
        gen.execute();

        MetaDataVerifyMojo inSync = new MetaDataVerifyMojo();
        configure(inSync, model(ORDER_ENTITY, L3_PARENT, L4_ORDER), out);
        inSync.setMode("codegen");
        inSync.execute();

        // The requirement is removed. gen never deletes a file, so the two are still there...
        Path dropped = model(ORDER_ENTITY);
        MetaDataGeneratorMojo regen = new MetaDataGeneratorMojo();
        configure(regen, dropped, out);
        regen.execute();
        try (Stream<Path> files = Files.list(out.resolve("com/acme/requirements"))) {
            assertEquals(2, files.count());
        }

        // ...and verify names them.
        MetaDataVerifyMojo verify = new MetaDataVerifyMojo();
        configure(verify, dropped, out);
        verify.setMode("codegen");
        try {
            verify.execute();
            fail("expected stale-in-repo drift");
        } catch (MojoFailureException e) {
            assertTrue(e.getMessage(), e.getMessage().contains("[stale-in-repo]"));
            assertTrue(e.getMessage(), e.getMessage().contains("Requirements_acme_shop_Test.java"));
            assertTrue(e.getMessage(), e.getMessage().contains("Requirements_acme_shop_Witnesses.java"));
        }
    }
}

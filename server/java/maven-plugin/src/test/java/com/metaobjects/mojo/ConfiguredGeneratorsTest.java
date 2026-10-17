package com.metaobjects.mojo;

import com.metaobjects.MetaDataException;
import com.metaobjects.generator.GeneratorBase;
import com.metaobjects.generator.util.GeneratedFileWriter;
import com.metaobjects.generator.util.HashManifest;
import com.metaobjects.loader.MetaDataLoader;
import org.apache.maven.execution.DefaultMavenExecutionRequest;
import org.apache.maven.execution.MavenSession;
import org.apache.maven.model.building.ModelBuildingRequest;
import org.apache.maven.plugin.MojoExecution;
import org.apache.maven.plugin.MojoFailureException;
import org.apache.maven.plugin.descriptor.MojoDescriptor;
import org.apache.maven.plugin.testing.MojoRule;
import org.apache.maven.project.MavenProject;
import org.apache.maven.project.ProjectBuilder;
import org.apache.maven.project.ProjectBuildingRequest;
import org.eclipse.aether.DefaultRepositorySystemSession;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import org.mockito.Mockito;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

/**
 * Which generators a module configures is read from the module as Maven builds it with no
 * profile, with each profile alone and with the build's own profiles: a generator an
 * inactive profile runs is still configured, so a plain
 * build neither deletes its files nor reports them as drift, and a generator removed from
 * the POM (main build or profile) is not, so its files are cleaned. Every module here is a
 * real POM on disk, built by Maven's own {@link ProjectBuilder}.
 */
public class ConfiguredGeneratorsTest {

    @Rule
    public MojoRule rule = new MojoRule();

    @Rule
    public TemporaryFolder tempFolder = new TemporaryFolder();

    /** Writes one configurable file through the real write guard. */
    public static class FileGenerator extends GeneratorBase {
        @Override
        public void execute(MetaDataLoader loader) {
            try {
                GeneratedFileWriter.write(getOutputDir().toPath().resolve(getArg("filename", "Foo.java")),
                        "/** GENERATED */\npublic class X {}\n");
            } catch (IOException e) {
                throw new RuntimeException(e);
            }
        }
    }

    public static class DtoGenerator extends FileGenerator {}
    public static class ClientGenerator extends FileGenerator {}

    private Path root;

    @Before
    public void setUp() {
        root = tempFolder.getRoot().toPath();
    }

    private static String generators(String... classAndDir) {
        StringBuilder sb = new StringBuilder("<generators>");
        for (int i = 0; i < classAndDir.length; i += 2) {
            sb.append("<generator><classname>").append(classAndDir[i]).append("</classname><args><outputDir>")
                    .append(classAndDir[i + 1]).append("</outputDir></args></generator>");
        }
        return sb.append("</generators>").toString();
    }

    private static String plugin(String executionId, String generators) {
        return "<plugin><groupId>com.metaobjects</groupId><artifactId>metaobjects-maven-plugin</artifactId>"
                + "<version>8.1.0</version><executions><execution><id>" + executionId + "</id>"
                + "<goals><goal>generate</goal></goals><configuration>" + generators
                + "</configuration></execution></executions></plugin>";
    }

    private static String profile(String id, String properties, String plugin) {
        return "<profile><id>" + id + "</id><properties>" + properties + "</properties>"
                + "<build><plugins>" + plugin + "</plugins></build></profile>";
    }

    private static Path pom(Path dir, String artifactId, String parent, String plugins, String profiles)
            throws IOException {
        Files.createDirectories(dir);
        Path pom = dir.resolve("pom.xml");
        Files.writeString(pom, "<project><modelVersion>4.0.0</modelVersion>" + parent
                + "<groupId>test</groupId><artifactId>" + artifactId + "</artifactId><version>1</version>"
                + "<packaging>pom</packaging><build><plugins>" + plugins + "</plugins></build>"
                + "<profiles>" + profiles + "</profiles></project>");
        return pom;
    }

    private static final String DTO = DtoGenerator.class.getName();
    private static final String CLIENT = ClientGenerator.class.getName();

    private ProjectBuildingRequest request(String... activeProfiles) {
        ProjectBuildingRequest request = new DefaultMavenExecutionRequest().getProjectBuildingRequest();
        request.setRepositorySession(new DefaultRepositorySystemSession());
        request.setActiveProfileIds(List.of(activeProfiles));
        request.setResolveDependencies(false);
        request.setValidationLevel(ModelBuildingRequest.VALIDATION_LEVEL_MINIMAL);
        return request;
    }

    /** {@code mvn [-P<profiles>]} on the module at {@code pom}: the project Maven builds. */
    private MavenProject build(Path pom, String... activeProfiles) throws Exception {
        return rule.lookup(ProjectBuilder.class).build(pom.toFile(), request(activeProfiles)).getProject();
    }

    /** The {@link ProjectBuilder} the mojos use, counted: every call is one model build. */
    private ProjectBuilder modelBuilder;

    private ProjectBuilder modelBuilder() throws Exception {
        if (modelBuilder == null) modelBuilder = Mockito.spy(rule.lookup(ProjectBuilder.class));
        return modelBuilder;
    }

    private long modelBuilds() throws Exception {
        return Mockito.mockingDetails(modelBuilder()).getInvocations().stream()
                .filter(i -> i.getMethod().getName().equals("build")).count();
    }

    private <M extends AbstractMetaDataMojo> M inBuild(M mojo, MavenProject module, String executionId,
                                                         String... activeProfiles) throws Exception {
        MavenSession session = Mockito.mock(MavenSession.class);
        Mockito.when(session.getProjectBuildingRequest()).thenReturn(request(activeProfiles));
        mojo.project = module;
        mojo.session = session;
        mojo.projectBuilder = modelBuilder();
        mojo.execution = new MojoExecution(new MojoDescriptor(), executionId);
        return mojo;
    }

    private static GeneratorParam gen(String classname, Path outputDir, String filename) {
        GeneratorParam p = new GeneratorParam();
        p.setClassname(classname);
        p.setArgs(Map.of(GeneratorBase.ARG_OUTPUTDIR, outputDir.toString(), "filename", filename));
        return p;
    }

    /** One execution of the module, as {@code mvn [-P<profiles>] compile} runs it. */
    private void generate(MavenProject module, String executionId, String[] activeProfiles, GeneratorParam... params)
            throws Exception {
        MetaDataGeneratorMojo mojo = inBuild(new MetaDataGeneratorMojo(), module, executionId, activeProfiles);
        mojo.setLoader(new LoaderParam());
        mojo.setGenerators(List.of(params));
        mojo.executeGenerators(null, mojo.buildGenerators(getClass().getClassLoader(), null));
    }

    private void verify(MavenProject module, GeneratorParam... params) throws Exception {
        MetaDataVerifyMojo mojo = inBuild(new MetaDataVerifyMojo(), module, "verify");
        mojo.setLoader(LoaderParam.builder("configured-generators-test")
                .withClassname("com.metaobjects.loader.MetaDataLoader")
                .withSourceDir(Path.of("src/test/resources").toAbsolutePath().toString())
                .withSource("mojo/verify-test-metadata.json")
                .build());
        mojo.setGenerators(List.of(params));
        mojo.execute();
    }

    private static final String[] NO_PROFILES = {};

    /** Generate with {@code -Pclient} (both executions), then a plain build. */
    private void clientBuildThenPlainBuild(Path pom, Path mainDir, Path clientDir) throws Exception {
        MavenProject withClient = build(pom, "client");
        generate(withClient, "codegen", new String[] {"client"}, gen(DTO, mainDir, "Dto.java"));
        generate(withClient, "client", new String[] {"client"}, gen(CLIENT, clientDir, "Client.java"));
        assertTrue(Files.exists(clientDir.resolve("Client.java")));

        generate(build(pom), "codegen", NO_PROFILES, gen(DTO, mainDir, "Dto.java"));
    }

    @Test
    public void inactiveProfilesGenerator_keepsItsFiles_andVerifyStaysGreen() throws Exception {
        Path mainDir = root.resolve("gen");
        Path clientDir = root.resolve("client");
        Path pom = pom(root, "app", "", plugin("codegen", generators(DTO, "${project.basedir}/gen")),
                profile("client", "", plugin("client", generators(CLIENT, "${project.basedir}/client"))));

        clientBuildThenPlainBuild(pom, mainDir, clientDir);

        assertTrue("an inactive profile still configures its generator", Files.exists(clientDir.resolve("Client.java")));
        verify(build(pom), gen(DTO, mainDir, "Dto.java"));
    }

    @Test
    public void profileScopedPropertyAsOutputDir_resolvesAsWhenTheProfileIsOn() throws Exception {
        Path mainDir = root.resolve("gen");
        Path clientDir = root.resolve("src/main/client");
        Path pom = pom(root, "app", "", plugin("codegen", generators(DTO, "${project.basedir}/gen")),
                profile("client", "<client.dir>${project.basedir}/src/main/client</client.dir>",
                        plugin("client", generators(CLIENT, "${client.dir}"))));

        clientBuildThenPlainBuild(pom, mainDir, clientDir);

        assertTrue(Files.exists(clientDir.resolve("Client.java")));
        verify(build(pom), gen(DTO, mainDir, "Dto.java"));
    }

    @Test
    public void parentPomsProfile_countsAsConfiguredInTheModule() throws Exception {
        Path moduleDir = root.resolve("app");
        Path mainDir = moduleDir.resolve("gen");
        Path clientDir = moduleDir.resolve("client");
        pom(root, "parent", "", "",
                profile("client", "", plugin("client", generators(CLIENT, "${project.basedir}/client"))));
        Path pom = pom(moduleDir, "app",
                "<parent><groupId>test</groupId><artifactId>parent</artifactId><version>1</version></parent>",
                plugin("codegen", generators(DTO, "${project.basedir}/gen")), "");

        clientBuildThenPlainBuild(pom, mainDir, clientDir);

        assertTrue(Files.exists(clientDir.resolve("Client.java")));
        verify(build(pom), gen(DTO, mainDir, "Dto.java"));
    }

    @Test
    public void exclusiveProfilesSettingOneOutputDir_eachKeepsItsFiles_inBothDirections() throws Exception {
        Path pgDir = root.resolve("src/gen/pg");
        Path mysqlDir = root.resolve("src/gen/mysql");
        Path pom = pom(root, "app", "", plugin("codegen", generators(DTO, "${gen.dir}")),
                profile("pg", "<gen.dir>${project.basedir}/src/gen/pg</gen.dir>", "")
                        + profile("mysql", "<gen.dir>${project.basedir}/src/gen/mysql</gen.dir>", ""));

        generate(build(pom, "pg"), "codegen", new String[] {"pg"}, gen(DTO, pgDir, "Dto.java"));
        generate(build(pom, "mysql"), "codegen", new String[] {"mysql"}, gen(DTO, mysqlDir, "Dto.java"));
        assertTrue("-Pmysql leaves what -Ppg configures", Files.exists(pgDir.resolve("Dto.java")));
        verify(build(pom, "mysql"), gen(DTO, mysqlDir, "Dto.java"));

        generate(build(pom, "pg"), "codegen", new String[] {"pg"}, gen(DTO, pgDir, "Dto.java"));
        assertTrue("-Ppg leaves what -Pmysql configures", Files.exists(mysqlDir.resolve("Dto.java")));
        verify(build(pom, "pg"), gen(DTO, pgDir, "Dto.java"));
    }

    @Test
    public void twoProfilesOverridingOneExecutionsGenerators_eachKeepsItsFiles() throws Exception {
        Path aDir = root.resolve("a");
        Path bDir = root.resolve("b");
        Path pom = pom(root, "app", "", "",
                profile("a", "", plugin("codegen", generators(DTO, "${project.basedir}/a")))
                        + profile("b", "", plugin("codegen", generators(CLIENT, "${project.basedir}/b"))));

        generate(build(pom, "a"), "codegen", new String[] {"a"}, gen(DTO, aDir, "A.java"));
        generate(build(pom, "b"), "codegen", new String[] {"b"}, gen(CLIENT, bDir, "B.java"));
        assertTrue("profile b's run leaves what profile a configures", Files.exists(aDir.resolve("A.java")));
        verify(build(pom, "b"), gen(CLIENT, bDir, "B.java"));

        generate(build(pom, "a"), "codegen", new String[] {"a"}, gen(DTO, aDir, "A.java"));
        assertTrue("profile a's run leaves what profile b configures", Files.exists(bDir.resolve("B.java")));
        verify(build(pom, "a"), gen(DTO, aDir, "A.java"));
    }

    @Test
    public void generatorRemovedFromAProfile_itsFilesAreCleaned_andVerifyReportsThemFirst() throws Exception {
        Path mainDir = root.resolve("gen");
        Path clientDir = root.resolve("client");
        Path pom = pom(root, "app", "", plugin("codegen", generators(DTO, "${project.basedir}/gen")),
                profile("client", "", plugin("client", generators(CLIENT, "${project.basedir}/client"))));
        MavenProject withClient = build(pom, "client");
        generate(withClient, "codegen", new String[] {"client"}, gen(DTO, mainDir, "Dto.java"));
        generate(withClient, "client", new String[] {"client"}, gen(CLIENT, clientDir, "Client.java"));

        pom(root, "app", "", plugin("codegen", generators(DTO, "${project.basedir}/gen")),
                profile("client", "", plugin("client", generators())));
        try {
            verify(build(pom), gen(DTO, mainDir, "Dto.java"));
            fail("expected the removed generator's file to be drift");
        } catch (MojoFailureException e) {
            assertTrue(e.getMessage(), e.getMessage().contains("Client.java")
                    && e.getMessage().contains("'mvn metaobjects:generate' deletes it"));
        }

        generate(build(pom), "codegen", NO_PROFILES, gen(DTO, mainDir, "Dto.java"));

        assertFalse(Files.exists(clientDir.resolve("Client.java")));
        assertTrue(Files.exists(mainDir.resolve("Dto.java")));
    }

    @Test
    public void generatorRemovedFromTheMainBuild_itsFilesAreCleanedWhereverTheyLive() throws Exception {
        Path mainDir = root.resolve("gen");
        Path webDir = root.resolve("web");
        Path pom = pom(root, "app", "", plugin("codegen", generators(DTO, "${project.basedir}/gen",
                CLIENT, "${project.basedir}/web")), "");
        generate(build(pom), "codegen", NO_PROFILES, gen(DTO, mainDir, "Dto.java"), gen(CLIENT, webDir, "Route.java"));

        pom(root, "app", "", plugin("codegen", generators(DTO, "${project.basedir}/gen")), "");
        generate(build(pom), "codegen", NO_PROFILES, gen(DTO, mainDir, "Dto.java"));

        assertFalse("no execution configures its generator any more", Files.exists(webDir.resolve("Route.java")));
        assertTrue(Files.exists(mainDir.resolve("Dto.java")));
    }

    @Test
    public void twoExecutionsInOneModule_readTheConfiguredGeneratorsOnce() throws Exception {
        Path mainDir = root.resolve("gen");
        Path webDir = root.resolve("web");
        Path clientDir = root.resolve("client");
        String client = "<execution><id>client</id><goals><goal>generate</goal></goals><configuration>"
                + generators(CLIENT, "${project.basedir}/client") + "</configuration></execution>";
        Path pom = pom(root, "app", "", plugin("codegen", generators(DTO, "${project.basedir}/gen",
                CLIENT, "${project.basedir}/web")).replace("</executions>", client + "</executions>"), "");
        MavenProject first = build(pom);
        generate(first, "codegen", NO_PROFILES, gen(DTO, mainDir, "Dto.java"), gen(CLIENT, webDir, "Route.java"));
        generate(first, "client", NO_PROFILES, gen(CLIENT, clientDir, "Client.java"));
        Files.writeString(webDir.resolve("Route.java"), "/** GENERATED */\npublic class X { int mine; }\n");

        pom(root, "app", "", plugin("codegen", generators(DTO, "${project.basedir}/gen"))
                .replace("</executions>", client + "</executions>"), "");
        long before = modelBuilds();
        MavenProject second = build(pom);
        generate(second, "codegen", NO_PROFILES, gen(DTO, mainDir, "Dto.java"));
        generate(second, "client", NO_PROFILES, gen(CLIENT, clientDir, "Client.java"));

        assertTrue("an edited orphan of a removed generator is refused", Files.exists(webDir.resolve("Route.java")));
        assertEquals("one model (no profiles) for the module, shared by both executions", 1, modelBuilds() - before);
    }

    private static String execution(String id, String generators) {
        return "<execution><id>" + id + "</id><goals><goal>generate</goal></goals><configuration>"
                + generators + "</configuration></execution>";
    }

    @Test
    public void oneGeneratorInOneDirFromTwoExecutions_failsBeforeWritingAnything() throws Exception {
        Path gen = root.resolve("gen");
        Path pom = pom(root, "app", "", plugin("core", generators(DTO, "${project.basedir}/gen"))
                .replace("</executions>", execution("ext", generators(DTO, "${project.basedir}/gen")) + "</executions>"), "");
        try {
            generate(build(pom), "core", NO_PROFILES, gen(DTO, gen, "A.java"));
            fail("expected two executions of one generator into one dir to be refused");
        } catch (MetaDataException e) {
            assertTrue(e.getMessage(), e.getMessage().contains("'core' and 'ext'")
                    && e.getMessage().contains("its own <outputDir>"));
        }
        assertFalse("nothing written", Files.exists(gen.resolve("A.java")));
        try {
            verify(build(pom), gen(DTO, gen, "A.java"));
            fail("expected verify to refuse it too");
        } catch (MetaDataException e) {
            assertTrue(e.getMessage(), e.getMessage().contains("'core' and 'ext'"));
        }
    }

    @Test
    public void oneGeneratorInOneDirFromAProfilesExecution_failsNamingTheProfile() throws Exception {
        Path gen = root.resolve("gen");
        Path pom = pom(root, "app", "", plugin("core", generators(DTO, "${project.basedir}/gen")),
                profile("extra", "", plugin("extra", generators(DTO, "${project.basedir}/gen"))));
        try {
            generate(build(pom), "core", NO_PROFILES, gen(DTO, gen, "A.java"));
            fail("expected a profile's execution of the same generator and dir to be refused");
        } catch (MetaDataException e) {
            assertTrue(e.getMessage(), e.getMessage().contains("'core' and 'extra' (profile 'extra')"));
        }
        assertFalse(Files.exists(gen.resolve("A.java")));
    }

    @Test
    public void twoExecutionsInTwoDirs_eachCleansItsOwnOrphans() throws Exception {
        Path gen = root.resolve("gen");
        Path client = root.resolve("client");
        Path pom = pom(root, "app", "", plugin("core", generators(DTO, "${project.basedir}/gen"))
                .replace("</executions>", execution("ext", generators(DTO, "${project.basedir}/client")) + "</executions>"), "");
        MavenProject first = build(pom);
        generate(first, "core", NO_PROFILES, gen(DTO, gen, "A.java"));
        generate(first, "ext", NO_PROFILES, gen(DTO, client, "B.java"), gen(DTO, client, "C.java"));

        MavenProject second = build(pom);
        generate(second, "core", NO_PROFILES, gen(DTO, gen, "A.java"));
        assertTrue("core leaves ext's files", Files.exists(client.resolve("C.java")));
        generate(second, "ext", NO_PROFILES, gen(DTO, client, "B.java"));

        assertFalse("no execution emits it any more", Files.exists(client.resolve("C.java")));
        assertTrue(Files.exists(gen.resolve("A.java")) && Files.exists(client.resolve("B.java")));
    }

    /** {@code mvn metaobjects:generate compile}: the command-line run and the execution that
     *  inherits the plugin-level configuration are one configuration, run twice. */
    @Test
    public void commandLineRunAndTheExecutionInheritingItsConfiguration_inOneBuild_isGreen() throws Exception {
        Path gen = root.resolve("gen");
        Path pom = pom(root, "app", "", "<plugin><groupId>com.metaobjects</groupId>"
                + "<artifactId>metaobjects-maven-plugin</artifactId><version>8.1.0</version>"
                + "<configuration>" + generators(DTO, "${project.basedir}/gen") + "</configuration>"
                + "<executions><execution><id>codegen</id><goals><goal>generate</goal></goals></execution>"
                + "</executions></plugin>", "");
        MavenProject module = build(pom);
        generate(module, "default-cli", NO_PROFILES, gen(DTO, gen, "Dto.java"));
        generate(module, "codegen", NO_PROFILES, gen(DTO, gen, "Dto.java"));

        assertTrue(Files.exists(gen.resolve("Dto.java")));
        verify(build(pom), gen(DTO, gen, "Dto.java"));
    }

    /** A manifest an 8.1.0 pre-release wrote names the Maven execution, or nothing. The first
     *  build records owners and deletes nothing; the next one sweeps what nothing emits. */
    @Test
    public void manifestWithoutGeneratorOwners_firstBuildRecordsOwnersAndDeletesNothing() throws Exception {
        Path outDir = root.resolve("gen");
        Files.createDirectories(outDir);
        String body = "/** GENERATED */\npublic class X {}\n";
        Path kept = outDir.resolve("Kept.java");
        Path old = outDir.resolve("Old.java");
        Files.writeString(kept, body);
        Files.writeString(old, body);
        Path genState = root.resolve(".metaobjects").resolve(".gen-state");
        Files.createDirectories(genState);
        String hash = HashManifest.contentHash(body);
        Files.writeString(genState.resolve(".hashes.json"), "{\n"
                + "  \"gen/Kept.java\": { \"hash\": \"" + hash + "\", \"owner\": \"app:codegen\" },\n"
                + "  \"gen/Old.java\": { \"hash\": \"" + hash + "\", \"owner\": \"app:codegen\" }\n}\n");
        Path pom = pom(root, "app", "", plugin("codegen", generators(DTO, "${project.basedir}/gen")), "");

        generate(build(pom), "codegen", NO_PROFILES, gen(DTO, outDir, "Kept.java"));

        assertTrue("the build that records owners deletes nothing", Files.exists(old));
        assertTrue(HashManifest.loadOwners(genState).containsKey("gen/Kept.java"));

        generate(build(pom), "codegen", NO_PROFILES, gen(DTO, outDir, "Kept.java"));

        assertFalse("recorded in this run's directory, emitted by nothing", Files.exists(old));
        assertTrue(Files.exists(kept));
    }
}

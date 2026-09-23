package com.metaobjects.mojo;

import org.apache.maven.model.Dependency;
import org.apache.maven.plugin.MojoExecutionException;
import org.apache.maven.plugin.MojoFailureException;
import org.apache.maven.plugin.logging.Log;
import org.apache.maven.project.MavenProject;
import org.junit.Before;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import org.junit.Rule;
import org.mockito.ArgumentCaptor;
import org.mockito.Mockito;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

/**
 * End-to-end tests of {@code mvn metaobjects:eject} — the Maven-facing wrapper around
 * {@link EjectSupport}. Constructs {@link MetaDataEjectMojo} directly (same pattern as
 * {@link NeutralConfigMojoFallbackTest} / {@link UseNamesDerivationTest}: a mocked
 * {@link MavenProject}, package-private field assignment, no Maven container).
 */
public class MetaDataEjectMojoTest {

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

    private MetaDataEjectMojo mojo(String names, boolean force, String port, String pkg) {
        MetaDataEjectMojo m = new MetaDataEjectMojo();
        m.project = project;
        m.names = names;
        m.force = force;
        m.port = port;
        m.targetPackage = pkg;
        return m;
    }

    private Path codegenRoot() {
        return basedir.resolve("codegen");
    }

    // ------------------------------------------------------------------------------------
    // (d) refuse-overwrite / unknown-name
    // ------------------------------------------------------------------------------------

    @Test
    public void anUnknownNameFailsTheBuildAndWritesNothing() {
        MetaDataEjectMojo m = mojo("totally-bogus-name", false, null, null);
        try {
            m.execute();
            fail("expected MojoFailureException");
        } catch (MojoFailureException expected) {
            assertTrue(expected.getMessage().contains("totally-bogus-name"));
        } catch (MojoExecutionException e) {
            fail("expected MojoFailureException, got " + e);
        }
        assertFalse("nothing should be written on an unknown name",
                Files.exists(codegenRoot()));
    }

    @Test
    public void oneUnknownNameAmongValidOnesWritesNothingAtAll() {
        // dto is a real, unambiguous Java-only name — but the batch must still fail whole.
        MetaDataEjectMojo m = mojo("dto,totally-bogus-name", false, null, null);
        try {
            m.execute();
            fail("expected MojoFailureException");
        } catch (MojoFailureException expected) {
            // ok
        } catch (MojoExecutionException e) {
            fail("expected MojoFailureException, got " + e);
        }
        assertFalse(Files.exists(codegenRoot()));
    }

    @Test
    public void anAmbiguousNameWithNoPortHintFailsNamingBothPorts() {
        MetaDataEjectMojo m = mojo("names", false, null, null);
        try {
            m.execute();
            fail("expected MojoFailureException");
        } catch (MojoFailureException expected) {
            assertTrue(expected.getMessage().contains("-Dport"));
        } catch (MojoExecutionException e) {
            fail("expected MojoFailureException, got " + e);
        }
        assertFalse(Files.exists(codegenRoot()));
    }

    // ------------------------------------------------------------------------------------
    // (b)/(c) round trip: fresh eject, preserve without force, force overwrites an edit
    // ------------------------------------------------------------------------------------

    @Test
    public void ejectingAnUnambiguousJavaOnlyNameWritesTheFileAndAPom() throws Exception {
        MetaDataEjectMojo m = mojo("dto", false, null, null);
        m.execute();

        Path target = codegenRoot().resolve("src/main/java/com/acme/codegen/SpringDtoGenerator.java");
        assertTrue(Files.exists(target));
        String content = Files.readString(target, StandardCharsets.UTF_8);
        // Only the package DECLARATION is rewritten — a same-module import of a sibling
        // helper class (e.g. com.metaobjects.generator.spring.runtime.*) legitimately
        // stays, since that helper is not ejected and the copy still depends on it.
        assertTrue(content.startsWith("package com.acme.codegen;"));

        Path pom = codegenRoot().resolve("pom.xml");
        assertTrue(Files.exists(pom));
        String pomText = Files.readString(pom, StandardCharsets.UTF_8);
        assertTrue(pomText.contains("metaobjects-codegen-spring"));
        assertFalse("a java-only eject must not pull in the kotlin codegen dependency",
                pomText.contains("metaobjects-codegen-kotlin"));
        // A standalone module gets Maven's default -source 8, and the ejected copies use
        // Java 16+ syntax: without a release the unedited copy does not compile.
        assertTrue(pomText.contains("<maven.compiler.release>21</maven.compiler.release>"));
    }

    @Test
    public void ejectingTwiceWithoutForceLeavesTheFirstCopyUntouched() throws Exception {
        mojo("dto", false, null, null).execute();
        Path target = codegenRoot().resolve("src/main/java/com/acme/codegen/SpringDtoGenerator.java");
        Files.writeString(target, "// hand-edited, never touch me\n", StandardCharsets.UTF_8);

        mojo("dto", false, null, null).execute();

        assertEquals("// hand-edited, never touch me\n", Files.readString(target, StandardCharsets.UTF_8));
    }

    @Test
    public void forceReplacesAnEditedCopyWithTheReference() throws Exception {
        mojo("dto", false, null, null).execute();
        Path target = codegenRoot().resolve("src/main/java/com/acme/codegen/SpringDtoGenerator.java");
        Files.writeString(target, "// hand-edited, will be replaced\n", StandardCharsets.UTF_8);

        mojo("dto", true, null, null).execute();

        String content = Files.readString(target, StandardCharsets.UTF_8);
        assertTrue(content.startsWith("package com.acme.codegen;"));
        assertFalse(content.contains("hand-edited"));
    }

    @Test
    public void aSecondPomIsLeftUntouchedWithoutForce() throws Exception {
        mojo("dto", false, null, null).execute();
        Path pom = codegenRoot().resolve("pom.xml");
        String original = Files.readString(pom, StandardCharsets.UTF_8);
        Files.writeString(pom, original + "\n<!-- adopter edit -->\n", StandardCharsets.UTF_8);

        // Ejecting a SECOND, different name must not clobber the pom the adopter may have
        // started customizing (module name, extra deps), absent -Dforce.
        mojo("names", false, "java", null).execute();

        String after = Files.readString(pom, StandardCharsets.UTF_8);
        assertTrue(after.contains("<!-- adopter edit -->"));
    }

    // ------------------------------------------------------------------------------------
    // port resolution
    // ------------------------------------------------------------------------------------

    @Test
    public void anExplicitKotlinPortWritesUnderSrcMainKotlin() throws Exception {
        mojo("names", false, "kotlin", null).execute();
        Path target = codegenRoot().resolve("src/main/kotlin/com/acme/codegen/KotlinNamesGenerator.kt");
        assertTrue(Files.exists(target));
        String content = Files.readString(target, StandardCharsets.UTF_8);
        String firstLine = content.lines().findFirst().orElse("");
        assertEquals("package com.acme.codegen", firstLine);

        Path pom = codegenRoot().resolve("pom.xml");
        String pomText = Files.readString(pom, StandardCharsets.UTF_8);
        assertTrue(pomText.contains("metaobjects-codegen-kotlin"));
        assertTrue(pomText.contains("kotlin-maven-plugin"));
        // Outside a parent that manages it, a versionless plugin does not resolve, and
        // Kotlin's default JVM target is older than the jars the copy compiles against.
        assertTrue(pomText.contains("<version>" + kotlin.KotlinVersion.CURRENT + "</version>"));
        assertTrue(pomText.contains("<kotlin.compiler.jvmTarget>21</kotlin.compiler.jvmTarget>"));
    }

    @Test
    public void aDeclaredCodegenSpringDependencyInfersJavaForAnAmbiguousName() throws Exception {
        Dependency dep = new Dependency();
        dep.setGroupId("com.metaobjects");
        dep.setArtifactId("metaobjects-codegen-spring");
        Mockito.when(project.getDependencies()).thenReturn(List.of(dep));

        mojo("names", false, null, null).execute();

        assertTrue(Files.exists(
                codegenRoot().resolve("src/main/java/com/acme/codegen/SpringNamesGenerator.java")));
    }

    // ------------------------------------------------------------------------------------
    // -Dpackage override
    // ------------------------------------------------------------------------------------

    @Test
    public void anExplicitPackageOverridesTheGroupIdDefault() throws Exception {
        mojo("dto", false, null, "org.example.owned").execute();
        Path target = codegenRoot().resolve("src/main/java/org/example/owned/SpringDtoGenerator.java");
        assertTrue(Files.exists(target));
        assertTrue(Files.readString(target, StandardCharsets.UTF_8).startsWith("package org.example.owned;"));
    }

    // ------------------------------------------------------------------------------------
    // -Dlist
    // ------------------------------------------------------------------------------------

    @Test
    public void listPrintsTheCatalogHeaderAndWritesNothing() throws Exception {
        MetaDataEjectMojo m = mojo(null, false, null, null);
        m.list = true;
        Log log = Mockito.mock(Log.class);
        m.setLog(log);

        m.execute();

        ArgumentCaptor<CharSequence> captor = ArgumentCaptor.forClass(CharSequence.class);
        Mockito.verify(log).info(captor.capture());
        String out = captor.getValue().toString();
        assertTrue(out.contains("reference helper"));
        assertTrue(out.contains("eject"));
        assertTrue(out.contains("dto"));
        assertFalse(Files.exists(codegenRoot()));
    }

    @Test
    public void namesIsRequiredWhenNotListing() {
        MetaDataEjectMojo m = mojo(null, false, null, null);
        try {
            m.execute();
            fail("expected MojoFailureException");
        } catch (MojoFailureException expected) {
            assertTrue(expected.getMessage().contains("-Dnames"));
        } catch (MojoExecutionException e) {
            fail("expected MojoFailureException, got " + e);
        }
    }
}

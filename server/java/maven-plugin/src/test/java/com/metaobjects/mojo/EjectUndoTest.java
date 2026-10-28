package com.metaobjects.mojo;

import org.apache.maven.plugin.MojoFailureException;
import org.apache.maven.plugin.logging.Log;
import org.apache.maven.project.MavenProject;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import org.mockito.ArgumentCaptor;
import org.mockito.Mockito;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.stream.Collectors;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

/** {@code mvn metaobjects:eject -Dundo=true} and the {@code metaobjects:generate} notice. */
public class EjectUndoTest {

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

    private MetaDataEjectMojo mojo(String names) {
        MetaDataEjectMojo m = new MetaDataEjectMojo();
        m.project = project;
        m.names = names;
        return m;
    }

    private Log undo(String names, boolean force) throws Exception {
        MetaDataEjectMojo m = mojo(names);
        m.undo = true;
        m.force = force;
        Log log = Mockito.mock(Log.class);
        m.setLog(log);
        m.execute();
        return log;
    }

    private String logged(Log log) {
        ArgumentCaptor<CharSequence> c = ArgumentCaptor.forClass(CharSequence.class);
        Mockito.verify(log, Mockito.atLeast(0)).info(c.capture());
        return c.getAllValues().stream().map(CharSequence::toString).collect(Collectors.joining("\n"));
    }

    private Path ownedDto() {
        return basedir.resolve("codegen/src/main/java/com/acme/codegen/SpringDtoGenerator.java");
    }

    private void eject(String names) throws Exception {
        MetaDataEjectMojo m = mojo(names);
        m.port = "java";
        m.execute();
    }

    @Test
    public void withNoNamesRemovesEveryCopyIdenticalToTheShippedOneAndPrintsThePomEdit() throws Exception {
        eject("dto");
        assertTrue(Files.exists(ownedDto()));
        String out = logged(undo(null, false));
        assertFalse(Files.exists(ownedDto()));
        assertTrue(out, out.contains("<classname>com.acme.codegen.SpringDtoGenerator</classname>  ->  <classname>"
                + "com.metaobjects.generator.spring.SpringDtoGenerator</classname>"));
        assertTrue(out, out.contains("never edits pom.xml"));
        assertTrue("pom.xml of the adopter is not touched", !Files.exists(basedir.resolve("pom.xml")));
    }

    @Test
    public void withNoNamesAnEditedCopyStaysAndNothingIsRemoved() throws Exception {
        eject("dto");
        Files.writeString(ownedDto(), Files.readString(ownedDto()) + "\n// mine\n");
        logged(undo(null, false));
        assertTrue(Files.exists(ownedDto()));
    }

    @Test
    public void aNamedEditedCopyIsRefusedAndNothingIsRemovedEvenForAnIdenticalNameBesideIt() throws Exception {
        eject("dto,repository");
        Files.writeString(ownedDto(), Files.readString(ownedDto()) + "\n// mine\n");
        try {
            undo("repository,dto", false);
            fail("expected MojoFailureException");
        } catch (MojoFailureException expected) {
            assertTrue(expected.getMessage(), expected.getMessage().contains("\"dto\" differs from the shipped"));
        }
        assertTrue(Files.exists(ownedDto()));
        assertTrue(Files.exists(basedir.resolve("codegen/src/main/java/com/acme/codegen/SpringRepositoryGenerator.java")));
    }

    @Test
    public void forceRemovesANamedEditedCopy() throws Exception {
        eject("dto");
        Files.writeString(ownedDto(), Files.readString(ownedDto()) + "\n// mine\n");
        undo("dto", true);
        assertFalse(Files.exists(ownedDto()));
    }

    @Test
    public void anUnknownOrUnownedNameFailsTheWholeCall() throws Exception {
        eject("dto");
        try {
            undo("dto,bogus", false);
            fail("expected MojoFailureException");
        } catch (MojoFailureException expected) {
            assertTrue(expected.getMessage().contains("unknown generator \"bogus\""));
        }
        try {
            undo("dto,repository", false);
            fail("expected MojoFailureException");
        } catch (MojoFailureException expected) {
            assertTrue(expected.getMessage().contains("\"repository\" has no owned copy"));
        }
        assertTrue(Files.exists(ownedDto()));
    }

    @Test
    public void theGenerateNoticeNamesIdenticalCopiesAndStaysSilentOtherwise() throws Exception {
        assertNull(OwnedStock.notice(OwnedStock.find(basedir.resolve("codegen"),
                OwnedStock.classpath(getClass().getClassLoader()))));
        eject("dto");
        String line = OwnedStock.notice(OwnedStock.find(basedir.resolve("codegen"),
                OwnedStock.classpath(getClass().getClassLoader())));
        assertNotNull(line);
        assertTrue(line, line.contains("dto"));
        assertTrue(line, line.contains("mvn metaobjects:eject -Dundo=true"));
        Files.writeString(ownedDto(), Files.readString(ownedDto()) + "\n// mine\n");
        assertNull(OwnedStock.notice(OwnedStock.find(basedir.resolve("codegen"),
                OwnedStock.classpath(getClass().getClassLoader()))));
        assertEquals(1, OwnedStock.find(basedir.resolve("codegen"),
                OwnedStock.classpath(getClass().getClassLoader())).stream()
                .filter(c -> c.entry.stableName.equals("dto")).count());
    }
}

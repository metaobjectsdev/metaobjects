package com.metaobjects.mojo;

import org.apache.maven.model.Resource;
import org.apache.maven.project.MavenProject;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import org.mockito.ArgumentCaptor;
import org.mockito.Mockito;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.Assert.assertEquals;

/**
 * FR-023 S4 — {@code metaobjects:generate} ships the committed dependency lock and snapshot on the module's
 * classpath, so the Spring runtime can load them (see {@code MetaDataLoaderConfigurationDependenciesTest}).
 */
public class MetaDataGeneratorMojoDependencyResourcesTest {

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    private MetaDataGeneratorMojo mojo;
    private MavenProject project;

    @Before
    public void setUp() {
        mojo = new MetaDataGeneratorMojo();
        project = Mockito.mock(MavenProject.class);
        mojo.project = project;
    }

    @Test
    public void aProjectWithALockShipsItAndItsSnapshotUnderDotMetaobjects() throws Exception {
        Path configDir = tmp.newFolder().toPath();
        Files.createDirectories(configDir.resolve(".metaobjects"));
        Files.writeString(configDir.resolve(".metaobjects/deps.lock.json"), "{}");

        mojo.registerDependencySnapshotResources(configDir);

        ArgumentCaptor<Resource> added = ArgumentCaptor.forClass(Resource.class);
        Mockito.verify(project).addResource(added.capture());
        Resource r = added.getValue();
        assertEquals(configDir.resolve(".metaobjects").toAbsolutePath().normalize().toString(), r.getDirectory());
        assertEquals(".metaobjects", r.getTargetPath());
        assertEquals(List.of("deps.lock.json", "deps/**"), r.getIncludes());
    }

    @Test
    public void aProjectWithNoLockShipsNothing() throws Exception {
        mojo.registerDependencySnapshotResources(tmp.newFolder().toPath());

        Mockito.verify(project, Mockito.never()).addResource(Mockito.any());
    }

    @Test
    public void runningTwiceDoesNotAddTheResourceTwice() throws Exception {
        Path configDir = tmp.newFolder().toPath();
        Files.createDirectories(configDir.resolve(".metaobjects"));
        Files.writeString(configDir.resolve(".metaobjects/deps.lock.json"), "{}");
        Resource already = new Resource();
        already.setDirectory(configDir.resolve(".metaobjects").toAbsolutePath().normalize().toString());
        already.setTargetPath(".metaobjects");
        Mockito.when(project.getResources()).thenReturn(List.of(already));

        mojo.registerDependencySnapshotResources(configDir);

        Mockito.verify(project, Mockito.never()).addResource(Mockito.any());
    }
}

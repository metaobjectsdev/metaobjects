package com.metaobjects.mojo;

import com.metaobjects.loader.MetaDataLoader;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * {@code metaobjects:init} scaffolds a project with NO generator wired (ADR-0034 Amendment 2) and
 * never overwrites a file it finds. Documentation is an opt-in.
 */
public class InitMojoTest {

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    @Test
    public void writesTheNeutralConfigAndAnEmptyLoadableModel() throws Exception {
        Path root = tmp.newFolder().toPath();
        InitMojo.Result result = InitMojo.scaffold(root);

        assertEquals(java.util.List.of(InitMojo.CONFIG, InitMojo.METADATA), result.wrote());
        assertTrue(result.kept().isEmpty());
        String config = Files.readString(root.resolve(InitMojo.CONFIG));
        assertTrue(config, config.contains("\"defaultLimit\": 50"));
        assertTrue(config, config.contains("\"unknownFields\": \"reject\""));
        assertTrue(config, config.contains("\"handEdits\": \"fail\""));
        assertTrue(config, config.contains("\"foreignKeyIndexes\": true"));
        assertEquals(InitMojo.EMPTY_METADATA, Files.readString(root.resolve(InitMojo.METADATA)));
    }

    @Test
    public void theEmptyModelLoadsAndTheConfigIsValidJson() throws Exception {
        Path root = tmp.newFolder().toPath();
        InitMojo.scaffold(root);
        new com.google.gson.Gson().fromJson(Files.readString(root.resolve(InitMojo.CONFIG)), Object.class);
        com.metaobjects.registry.RegistryBootstrap.warmUpDefaults();
        MetaDataLoader loader = new MetaDataLoader("init-test");
        loader.setSourceURIs(java.util.List.of(
            com.metaobjects.loader.uri.URIHelper.toURI("model:file:" + root.resolve(InitMojo.METADATA).toAbsolutePath())));
        loader.init();
        assertTrue(loader.getChildren(com.metaobjects.object.MetaObject.class, false).isEmpty());
    }

    @Test
    public void neverOverwritesAFileItFinds() throws Exception {
        Path root = tmp.newFolder().toPath();
        Path config = root.resolve(InitMojo.CONFIG);
        Files.createDirectories(config.getParent());
        Files.writeString(config, "{ \"mine\": true }\n");

        InitMojo.Result result = InitMojo.scaffold(root);

        assertEquals(java.util.List.of(InitMojo.CONFIG), result.kept());
        assertEquals(java.util.List.of(InitMojo.METADATA), result.wrote());
        assertEquals("{ \"mine\": true }\n", Files.readString(config));
    }

    @Test
    public void aSecondRunChangesNothing() throws Exception {
        Path root = tmp.newFolder().toPath();
        InitMojo.scaffold(root);
        String before = Files.readString(root.resolve(InitMojo.CONFIG)) + Files.readString(root.resolve(InitMojo.METADATA));
        InitMojo.Result second = InitMojo.scaffold(root);
        assertTrue(second.wrote().isEmpty());
        assertEquals(2, second.kept().size());
        assertEquals(before, Files.readString(root.resolve(InitMojo.CONFIG)) + Files.readString(root.resolve(InitMojo.METADATA)));
    }

    @Test
    public void thePrintedEntryWiresNoGeneratorUnlessDocsAreAskedFor() {
        String plain = InitMojo.pluginEntry("8.3.0", false);
        assertTrue(plain, plain.contains("<generators/>"));
        assertFalse(plain, plain.contains("<generator>"));
        assertFalse(plain, plain.contains("ApiDocs"));

        String docs = InitMojo.pluginEntry("8.3.0", true);
        assertTrue(docs, docs.contains("com.metaobjects.generator.apidocs.JavaApiDocsGenerator"));
        assertFalse(docs, docs.contains("<generators/>"));
    }
}

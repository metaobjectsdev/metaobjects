package com.metaobjects.generator.mustache;

import com.metaobjects.loader.simple.SimpleLoader;
import com.metaobjects.loader.uri.URIHelper;
import com.metaobjects.registry.SharedRegistryTestBase;
import org.junit.Before;
import org.junit.Test;
import org.junit.Rule;
import org.junit.rules.TemporaryFolder;
import static org.junit.Assert.*;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.util.HashMap;
import java.util.Map;
import java.util.Arrays;

/**
 * Tests for ValueObject template generation that were moved from metaobjects-core.
 * These tests require ValueObject classes that are only available in the dynamic module.
 */
public class ValueObjectTemplateGeneratorTest extends SharedRegistryTestBase {

    @Rule
    public TemporaryFolder tempFolder = new TemporaryFolder();

    private MustacheTemplateGenerator generator;
    private SimpleLoader loader;
    private File outputDir;

    @Before
    public void setUp() throws Exception {
        generator = new MustacheTemplateGenerator();

        // Create and initialize loader
        loader = new SimpleLoader("test-loader");
        loader.setSourceURIs(Arrays.asList(
            URIHelper.toURI("model:resource:mustache-test-metadata.json")
        ));
        loader.init();

        outputDir = tempFolder.newFolder("generated");
    }

    @Test
    public void testGenerateValueObjectExtension() throws Exception {
        // Set ValueObject template
        Map<String, String> args = new HashMap<>();
        args.put(MustacheTemplateGenerator.PARAM_TEMPLATE_PATH, "templates/");
        args.put(MustacheTemplateGenerator.PARAM_OUTPUT_DIR, outputDir.getAbsolutePath());
        args.put(MustacheTemplateGenerator.PARAM_TARGET_LANGUAGE, "java");
        args.put(MustacheTemplateGenerator.PARAM_TEMPLATE_NAME, "valueobject-extension");

        generator.setArgs(args);
        generator.execute(loader);

        // Verify User.java was generated with ValueObject extension
        File userFile = new File(outputDir, "com_example_model/User.java");
        assertTrue("User.java should be generated", userFile.exists());

        String content = Files.readString(userFile.toPath());
        assertTrue("Should extend ValueObject", content.contains("extends ValueObject"));
        assertTrue("Should have META_OBJECT_NAME", content.contains("META_OBJECT_NAME"));
        assertTrue("Should have dynamic getters", content.contains("getAttrValue(\"username\")"));
        assertTrue("Should have dynamic setters", content.contains("setAttrValue(\"username\""));
        assertTrue("Should have fluent methods", content.contains("username(String username)"));
        assertTrue("Should have has methods", content.contains("hasUsername()"));
        assertTrue("Should have copy method", content.contains("copy()"));
        assertTrue("Should have newInstance method", content.contains("newInstance()"));
    }
}
package com.metaobjects.mojo;

import com.metaobjects.generator.kotlin.KotlinEntityGenerator;
import org.apache.maven.plugin.MojoFailureException;
import org.junit.Before;
import org.junit.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Collections;
import java.util.List;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

/**
 * ADR-0019 Amendment 2: committed output generated under another {@code wire} setting is not
 * "stale". Regenerating would change the JSON the API writes, so {@code verify} names the
 * {@code wire} block that reproduces the committed output instead.
 */
public class MetaDataVerifyWireTest {

    private static final String METADATA = """
        { "metadata.root": { "package": "acme", "children": [
          { "object.value": { "name": "Price", "children": [
            { "field.decimal": { "name": "net", "@precision": 12, "@scale": 2 } },
            { "field.string": { "name": "note" } }
          ]}},
          { "object.entity": { "name": "Item", "children": [
            { "source.rdb": { "@table": "items" } },
            { "field.long": { "name": "id" } },
            { "field.decimal": { "name": "amount", "@precision": 10, "@scale": 2 } },
            { "field.object": { "name": "price", "@objectRef": "Price", "@storage": "jsonb" } },
            { "identity.primary": { "@fields": "id" } }
          ]}}
        ]}}
        """;

    private Path project;
    private Path outDir;

    @Before
    public void setUp() throws Exception {
        project = Files.createTempDirectory("verify-wire");
        Files.writeString(project.resolve("meta.acme.json"), METADATA, StandardCharsets.UTF_8);
        outDir = project.resolve("generated");
    }

    private void writeWire(String wire) throws Exception {
        Path cfg = project.resolve(".metaobjects");
        Files.createDirectories(cfg);
        String body = wire == null ? "{ \"schema_version\": 1 }"
                : "{ \"schema_version\": 1, \"wire\": { " + wire + " } }";
        Files.writeString(cfg.resolve("config.json"), body, StandardCharsets.UTF_8);
    }

    private void configure(AbstractMetaDataMojo mojo) {
        mojo.setLoader(LoaderParam.builder("verify-wire")
                .withClassname("com.metaobjects.loader.MetaDataLoader")
                .withSourceDir(project.toString())
                .withSource("meta.acme.json")
                .build());
        mojo.setGenerators(List.of(GeneratorParam.builder(KotlinEntityGenerator.class.getName())
                .withArg("outputDir", outDir.toString()).build()));
        mojo.setGlobals(Collections.emptyMap());
    }

    private void generate() throws Exception {
        MetaDataGeneratorMojo gen = new MetaDataGeneratorMojo();
        configure(gen);
        gen.execute();
    }

    @Test
    public void verifyNamesTheWireSettingTheCommittedOutputWasGeneratedWith() throws Exception {
        writeWire("\"decimals\": \"string\", \"nullMembers\": \"omit\"");
        generate();

        writeWire(null);
        MetaDataVerifyMojo verify = new MetaDataVerifyMojo();
        configure(verify);
        try {
            verify.execute();
            fail("expected verify to fail under the default setting");
        } catch (MojoFailureException e) {
            String msg = e.getMessage();
            assertTrue(msg, msg.contains("The committed output was generated with "
                    + "\"wire\": { \"decimals\": \"string\", \"nullMembers\": \"omit\" }; this run used "
                    + "\"wire\": { \"decimals\": \"native\", \"nullMembers\": \"native\" }"));
            assertTrue(msg, msg.contains("Do not regenerate"));
            assertFalse(msg, msg.contains("generated code is stale"));
        }
    }

    @Test
    public void verifyPassesWhenTheSettingMatches() throws Exception {
        writeWire("\"decimals\": \"string\"");
        generate();
        MetaDataVerifyMojo verify = new MetaDataVerifyMojo();
        configure(verify);
        verify.execute();
    }

    @Test
    public void aHandEditIsStillReportedAsStale() throws Exception {
        generate();
        Path item;
        try (var s = Files.walk(outDir)) {
            item = s.filter(p -> p.getFileName().toString().equals("Item.kt")).findFirst().orElseThrow();
        }
        Files.writeString(item, "// HAND-EDITED\n", StandardCharsets.UTF_8);
        MetaDataVerifyMojo verify = new MetaDataVerifyMojo();
        configure(verify);
        try {
            verify.execute();
            fail("expected drift");
        } catch (MojoFailureException e) {
            assertTrue(e.getMessage(), e.getMessage().contains("generated code is stale"));
        }
    }
}

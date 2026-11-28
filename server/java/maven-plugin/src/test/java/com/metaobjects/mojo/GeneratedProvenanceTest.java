package com.metaobjects.mojo;

import com.metaobjects.generator.direct.object.javacode.JavaObjectCodeGenerator;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.metaobjects.generator.util.HashManifest;
import org.apache.maven.project.MavenProject;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import org.mockito.Mockito;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.TreeSet;
import java.util.stream.Stream;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/** Generated-file provenance, end to end: a per-object file names its generator and node; a whole-model file names neither. */
public class GeneratedProvenanceTest {

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    private Path module;

    private MetaDataGeneratorMojo generate() throws Exception {
        return generate("");
    }

    private MetaDataGeneratorMojo generate(String extraChildren) throws Exception {
        module = tmp.getRoot().toPath().resolve("module");
        Files.createDirectories(module.resolve("metaobjects"));
        Files.writeString(module.resolve("metaobjects/meta.shop.json"), """
                {"metadata.root": {"package": "acme::shop", "children": [
                  {"object.entity": {"name": "Order", "children": [ {"field.long": {"name": "id"}} ]}}EXTRA
                ]}}
                """.replace("EXTRA", extraChildren));
        Files.writeString(module.resolve("metaobjects/meta.crm.json"), """
                {"metadata.root": {"package": "acme::crm", "children": [
                  {"object.entity": {"name": "Customer", "children": [ {"field.long": {"name": "id"}} ]}}
                ]}}
                """);
        MetaDataGeneratorMojo mojo = new MetaDataGeneratorMojo();
        MavenProject project = Mockito.mock(MavenProject.class);
        Mockito.when(project.getBasedir()).thenReturn(module.toFile());
        mojo.project = project;
        mojo.setLoader(LoaderParam.builder("per-package")
                .withClassname("com.metaobjects.loader.MetaDataLoader")
                .withSourceDir(module.resolve("metaobjects").toString())
                .build());
        mojo.setGenerators(new ArrayList<>(List.of(
                GeneratorParam.builder(JavaObjectCodeGenerator.class.getName())
                        .withArg("outputDir", "generated").withArg("type", "class").withArg("flavor", "pojoAware").build(),
                GeneratorParam.builder(com.metaobjects.generator.spring.SpringValueObjectGenerator.class.getName())
                        .withArg("outputDir", "generated-dto").build(),
                GeneratorParam.builder(com.metaobjects.generator.spring.SpringDtoGenerator.class.getName())
                        .withArg("outputDir", "generated-dto").build())));
        mojo.setGlobals(java.util.Collections.emptyMap());
        return mojo;
    }

    private JsonObject entry(String pkgFile, String keySuffix) throws Exception {
        Path file = module.resolve(".metaobjects/.gen-state/.hashes").resolve(pkgFile);
        JsonObject all = JsonParser.parseString(Files.readString(file)).getAsJsonObject();
        for (String key : all.keySet()) {
            if (key.endsWith(keySuffix)) {
                JsonElement e = all.get(key);
                assertTrue(key + " is an object entry: " + e, e.isJsonObject());
                return e.getAsJsonObject();
            }
        }
        throw new AssertionError("no " + keySuffix + " in " + all.keySet());
    }

    @Test
    public void aPerObjectFileNamesItsGeneratorAndNodeAndAWholeModelFileDoesNot() throws Exception {
        generate().execute();

        JsonObject order = entry("acme.shop.json", "acme/shop/Order.java");
        assertEquals(List.of("hash", "generator", "outputDir", "generatedBy", "sourceNode"),
                new ArrayList<>(order.keySet()));
        assertEquals("acme::shop::Order", order.get("sourceNode").getAsString());
        assertEquals("java:" + order.get("generatedBy").getAsString(), order.get("generator").getAsString());
        assertEquals("acme::crm::Customer", entry("acme.crm.json", "acme/crm/Customer.java").get("sourceNode").getAsString());

        // The DTO generator's file is stamped through its own write path, under its own name.
        JsonObject dto = entry("acme.shop.json", "OrderDto.java");
        assertEquals("acme::shop::Order", dto.get("sourceNode").getAsString());
        assertEquals("dto", dto.get("generatedBy").getAsString());
        assertEquals("java:dto", dto.get("generator").getAsString());

        // The META-INF/services file is rendered from the whole model: no provenance fields.
        Path dir = module.resolve(".metaobjects/.gen-state/.hashes");
        for (Path p : Files.list(dir).toList()) {
            JsonObject all = JsonParser.parseString(Files.readString(p)).getAsJsonObject();
            for (String key : all.keySet()) {
                if (key.contains("META-INF")) {
                    assertFalse(key, all.get(key).isJsonObject() && all.get(key).getAsJsonObject().has("sourceNode"));
                }
            }
        }
    }

    @Test
    public void theTraceHelperTemplateAndMustacheGeneratorsStampEachPerObjectFile() throws Exception {
        module = tmp.getRoot().toPath().resolve("module");
        Files.createDirectories(module.resolve("metaobjects"));
        Files.writeString(module.resolve("metaobjects/meta.shop.json"), """
                {"metadata.root": {"package": "acme::shop", "children": [
                  {"object.value": {"name": "GreetRequest", "children": [ {"field.string": {"name": "name"}} ]}},
                  {"object.value": {"name": "GreetResponse", "children": [ {"field.string": {"name": "greeting"}} ]}},
                  {"object.entity": {"name": "GreetingCall", "extends": "metaobjects::ai::LlmCallBase", "children": [
                    {"source.rdb": {"@table": "greeting_call", "@role": "primary"}},
                    {"identity.primary": {"name": "pk", "@fields": ["spanId"]}},
                    {"template.prompt": {"name": "greetingPrompt",
                      "@payloadRef": "acme::shop::GreetRequest", "@responseRef": "acme::shop::GreetResponse"}} ]}}
                ]}}
                """);
        Files.createDirectories(module.resolve("templates"));
        Files.writeString(module.resolve("templates/one.mustache"), "{{name}}\n");
        Files.writeString(module.resolve("templates/all.mustache"), "model\n");
        Files.writeString(module.resolve("templates/names.mustache.yaml"), """
                name: "Names"
                version: "1.0.0"
                targetLanguage: "java"
                outputFileExtension: "txt"
                packagePath: false
                template: |
                  {{className}}
                """);
        MetaDataGeneratorMojo mojo = new MetaDataGeneratorMojo();
        MavenProject project = Mockito.mock(MavenProject.class);
        Mockito.when(project.getBasedir()).thenReturn(module.toFile());
        mojo.project = project;
        LoaderParam loader = LoaderParam.builder("per-object")
                .withClassname("com.metaobjects.loader.MetaDataLoader")
                .withSourceDir(module.resolve("metaobjects").toString())
                .build();
        loader.setLibraries(List.of("ai"));
        mojo.setLoader(loader);
        mojo.setGenerators(new ArrayList<>(List.of(
                GeneratorParam.builder(com.metaobjects.generator.spring.LlmTraceHelperGenerator.class.getName())
                        .withArg("outputDir", "generated-trace").build(),
                GeneratorParam.builder(com.metaobjects.generator.template.TemplateScopeGenerator.class.getName())
                        .withArg("outputDir", "generated-template").withArg("templatesDir", "templates")
                        .withArg("template", "one").withArg("scope", "perEntity")
                        .withArg("outputPattern", "{Name}.txt").build(),
                GeneratorParam.builder(com.metaobjects.generator.template.TemplateScopeGenerator.class.getName())
                        .withArg("outputDir", "generated-template").withArg("templatesDir", "templates")
                        .withArg("template", "all").withArg("scope", "perModel")
                        .withArg("outputPattern", "model.txt").build(),
                GeneratorParam.builder(com.metaobjects.generator.mustache.MustacheTemplateGenerator.class.getName())
                        .withArg("outputDir", module.resolve("generated-mustache").toString())
                        .withArg("templatePath", module.resolve("templates").toString())
                        .withArg("templateName", "names").build())));
        mojo.setGlobals(java.util.Collections.emptyMap());
        mojo.execute();

        assertEquals("acme::shop::GreetingCall",
                entry("acme.shop.json", "acme/shop/GreetingCallTraceHelper.java").get("sourceNode").getAsString());
        assertEquals("acme::shop::GreetingCall",
                entry("acme.shop.json", "generated-template/GreetingCall.txt").get("sourceNode").getAsString());
        assertEquals("acme::shop::GreetRequest",
                entry("acme.shop.json", "generated-mustache/GreetRequest.txt").get("sourceNode").getAsString());
        assertEquals("acme::shop::GreetingCall",
                entry("acme.shop.json", "generated-mustache/GreetingCall.txt").get("sourceNode").getAsString());

        // The per-model template file is rendered from the whole model: no sourceNode.
        Path dir = module.resolve(".metaobjects/.gen-state/.hashes");
        boolean seen = false;
        for (Path p : Files.list(dir).toList()) {
            JsonObject all = JsonParser.parseString(Files.readString(p)).getAsJsonObject();
            for (String key : all.keySet()) {
                if (key.endsWith("generated-template/model.txt")) {
                    seen = true;
                    assertFalse(key, all.get(key).isJsonObject() && all.get(key).getAsJsonObject().has("sourceNode"));
                }
            }
        }
        assertTrue("the per-model template file is recorded", seen);
    }

    @Test
    public void aSecondRunWritesNoManifestFile() throws Exception {
        generate().execute();
        Path dir = module.resolve(".metaobjects/.gen-state/.hashes");
        List<Path> files = Files.list(dir).toList();
        for (Path p : files) Files.setLastModifiedTime(p, java.nio.file.attribute.FileTime.fromMillis(1_000_000_000_000L));
        generate().execute();
        for (Path p : files) {
            assertEquals(p.toString(), 1_000_000_000_000L, Files.getLastModifiedTime(p).toMillis());
        }
    }
}

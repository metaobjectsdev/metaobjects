package com.metaobjects.mojo;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.metaobjects.generator.DocsSiteGenerator;
import com.metaobjects.generator.direct.object.javacode.JavaObjectCodeGenerator;
import com.metaobjects.generator.spring.SpringDtoGenerator;
import com.metaobjects.generator.spring.SpringValueObjectGenerator;
import com.metaobjects.generator.util.HashManifest;
import org.apache.maven.project.MavenProject;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import org.mockito.Mockito;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * ADR-0064 and the docs site: the site lists the files the module's other executions recorded in
 * the shared hash manifest, so an unchanged build skips it, and a build in which another execution
 * stops generating files runs it again and drops those files from the site.
 */
public class DocsSiteSkipTest {

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    private Path module;
    private Path engine;
    private boolean skipped;
    // Every execution the module configures, as the orphan sweep reads the POM.
    private final List<List<GeneratorParam>> executions = new ArrayList<>();

    @Before
    public void setUp() throws Exception {
        module = tmp.getRoot().toPath().resolve("module");
        engine = tmp.newFolder("engine").toPath();
        Files.writeString(engine.resolve("engine.class"), "v1");
        Files.createDirectories(module.resolve("metaobjects"));
        Files.writeString(module.resolve("metaobjects/meta.shop.json"), """
                {"metadata.root": {"package": "acme::shop", "children": [
                  {"object.entity": {"name": "Order", "children": [ {"field.long": {"name": "id"}} ]}}
                ]}}
                """);
    }

    private GeneratorParam entity() {
        return GeneratorParam.builder(JavaObjectCodeGenerator.class.getName())
                .withArg("outputDir", "generated").withArg("type", "class").withArg("flavor", "pojoAware").build();
    }

    private List<GeneratorParam> dto() {
        return List.of(
                GeneratorParam.builder(SpringValueObjectGenerator.class.getName()).withArg("outputDir", "generated-dto").build(),
                GeneratorParam.builder(SpringDtoGenerator.class.getName()).withArg("outputDir", "generated-dto").build());
    }

    private static List<GeneratorParam> list(Object... items) {
        List<GeneratorParam> out = new ArrayList<>();
        for (Object item : items) {
            if (item instanceof GeneratorParam g) out.add(g);
            else for (Object g : (List<?>) item) out.add((GeneratorParam) g);
        }
        return out;
    }

    private GeneratorParam docsSite() {
        return GeneratorParam.builder(DocsSiteGenerator.class.getName())
                .withArg("outputDir", "docs").withArg("title", "Shop").build();
    }

    /** Run {@code generate} with {@code gens}; whether it skipped is left in {@link #skipped}. */
    private void generate(List<GeneratorParam> gens) throws Exception {
        skipped = false;
        MetaDataGeneratorMojo mojo = new MetaDataGeneratorMojo() {
            @Override
            protected List<Path> engineClasspath() {
                return List.of(engine);
            }

            @Override
            protected void onWholeRunSkipped() {
                skipped = true;
                super.onWholeRunSkipped();
            }

            @Override
            protected Set<HashManifest.Owner> configuredOwners() {
                Set<HashManifest.Owner> owners = new HashSet<>();
                for (List<GeneratorParam> execution : executions) {
                    for (GeneratorParam g : execution) owners.add(ownerOf(g));
                }
                return owners;
            }
        };
        MavenProject project = Mockito.mock(MavenProject.class);
        Mockito.when(project.getBasedir()).thenReturn(module.toFile());
        mojo.project = project;
        mojo.setLoader(LoaderParam.builder("docs-skip")
                .withClassname("com.metaobjects.loader.MetaDataLoader")
                .withSourceDir(module.resolve("metaobjects").toString())
                .build());
        mojo.setGenerators(new ArrayList<>(gens));
        mojo.setGlobals(Collections.emptyMap());
        mojo.execute();
    }

    /** The {@code generatedBy} names the site lists files under for {@code Order}. */
    private Set<String> orderFilesListedBy() throws Exception {
        JsonObject found = find(JsonParser.parseString(Files.readString(module.resolve("docs/site/explorer.json"))));
        assertTrue("explorer.json has the Order node", found != null);
        Set<String> by = new HashSet<>();
        for (JsonElement g : found.getAsJsonArray("files")) by.add(g.getAsJsonObject().get("generatedBy").getAsString());
        return by;
    }

    private static JsonObject find(JsonElement e) {
        if (e.isJsonObject()) {
            JsonObject o = e.getAsJsonObject();
            if (o.has("files") && o.has("name") && "Order".equals(o.get("name").getAsString())) return o;
            for (String k : o.keySet()) {
                JsonObject f = find(o.get(k));
                if (f != null) return f;
            }
        } else if (e.isJsonArray()) {
            for (JsonElement c : e.getAsJsonArray()) {
                JsonObject f = find(c);
                if (f != null) return f;
            }
        }
        return null;
    }

    @Test
    public void anUnchangedSecondRunWithDocsSiteSkips() throws Exception {
        List<GeneratorParam> all = list(docsSite(), entity(), dto());
        executions.add(all);
        generate(all);
        assertFalse(skipped);
        generate(all);
        assertTrue("nothing changed: the second run skips", skipped);
    }

    @Test
    public void twoExecutionsSharingTheManifestSettleAndSkip() throws Exception {
        List<GeneratorParam> a = list(entity(), dto());
        List<GeneratorParam> b = List.of(docsSite());
        executions.add(a);
        executions.add(b);
        generate(a);
        generate(b);
        assertTrue(orderFilesListedBy().contains("dto"));

        // A's first fingerprint predates B's files, so A runs once more; B's does not.
        generate(a);
        generate(b);
        assertTrue("the docs-site execution skips an unchanged build", skipped);

        generate(a);
        assertTrue("the generating execution skips once settled", skipped);
        generate(b);
        assertTrue("the docs-site execution still skips", skipped);
    }

    @Test
    public void aGeneratorAnotherExecutionDropsLeavesTheSite() throws Exception {
        List<GeneratorParam> a = list(entity(), dto());
        List<GeneratorParam> b = List.of(docsSite());
        executions.add(a);
        executions.add(b);
        for (int i = 0; i < 2; i++) {
            generate(a);
            generate(b);
        }
        assertTrue(skipped);
        assertTrue(orderFilesListedBy().contains("dto"));

        // The module stops configuring the DTO generators: A sweeps their files and records.
        a.subList(1, a.size()).clear();
        generate(a);
        assertFalse(skipped);
        assertFalse("the DTO files are swept", HashManifest.load(module.resolve(".metaobjects/.gen-state"))
                .keySet().stream().anyMatch(k -> k.startsWith("generated-dto/")));

        generate(b);
        assertFalse("the manifest lost files the site lists: the docs-site execution runs", skipped);
        assertFalse("the site no longer lists the DTO files", orderFilesListedBy().contains("dto"));
        assertTrue(orderFilesListedBy().contains("entity"));
    }
}

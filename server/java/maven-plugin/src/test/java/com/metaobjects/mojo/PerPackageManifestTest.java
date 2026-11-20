package com.metaobjects.mojo;

import com.metaobjects.generator.direct.object.javacode.JavaObjectCodeGenerator;
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

/** ADR-0064 Amendment 1, end to end: a gen over a two-package model writes one manifest file per package. */
public class PerPackageManifestTest {

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    private Path module;

    private MetaDataGeneratorMojo generate() throws Exception {
        module = tmp.getRoot().toPath().resolve("module");
        Files.createDirectories(module.resolve("metaobjects"));
        Files.writeString(module.resolve("metaobjects/meta.shop.json"), """
                {"metadata.root": {"package": "acme::shop", "children": [
                  {"object.entity": {"name": "Order", "children": [ {"field.long": {"name": "id"}} ]}}
                ]}}
                """);
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
        mojo.setGenerators(new ArrayList<>(List.of(GeneratorParam.builder(JavaObjectCodeGenerator.class.getName())
                .withArg("outputDir", "generated").withArg("type", "class").withArg("flavor", "pojoAware").build())));
        mojo.setGlobals(java.util.Collections.emptyMap());
        return mojo;
    }

    private List<String> manifestFiles() throws Exception {
        try (Stream<Path> s = Files.list(module.resolve(".metaobjects/.gen-state/.hashes"))) {
            return s.map(p -> p.getFileName().toString()).sorted().toList();
        }
    }

    @Test
    public void aMultiPackageModelWritesOneManifestPerPackageAndARootOne() throws Exception {
        generate().execute();

        assertEquals(List.of(".root.json", "acme.crm.json", "acme.shop.json"), manifestFiles());
        Path dir = module.resolve(".metaobjects/.gen-state/.hashes");
        assertTrue(Files.readString(dir.resolve("acme.shop.json")).contains("Order.java"));
        assertFalse(Files.readString(dir.resolve("acme.shop.json")).contains("Customer.java"));
        assertTrue(Files.readString(dir.resolve("acme.crm.json")).contains("Customer.java"));
        assertFalse(Files.exists(module.resolve(".metaobjects/.gen-state/.hashes.json")));
        // Every path is still found through the one flat reader.
        assertEquals(new TreeSet<>(List.of("generated/acme/shop/Order.java", "generated/acme/crm/Customer.java")),
                new TreeSet<>(HashManifest.load(module.resolve(".metaobjects/.gen-state")).keySet().stream()
                        .filter(k -> k.endsWith("Order.java") || k.endsWith("Customer.java")).toList()));
    }
}

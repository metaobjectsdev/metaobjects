package com.metaobjects.generator.apidocs;

import com.metaobjects.generator.GeneratorException;
import com.metaobjects.loader.InMemoryStringSource;
import com.metaobjects.loader.LoaderOptions;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.loader.MetaDataSource;
import com.metaobjects.registry.ObjectClassRegistry;
import org.junit.After;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;
import java.util.stream.Stream;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

/**
 * The api reference is keyed by package by default: a page sits under its package path, so two
 * same-named nodes in two packages (a layered model's {@code enterprise::party::Address} beside
 * {@code core::common::Address}) are two pages, and the index tells them apart by Java package. Two names in ONE
 * package that differ only in case ({@code ProductNdc}, {@code ProductNDC}) are one file on a
 * case-insensitive filesystem, so they are refused by name, in either layout.
 */
public class JavaApiDocsPackageKeyedTest {

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    @After
    public void resetRegistry() {
        ObjectClassRegistry.resetGlobal();
    }

    private static String entity(String pkg, String name) {
        return "{ \"metadata.root\": { \"package\": \"" + pkg + "\", \"children\": [\n"
            + "  { \"object.entity\": { \"name\": \"" + name + "\", \"children\": [\n"
            + "    { \"source.rdb\": { \"@table\": \"t_" + name.toLowerCase() + "_" + pkg.replace("::", "_") + "\" } },\n"
            + "    { \"field.long\": { \"name\": \"id\" } },\n"
            + "    { \"identity.primary\": { \"@fields\": \"id\", \"@generation\": \"increment\" } }\n"
            + "  ] } }\n] } }";
    }

    private Map<String, String> pages(Map<String, String> args, String[]... nodes) throws IOException {
        List<MetaDataSource> sources = new ArrayList<>();
        for (int i = 0; i < nodes.length; i++) {
            sources.add(new InMemoryStringSource(entity(nodes[i][0], nodes[i][1]), "docs/src" + i + ".json"));
        }
        MetaDataLoader loader = new MetaDataLoader(
            LoaderOptions.create(false, false, true), MetaDataLoader.SUBTYPE_MANUAL, "package-keyed");
        loader.init();
        loader.load(sources);
        Path out = tmp.newFolder().toPath();
        Map<String, String> all = new java.util.HashMap<>(args);
        all.put("outputDir", out.toString());
        JavaApiDocsGenerator generator = new JavaApiDocsGenerator();
        generator.setArgs(all);
        generator.execute(loader);
        try (Stream<Path> files = Files.walk(out)) {
            return files.filter(Files::isRegularFile).collect(Collectors.toMap(
                p -> out.relativize(p).toString().replace('\\', '/'),
                p -> { try { return Files.readString(p); } catch (IOException e) { throw new RuntimeException(e); } }));
        }
    }

    @Test
    public void twoSameNamedNodesInTwoPackagesAreTwoPagesTheIndexTellsApart() throws IOException {
        Map<String, String> files = pages(Map.of(),
            new String[]{"enterprise::party", "Address"}, new String[]{"core::common", "Address"});
        assertTrue(files.keySet().toString(), files.containsKey("api/java/enterprise/party/Address.md"));
        assertTrue(files.keySet().toString(), files.containsKey("api/java/core/common/Address.md"));
        String index = files.get("api/java/README.md");
        assertTrue(index, index.contains("[Address (core.common)](./core/common/Address.md)"));
        assertTrue(index, index.contains("[Address (enterprise.party)](./enterprise/party/Address.md)"));
    }

    @Test
    public void aUniqueShortNameKeepsItsBareLabel() throws IOException {
        String index = pages(Map.of(), new String[]{"acme::shop", "Cart"}).get("api/java/README.md");
        assertTrue(index, index.contains("[Cart](./acme/shop/Cart.md)"));
    }

    @Test
    public void namesThatDifferOnlyInCaseInOnePackageAreRefused() {
        for (String layout : new String[]{"package", "flat"}) {
            GeneratorException ex = assertThrows(GeneratorException.class, () -> pages(Map.of("layout", layout),
                new String[]{"acme::products", "ProductNdc"}, new String[]{"acme::products", "ProductNDC"}));
            assertTrue(ex.getMessage(), ex.getMessage().contains("acme.products.ProductNdc"));
            assertTrue(ex.getMessage(), ex.getMessage().contains("acme.products.ProductNDC"));
            assertTrue(ex.getMessage(), ex.getMessage().contains("case-insensitive"));
        }
    }

    @Test
    public void anExplicitFlatLayoutIsStillHonoured() throws IOException {
        Map<String, String> files = pages(Map.of("layout", "flat"), new String[]{"acme::shop", "Cart"});
        assertEquals(List.of("api/java/AGENT-API.md", "api/java/Cart.md", "api/java/README.md"),
            files.keySet().stream().sorted().collect(Collectors.toList()));
    }
}

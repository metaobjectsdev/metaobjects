package com.metaobjects.generator.spring;

import com.metaobjects.generator.Generator;
import com.metaobjects.generator.direct.object.javacode.JavaObjectCodeGenerator;
import com.metaobjects.generator.util.GeneratedFileWriter;
import com.metaobjects.loader.LoaderOptions;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.registry.SharedRegistryTestBase;
import com.metaobjects.loader.uri.URIHelper;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

/**
 * GitHub #546 (Java lane): generated output paths follow the object's METADATA package, so two
 * same-named entities (and two same-named value objects) in two packages generate two files each,
 * every reference resolves to its own package's type, and the whole tree compiles. Two DIFFERENT
 * metadata packages that would land in one Java package directory are refused by
 * {@code RouteNaming}'s sibling {@code OutputPackageCollisions} before any file is written.
 */
public class PackageKeyedOutputTest extends SharedRegistryTestBase {

    @Rule
    public TemporaryFolder tempFolder = new TemporaryFolder();

    private static String model(String pkg) {
        return "{ \"metadata.root\": { \"package\": \"" + pkg + "\", \"children\": [\n"
            + "  { \"object.value\": { \"name\": \"Address\", \"children\": [\n"
            + "    { \"field.string\": { \"name\": \"street\" } },\n"
            + "    { \"field.int\": { \"name\": \"zip\" } } ] } },\n"
            + "  { \"object.entity\": { \"name\": \"Invoice\", \"children\": [\n"
            + "    { \"source.rdb\": { \"@table\": \"" + pkg.replace("::", "_") + "_invoices\" } },\n"
            + "    { \"field.long\": { \"name\": \"id\" } },\n"
            + "    { \"field.string\": { \"name\": \"memo\", \"@maxLength\": 100 } },\n"
            + "    { \"field.object\": { \"name\": \"billTo\", \"@objectRef\": \"" + pkg + "::Address\", \"@storage\": \"jsonb\" } },\n"
            + "    { \"identity.primary\": { \"@fields\": \"id\", \"@generation\": \"increment\" } }\n"
            + "  ] } }\n] } }";
    }

    private MetaDataLoader load(String... pkgs) throws Exception {
        Path dir = tempFolder.newFolder().toPath();
        List<URI> uris = new ArrayList<>();
        for (int i = 0; i < pkgs.length; i++) {
            Path f = dir.resolve("meta." + i + ".json");
            Files.writeString(f, model(pkgs[i]));
            uris.add(URIHelper.toURI("model:file:" + f.toAbsolutePath().toString().replace('\\', '/')));
        }
        MetaDataLoader loader = new MetaDataLoader(
            LoaderOptions.create(false, false, true), MetaDataLoader.SUBTYPE_MANUAL, "pkg-keyed");
        loader.setSourceURIs(uris);
        loader.init();
        return loader;
    }

    /** {@code entity} and {@code value-object} are alternatives for an {@code object.value}: pick one. */
    private Path generate(MetaDataLoader loader, boolean web) throws Exception {
        Path out = tempFolder.newFolder().toPath();
        Map<String, Generator> gens = new LinkedHashMap<>();
        if (!web) gens.put("entity", new JavaObjectCodeGenerator());
        gens.put("names", new SpringNamesGenerator());
        if (web) {
            gens.put("value-object", new SpringValueObjectGenerator());
            gens.put("dto", new SpringDtoGenerator());
            gens.put("repository", new SpringRepositoryGenerator());
            gens.put("filter-allowlist", new SpringFilterAllowlistGenerator());
        }
        try (GeneratedFileWriter.Run run = GeneratedFileWriter.beginRun()) {
            for (Map.Entry<String, Generator> e : gens.entrySet()) {
                run.attributeTo(e.getKey());
                Map<String, String> args = new LinkedHashMap<>();
                if ("entity".equals(e.getKey())) { args.put("type", "class"); args.put("flavor", "pojoAware"); }
                args.put("outputDir", out.toString());
                e.getValue().setArgs(args).execute(loader);
            }
        }
        return out;
    }

    @Test
    public void sameNamedEntitiesAndValueObjectsInTwoPackagesGenerateTwoFilesEachAndCompile() throws Exception {
        // The model tier: the entity class and the value-object class beside it.
        Path model = generate(load("sales", "billing"), false);
        // The web tier: DTOs, the value-object RECORDS, repositories, filter allowlists.
        Path web = generate(load("sales", "billing"), true);
        for (String pkg : new String[] {"sales", "billing"}) {
            for (String file : new String[] {"Invoice.java", "Address.java"}) {
                assertTrue("model " + pkg + "/" + file, Files.exists(model.resolve(pkg).resolve(file)));
            }
            for (String file : new String[] {"Address.java", "InvoiceDto.java", "InvoiceRepository.java",
                                             "InvoiceFilterAllowlist.java"}) {
                assertTrue("web " + pkg + "/" + file, Files.exists(web.resolve(pkg).resolve(file)));
            }
        }
        String sales = Files.readString(model.resolve("sales").resolve("Invoice.java"));
        assertTrue(sales, sales.contains("package sales;"));
        SpringTestFixtures.compileGenerated(model, tempFolder.newFolder().toPath());
        SpringTestFixtures.compileGenerated(web, tempFolder.newFolder().toPath());
    }

    @Test
    public void nestedPackagesOfTheSameShortNameStayApart() throws Exception {
        Path out = generate(load("acme::sales", "acme::billing"), false);
        assertTrue(Files.exists(out.resolve("acme/sales/Invoice.java")));
        assertTrue(Files.exists(out.resolve("acme/billing/Invoice.java")));
        SpringTestFixtures.compileGenerated(out, tempFolder.newFolder().toPath());
    }

    @Test
    public void twoMetadataPackagesThatShareOneJavaPackageAreRefused() throws Exception {
        MetaDataLoader loader = load("Sales", "sales");
        com.metaobjects.generator.GeneratorException e = org.junit.Assert.assertThrows(
            com.metaobjects.generator.GeneratorException.class,
            () -> com.metaobjects.generator.util.OutputPackageCollisions.assertDistinct(
                new ArrayList<>(loader.getMetaObjects())));
        assertTrue(e.getMessage(), e.getMessage().contains("ERR_NAME_COLLISION"));
        assertTrue(e.getMessage(), e.getMessage().contains("\"Sales\"") && e.getMessage().contains("\"sales\""));
    }

    @Test
    public void distinctPackagesPass() throws Exception {
        com.metaobjects.generator.util.OutputPackageCollisions.assertDistinct(
            new ArrayList<>(load("sales", "billing").getMetaObjects()));
        assertEquals(4, load("sales", "billing").getMetaObjects().size());
    }
}

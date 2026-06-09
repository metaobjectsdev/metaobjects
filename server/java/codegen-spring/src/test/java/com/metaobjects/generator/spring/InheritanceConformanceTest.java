package com.metaobjects.generator.spring;

import com.metaobjects.generator.direct.MultiFileDirectGeneratorBase;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.object.MetaObject;
import com.metaobjects.registry.SharedRegistryTestBase;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.Map;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * Cross-port inheritance conformance (Java/Spring). Loads the shared fixture
 * {@code fixtures/codegen-conformance/inheritance/input/meta.inheritance.json} and asserts the
 * flatten port inlines the FULL field set across two abstract levels into the concrete
 * {@code ProductDto} record — {@code id}, {@code createdBy} (Base), {@code updatedBy}
 * (Auditable) + {@code sku}, {@code qtyOnHand} (own) — while the abstract bases emit no DTO.
 */
public class InheritanceConformanceTest extends SharedRegistryTestBase {

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    private MetaDataLoader loadShared() throws IOException {
        Path repoRoot = Path.of(System.getProperty("user.dir")).resolve("../../..").normalize();
        Path fixture = repoRoot.resolve("fixtures/codegen-conformance/inheritance/input/meta.inheritance.json");
        assertTrue("shared inheritance fixture must exist at " + fixture, Files.exists(fixture));
        return SpringTestFixtures.loadFixture(tmp.newFolder().toPath(), "metaInheritance", Files.readString(fixture));
    }

    private Path run(MultiFileDirectGeneratorBase<MetaObject> gen, MetaDataLoader loader) throws IOException {
        Path out = tmp.newFolder().toPath();
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", out.toString());
        gen.setArgs(args);
        gen.execute(loader);
        return out;
    }

    @Test
    public void concreteDtoFlattensFullMultiLevelInheritedFieldSet() throws Exception {
        Path out = run(new SpringDtoGenerator(), loadShared());
        Path pkgDir = out.resolve("acme/shop");

        // Abstract bases produce no DTO (the abstract invariant).
        assertFalse("Base is abstract — no BaseDto", Files.exists(pkgDir.resolve("BaseDto.java")));
        assertFalse("Auditable is abstract — no AuditableDto", Files.exists(pkgDir.resolve("AuditableDto.java")));

        Path dto = pkgDir.resolve("ProductDto.java");
        assertTrue("ProductDto.java MUST be emitted (concrete entity)", Files.exists(dto));
        String src = Files.readString(dto);

        // All five fields present — 2 levels of inherited + 2 own.
        for (String field : new String[]{ "id", "createdBy", "updatedBy", "sku", "qtyOnHand" }) {
            assertTrue("ProductDto must carry inherited/own field `" + field + "`; saw:\n" + src,
                src.contains(" " + field));
        }
        // The inherited required `createdBy` keeps its @NotNull (validation flattens too).
        assertTrue("inherited required field must keep @NotNull; saw:\n" + src,
            src.contains("@NotNull") && src.contains("createdBy"));
    }
}

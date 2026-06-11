package com.metaobjects.generator.spring;

import com.metaobjects.loader.MetaDataLoader;
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
import static org.junit.Assert.fail;

/**
 * Cross-port FR-019 conformance (Java/Spring). Loads the shared fixture
 * {@code fixtures/codegen-conformance/shared-provided-enum/input/meta.json} and asserts the two
 * FR-019 behaviors (ADR-0026):
 * <ul>
 *   <li><b>Shared materialization</b> — a package-level abstract {@code field.enum}
 *       ({@code Priority}) extended by TWO entities is materialized ONCE as a standalone
 *       {@code Priority.java}; both DTOs reference it (no nested redeclaration).</li>
 *   <li><b>{@code @provided}</b> — a package-level abstract {@code field.enum} ({@code Currency},
 *       {@code @provided: true}) is NOT materialized; consuming DTOs reference it at the configured
 *       namespace ({@code <ns>.Currency}). A referenced provided enum with no configured namespace
 *       is a codegen-time error naming the enum.</li>
 * </ul>
 *
 * <p>Each port runs the SAME fixture (the oracle) and asserts its own idiomatic contract — no
 * byte-identical cross-language expectation.</p>
 */
public class Fr019SharedProvidedConformanceTest extends SharedRegistryTestBase {

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    private MetaDataLoader loadShared() throws IOException {
        Path repoRoot = Path.of(System.getProperty("user.dir")).resolve("../../..").normalize();
        Path fixture = repoRoot.resolve("fixtures/codegen-conformance/shared-provided-enum/input/meta.json");
        assertTrue("shared FR-019 fixture must exist at " + fixture, Files.exists(fixture));
        return SpringTestFixtures.loadFixture(tmp.newFolder().toPath(), "sharedProvidedEnum",
            Files.readString(fixture));
    }

    /** Run the DTO generator with the given optional {@code providedEnumNamespace} fallback. */
    private Path run(MetaDataLoader loader, String providedEnumNamespace) throws IOException {
        Path out = tmp.newFolder().toPath();
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", out.toString());
        if (providedEnumNamespace != null) args.put("providedEnumNamespace", providedEnumNamespace);
        SpringDtoGenerator gen = new SpringDtoGenerator();
        gen.setArgs(args);
        gen.execute(loader);
        return out;
    }

    @Test
    public void sharedEnumIsMaterializedOnceAndReferencedByBothEntities() throws Exception {
        Path out = run(loadShared(), "com.acme.ext");

        // Materialized ONCE as a standalone top-level enum in the declaring package.
        Path sharedEnum = out.resolve("acme/shop/Priority.java");
        assertTrue("standalone Priority.java must be materialized; expected at " + sharedEnum,
            Files.exists(sharedEnum));
        assertTrue("standalone enum must declare members verbatim",
            Files.readString(sharedEnum).contains("public enum Priority { LOW, MEDIUM, HIGH }"));

        // Both entities reference it; neither redeclares the enum inline.
        for (String name : new String[] { "TicketDto.java", "OrderDto.java" }) {
            Path dto = out.resolve("acme/shop").resolve(name);
            assertTrue(name + " must be emitted", Files.exists(dto));
            String src = Files.readString(dto);
            assertTrue("priority component must be typed as the shared enum in " + name + "; saw:\n" + src,
                src.contains("Priority priority"));
            assertFalse("shared enum must NOT be nested in " + name + "; saw:\n" + src,
                src.contains("public enum Priority"));
        }
    }

    @Test
    public void providedEnumIsNotMaterializedAndReferencedAtTheConfiguredNamespace() throws Exception {
        Path out = run(loadShared(), "com.acme.ext");

        // Nothing emitted for the provided Currency type.
        assertFalse("provided Currency must NOT be materialized",
            Files.exists(out.resolve("acme/shop/Currency.java")));

        String ticket = Files.readString(out.resolve("acme/shop/TicketDto.java"));
        assertTrue("currency component must reference the configured external namespace; saw:\n" + ticket,
            ticket.contains("com.acme.ext.Currency currency"));
        assertFalse("provided Currency must NOT be nested in the DTO; saw:\n" + ticket,
            ticket.contains("public enum Currency"));
    }

    @Test
    public void providedEnumWithNoNamespaceConfigIsACodegenErrorNamingTheEnum() throws Exception {
        MetaDataLoader loader = loadShared();
        try {
            run(loader, null); // no providedEnumNamespace
            fail("expected a codegen-time error for the @provided enum with no namespace config");
        } catch (RuntimeException e) {
            assertTrue("error must name the provided enum Currency; was: " + e.getMessage(),
                e.getMessage() != null && e.getMessage().contains("Currency"));
        }
    }
}

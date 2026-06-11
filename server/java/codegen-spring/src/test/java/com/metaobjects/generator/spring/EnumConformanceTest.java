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

import static org.junit.Assert.assertTrue;

/**
 * Cross-port enum conformance (Java/Spring). Loads the shared fixture
 * {@code fixtures/codegen-conformance/enum/input/meta.enum.json} and asserts the entity DTO
 * represents enum fields as a value-constrained Java {@code enum} (parity with TS / Python /
 * Kotlin / C#): an INLINE enum ({@code status}) emits a nested {@code public enum
 * <Entity><Field>} in the record, while a field that {@code extends} the package-level abstract
 * root {@code Priority} enum is materialized ONCE as a standalone top-level {@code Priority.java}
 * (FR-019, ADR-0026) and merely REFERENCED by the DTO (not redeclared inline), with the DTO
 * components typed as those enums rather than {@code String}.
 */
public class EnumConformanceTest extends SharedRegistryTestBase {

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    private MetaDataLoader loadShared() throws IOException {
        Path repoRoot = Path.of(System.getProperty("user.dir")).resolve("../../..").normalize();
        Path fixture = repoRoot.resolve("fixtures/codegen-conformance/enum/input/meta.enum.json");
        assertTrue("shared enum fixture must exist at " + fixture, Files.exists(fixture));
        return SpringTestFixtures.loadFixture(tmp.newFolder().toPath(), "metaEnum", Files.readString(fixture));
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
    public void dtoTypesEnumFieldsAsValueConstrainedJavaEnums() throws Exception {
        Path out = run(new SpringDtoGenerator(), loadShared());
        Path dto = out.resolve("acme/shop/TicketDto.java");
        assertTrue("TicketDto.java must be emitted", Files.exists(dto));
        String src = Files.readString(dto);

        // Inline enum: nested `public enum TicketStatus { OPEN, PENDING, CLOSED }` + typed component.
        assertTrue("inline enum decl must be emitted; saw:\n" + src,
            src.contains("public enum TicketStatus { OPEN, PENDING, CLOSED }"));
        assertTrue("status component must be typed as the enum, not String; saw:\n" + src,
            src.contains("TicketStatus status"));

        // FR-019: extends a package-level abstract Priority → materialized standalone, referenced
        // (NOT nested) by the DTO; component still typed as the shared enum.
        assertTrue("shared enum must NOT be nested in the DTO (it is materialized standalone); saw:\n" + src,
            !src.contains("public enum Priority"));
        assertTrue("priority component must be typed as the shared enum; saw:\n" + src,
            src.contains("Priority priority"));

        // The standalone materialized enum file is emitted ONCE in the declaring package.
        Path sharedEnum = out.resolve("acme/shop/Priority.java");
        assertTrue("standalone Priority.java must be materialized; expected at " + sharedEnum,
            Files.exists(sharedEnum));
        String enumSrc = Files.readString(sharedEnum);
        assertTrue("standalone enum must declare the members verbatim; saw:\n" + enumSrc,
            enumSrc.contains("public enum Priority { LOW, MEDIUM, HIGH }"));

        // The enum value set must NOT collapse back to a String component.
        assertTrue("status must not be a String component; saw:\n" + src,
            !src.contains("String status"));
    }
}

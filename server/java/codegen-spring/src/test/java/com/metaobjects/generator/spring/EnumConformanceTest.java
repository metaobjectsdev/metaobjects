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
 * <Entity><Field>} in the record, and a field that {@code extends} the abstract root
 * {@code Priority} enum collapses onto ONE nested {@code public enum Priority} (deduped on the
 * super name), with the DTO components typed as those enums rather than {@code String}.
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

        // Extends abstract Priority: deduped onto one nested `public enum Priority { ... }` + typed component.
        assertTrue("shared enum decl must be emitted; saw:\n" + src,
            src.contains("public enum Priority { LOW, MEDIUM, HIGH }"));
        assertTrue("priority component must be typed as the shared enum; saw:\n" + src,
            src.contains("Priority priority"));

        // The enum value set must NOT collapse back to a String component.
        assertTrue("status must not be a String component; saw:\n" + src,
            !src.contains("String status"));
    }
}

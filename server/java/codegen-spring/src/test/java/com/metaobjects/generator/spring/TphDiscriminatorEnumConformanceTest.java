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

/**
 * FR-017 / typed-enum coherence guard: a TPH {@code @discriminator} that is declared
 * {@code field.enum} MUST be typed in the generated DTO as the value-constrained enum (the
 * cross-port typed-enum contract — TS string-literal union, Python {@code Literal}, C#/Kotlin/Java
 * enum), NEVER as a raw {@code String}.
 *
 * <p>This is otherwise only exercised end-to-end by the docker-gated api-contract TPH corpus, where
 * a regression to a {@code String}-typed discriminator would slip past the HTTP/JSON-seeding ports
 * (it deserializes fine) and only break the direct-constructing Java lane. This fast unit-level
 * assertion pins the static type so the discriminator can't silently regress to {@code String}.
 * Loads the SAME shared fixture the integration lane uses
 * ({@code fixtures/api-contract-conformance/tph/meta.json}: TPH base {@code Auth} with a
 * {@code field.enum type} discriminator over {@code Bridge|Copay|PriorAuth}).</p>
 */
public class TphDiscriminatorEnumConformanceTest extends SharedRegistryTestBase {

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    @Test
    public void tphEnumDiscriminatorIsTypedAsTheEnumNotString() throws Exception {
        Path repoRoot = Path.of(System.getProperty("user.dir")).resolve("../../..").normalize();
        Path fixture = repoRoot.resolve("fixtures/api-contract-conformance/tph/meta.json");
        assertTrue("shared TPH fixture must exist at " + fixture, Files.exists(fixture));
        MetaDataLoader loader = SpringTestFixtures.loadFixture(
            tmp.newFolder().toPath(), "tphDiscriminatorEnum", Files.readString(fixture));

        Path out = tmp.newFolder().toPath();
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", out.toString());
        SpringDtoGenerator gen = new SpringDtoGenerator();
        gen.setArgs(args);
        gen.execute(loader);

        // The TPH base's union DTO carries the discriminator.
        Path dto = out.resolve("acme/auth/AuthDto.java");
        assertTrue("AuthDto.java must be emitted", Files.exists(dto));
        String src = Files.readString(dto);

        // The discriminator component is the value-constrained enum, not a bare String.
        assertTrue("the @discriminator field.enum must be typed as the generated enum; saw:\n" + src,
            src.contains("AuthType type"));
        assertTrue("the discriminator enum must be materialized with its @values; saw:\n" + src,
            src.contains("public enum AuthType { Bridge, Copay, PriorAuth }"));
        assertFalse("the @discriminator must NOT regress to a raw String component; saw:\n" + src,
            src.contains("String type"));
    }
}

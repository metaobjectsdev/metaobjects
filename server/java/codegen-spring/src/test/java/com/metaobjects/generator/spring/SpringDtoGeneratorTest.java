package com.metaobjects.generator.spring;

import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.registry.SharedRegistryTestBase;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.Map;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * Tests for {@link SpringDtoGenerator}. Covers the wire-shape contract: one
 * Java 21 {@code record} per entity, wrapped-primitive types for nullability,
 * and the package-derivation rule (metadata {@code a::b::c} →
 * Java {@code a.b.c}).
 */
public class SpringDtoGeneratorTest extends SharedRegistryTestBase {

    @Rule
    public TemporaryFolder tempFolder = new TemporaryFolder();

    private static final String AUTHOR_FIXTURE = """
        {
          "metadata.root": { "package": "acme::blog", "children": [
            { "object.entity": { "name": "Author", "children": [
                { "field.long":      { "name": "id" } },
                { "field.string":    { "name": "name", "@maxLength": 100, "@required": true } },
                { "field.string":    { "name": "bio" } },
                { "field.timestamp": { "name": "createdAt" } },
                { "source.rdb":      { "@table": "authors" } },
                { "identity.primary": { "name": "pk", "@fields": ["id"], "@generation": "increment" } }
            ] } }
          ] }
        }
        """;

    @Test
    public void emitsJavaRecordWithCorrectFieldTypes() throws Exception {
        Path outDir = tempFolder.newFolder("dto-types").toPath();
        Path workspace = tempFolder.newFolder("dto-types-fx").toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(workspace, "author-types", AUTHOR_FIXTURE);

        SpringDtoGenerator gen = new SpringDtoGenerator();
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", outDir.toString());
        gen.setArgs(args);
        gen.execute(loader);

        Path dto = outDir.resolve("acme/blog/AuthorDto.java");
        assertTrue("expected AuthorDto.java at " + dto, Files.exists(dto));
        String src = Files.readString(dto);

        // Java record declaration shape.
        assertTrue("expected record declaration; saw:\n" + src,
            src.contains("public record AuthorDto("));
        // Java 21 records — closing parens + empty body.
        assertTrue("expected record body `{}` closing; saw:\n" + src,
            src.contains(") {}"));
        // Package declaration matches the metadata package, with `::` → `.`.
        assertTrue("expected `package acme.blog;`; saw:\n" + src,
            src.contains("package acme.blog;"));
        // Field-type assertions — pin SpringTypeMapper's outputs.
        assertTrue("expected `Long id` component; saw:\n" + src, src.contains("Long id"));
        assertTrue("expected `String name` component; saw:\n" + src, src.contains("String name"));
        assertTrue("expected `String bio` component; saw:\n" + src, src.contains("String bio"));
        // Plain field.timestamp → Instant (ADR-0036 Wave 2: instant/tz-aware by default;
        // the naive LocalDateTime shape is now the @localTime opt-out). See SpringTypeMapper.
        assertTrue("expected `java.time.Instant createdAt` component; saw:\n" + src,
            src.contains("java.time.Instant createdAt"));
    }

    @Test
    public void nullableFieldsAreWrappedTypes() throws Exception {
        // The wrapped-type promise applies even when @required is set: Java records have
        // no nullability syntax of their own, so we surface ALL field components as
        // wrapped types (Long not long, Integer not int). Bean-validation
        // (@NotNull / @Valid) is out of Day-1 scope but can be layered on by the
        // consumer in their controller-advice / @ControllerAdvice handler chain.
        Path outDir = tempFolder.newFolder("dto-null").toPath();
        Path workspace = tempFolder.newFolder("dto-null-fx").toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(workspace, "author-null", AUTHOR_FIXTURE);

        SpringDtoGenerator gen = new SpringDtoGenerator();
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", outDir.toString());
        gen.setArgs(args);
        gen.execute(loader);

        String src = Files.readString(outDir.resolve("acme/blog/AuthorDto.java"));
        // No `long id` (primitive); always wrapped `Long id`.
        assertFalse("expected wrapped `Long` not primitive `long`; saw:\n" + src,
            src.contains("long id"));
        // No `int` / `boolean` etc. on any component declaration. (Defensive scan: the
        // fixture above has no int/boolean fields, so this asserts none crept in.)
        assertFalse("expected no primitive ` int ` component decl; saw:\n" + src,
            src.contains(" int "));
        assertFalse("expected no primitive ` boolean ` component decl; saw:\n" + src,
            src.contains(" boolean "));
    }

    @Test
    public void recordSyntaxIsJava21Compatible() throws Exception {
        // Sanity check on the shape: the canonical constructor must be implicit (records
        // get it free) and the body must be empty `{}`. This pins us against accidentally
        // emitting a class-with-getters that wouldn't compile as a record.
        Path outDir = tempFolder.newFolder("dto-shape").toPath();
        Path workspace = tempFolder.newFolder("dto-shape-fx").toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(workspace, "author-shape", AUTHOR_FIXTURE);

        SpringDtoGenerator gen = new SpringDtoGenerator();
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", outDir.toString());
        gen.setArgs(args);
        gen.execute(loader);

        String src = Files.readString(outDir.resolve("acme/blog/AuthorDto.java"));
        // Must NOT emit explicit getters/setters/equals — those come free with a record.
        assertFalse("records should not emit explicit getters; saw:\n" + src,
            src.contains("public String getName"));
        assertFalse("records should not emit explicit setters; saw:\n" + src,
            src.contains("public void setName"));
        // Must NOT be a `public class` — record only.
        assertFalse("expected record, not class; saw:\n" + src,
            src.contains("public class AuthorDto"));
        // Empty body — no constructor block, no methods.
        assertTrue("expected empty record body `) {}`; saw:\n" + src,
            src.contains(") {}"));
    }
}

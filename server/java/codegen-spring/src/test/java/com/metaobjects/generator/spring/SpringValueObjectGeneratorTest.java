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
 * Program D — tests for {@link SpringValueObjectGenerator} and the value-object arms it adds to
 * {@link SpringDtoGenerator}. A {@code field.object @objectRef=<value> @storage:jsonb} column
 * (single or {@code @isArray}) becomes a strongly-typed, bean-validated record component so it
 * POSTs + PATCHes with nested validation.
 */
public class SpringValueObjectGeneratorTest extends SharedRegistryTestBase {

    @Rule
    public TemporaryFolder tempFolder = new TemporaryFolder();

    private static final String FIXTURE = """
        {
          "metadata.root": { "package": "acme::store", "children": [
            { "object.value": { "name": "Marker", "children": [
                { "field.string": { "name": "label", "@required": true, "@maxLength": 40 } },
                { "field.int":    { "name": "score" } }
            ] } },
            { "object.entity": { "name": "Document", "children": [
                { "source.rdb":       { "@table": "documents" } },
                { "field.long":       { "name": "id" } },
                { "field.string":     { "name": "title", "@required": true, "@maxLength": 200 } },
                { "field.object":     { "name": "primaryMarker",  "@objectRef": "Marker", "@storage": "jsonb", "@required": true } },
                { "field.object":     { "name": "optionalMarker", "@objectRef": "Marker", "@storage": "jsonb" } },
                { "field.object":     { "name": "markers",        "@objectRef": "Marker", "@storage": "jsonb", "isArray": true } },
                { "identity.primary": { "name": "pk", "@fields": ["id"], "@generation": "increment" } }
            ] } }
          ] }
        }
        """;

    private MetaDataLoader load(String base) throws Exception {
        Path workspace = tempFolder.newFolder(base + "-fx").toPath();
        return SpringTestFixtures.loadFixture(workspace, base, FIXTURE);
    }

    private static void run(Object generator, MetaDataLoader loader, Path outDir) {
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", outDir.toString());
        ((com.metaobjects.generator.direct.MultiFileDirectGeneratorBase<?>) generator).setArgs(args);
        ((com.metaobjects.generator.direct.MultiFileDirectGeneratorBase<?>) generator).execute(loader);
    }

    @Test
    public void emitsValueObjectRecordWithNestedConstraints() throws Exception {
        Path outDir = tempFolder.newFolder("vo").toPath();
        MetaDataLoader loader = load("vo");
        run(new SpringValueObjectGenerator(), loader, outDir);

        Path marker = outDir.resolve("acme/store/Marker.java");
        assertTrue("expected Marker.java at " + marker, Files.exists(marker));
        String src = Files.readString(marker);

        assertTrue("expected a record; saw:\n" + src, src.contains("public record Marker("));
        // FR-036 Ruling 1: @required non-array string → @NotNull + @Size(min = 1, …); @maxLength 40 → max = 40.
        assertTrue("expected @NotNull on label; saw:\n" + src, src.contains("@NotNull"));
        assertTrue("expected @Size(min = 1, max = 40) on label; saw:\n" + src,
            src.contains("@Size(min = 1, max = 40)"));
        assertTrue("expected `String label` component; saw:\n" + src, src.contains("String label"));
        assertTrue("expected `Integer score` component; saw:\n" + src, src.contains("Integer score"));
        // No package-qualified pollution — Marker lives in acme.store, so its own name is bare.
        assertTrue("expected `package acme.store;`; saw:\n" + src, src.contains("package acme.store;"));
    }

    @Test
    public void dtoAndPatchCarryValueObjectComponents() throws Exception {
        Path outDir = tempFolder.newFolder("dto").toPath();
        MetaDataLoader loader = load("dto");
        run(new SpringDtoGenerator(), loader, outDir);

        String dto = Files.readString(outDir.resolve("acme/store/DocumentDto.java"));
        // The required single VO carries @NotNull + @Valid (POST validate(dto) cascades into Marker).
        assertTrue("expected @Valid on the VO component; saw:\n" + dto, dto.contains("@Valid"));
        assertTrue("expected @NotNull @Valid acme.store.Marker primaryMarker; saw:\n" + dto,
            dto.contains("acme.store.Marker primaryMarker"));
        assertTrue("expected the array VO as List<Marker>; saw:\n" + dto,
            dto.contains("java.util.List<acme.store.Marker> markers"));
        assertTrue("expected the jakarta.validation.Valid import; saw:\n" + dto,
            dto.contains("import jakarta.validation.Valid;"));

        String patch = Files.readString(outDir.resolve("acme/store/DocumentPatch.java"));
        // The presence-tracked patch exposes typed VO accessors for the controller's nested check.
        assertTrue("expected hasPrimaryMarker() on the patch; saw:\n" + patch,
            patch.contains("hasPrimaryMarker"));
        assertTrue("expected a typed Marker accessor on the patch; saw:\n" + patch,
            patch.contains("acme.store.Marker primaryMarker()"));
        // The PK is never a settable patch member.
        assertFalse("id must not be a settable patch member; saw:\n" + patch,
            patch.contains("hasId("));
    }
}

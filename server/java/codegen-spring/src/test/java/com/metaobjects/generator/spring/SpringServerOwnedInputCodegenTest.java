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
 * A generated create route hands the repository only what a client may set: a server-generated
 * key, a {@code readOnly} field and (TPH) the discriminator and a sibling subtype's column are
 * dropped from the bound body, and the request type ignores an undeclared key itself.
 */
public class SpringServerOwnedInputCodegenTest extends SharedRegistryTestBase {

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    private static final String PLAIN = """
        {
          "metadata.root": { "package": "acme::own", "children": [
            { "object.entity": { "name": "Doc", "children": [
                { "source.rdb": { "@table": "docs" } },
                { "field.long":   { "name": "id" } },
                { "field.string": { "name": "title" } },
                { "field.string": { "name": "role", "@mutability": "readOnly" } },
                { "identity.primary": { "name": "pk", "@fields": ["id"], "@generation": "increment" } }
            ] } },
            { "object.entity": { "name": "Tag", "children": [
                { "source.rdb": { "@table": "tags" } },
                { "field.string": { "name": "code" } },
                { "field.string": { "name": "label" } },
                { "identity.primary": { "name": "pk", "@fields": ["code"] } }
            ] } }
          ] }
        }
        """;

    private static final String TPH = """
        {
          "metadata.root": { "package": "acme::own", "children": [
            { "object.entity": { "name": "Auth", "@discriminator": "type", "children": [
                { "source.rdb": { "@table": "auths" } },
                { "field.long": { "name": "id" } },
                { "field.enum": { "name": "type", "@values": ["Bridge", "Prior"] } },
                { "field.string": { "name": "reference" } },
                { "field.string": { "name": "grade", "@mutability": "readOnly" } },
                { "identity.primary": { "name": "pk", "@fields": ["id"], "@generation": "increment" } }
            ] } },
            { "object.entity": { "name": "BridgeAuth", "extends": "Auth", "@discriminatorValue": "Bridge", "children": [
                { "field.int": { "name": "quantity" } }
            ] } },
            { "object.entity": { "name": "PriorAuth", "extends": "Auth", "@discriminatorValue": "Prior", "children": [
                { "field.string": { "name": "approver" } }
            ] } }
          ] }
        }
        """;

    private static final String VO = """
        {
          "metadata.root": { "package": "acme::own", "children": [
            { "object.value": { "name": "Stamp", "children": [
                { "field.string": { "name": "by" } }
            ] } },
            { "object.entity": { "name": "Note", "children": [
                { "source.rdb": { "@table": "notes" } },
                { "field.long":   { "name": "id" } },
                { "field.string": { "name": "body" } },
                { "field.object": { "name": "stamp", "@objectRef": "Stamp", "@storage": "jsonb",
                                    "@required": true, "@mutability": "readOnly" } },
                { "identity.primary": { "name": "pk", "@fields": ["id"], "@generation": "increment" } }
            ] } }
          ] }
        }
        """;

    private Path generate(String name, String fixture) throws Exception {
        Path gen = tmp.newFolder("gen-" + name).toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(tmp.newFolder("ws-" + name).toPath(), name, fixture);
        for (var g : new com.metaobjects.generator.direct.MultiFileDirectGeneratorBase<?>[] {
                new SpringControllerGenerator(), new SpringDtoGenerator() }) {
            Map<String, String> args = new HashMap<>();
            args.put("outputDir", gen.toString());
            g.setArgs(args);
            g.execute(loader);
        }
        return gen;
    }

    @Test
    public void plainCreateDropsTheGeneratedKeyAndReadOnlyField() throws Exception {
        Path gen = generate("plain", PLAIN);
        String controller = Files.readString(gen.resolve("acme/own/DocController.java"));
        assertTrue("generated id and readOnly role are nulled; saw:\n" + controller,
            controller.contains("dto = new DocDto(null, dto.title(), null);"));
        // an assigned key (no @generation) is the caller's on create
        String tag = Files.readString(gen.resolve("acme/own/TagController.java"));
        assertFalse("assigned key must be kept; saw:\n" + tag, tag.contains("dto = new TagDto("));
    }

    @Test
    public void requestTypeIgnoresUnknownProperties() throws Exception {
        Path gen = generate("unknown", PLAIN);
        String dto = Files.readString(gen.resolve("acme/own/DocDto.java"));
        assertTrue(dto.contains("@com.fasterxml.jackson.annotation.JsonIgnoreProperties(ignoreUnknown = true)\npublic record DocDto("));
    }

    @Test
    public void aRequiredReadOnlyValueObjectIsNulledAndItsNotNullIgnored() throws Exception {
        Path gen = generate("vo", VO);
        String controller = Files.readString(gen.resolve("acme/own/NoteController.java"));
        assertTrue("readOnly VO component is nulled on create; saw:\n" + controller,
            controller.contains("dto = new NoteDto(null, dto.body(), null);"));
        // the strip nulls `stamp`, so its @NotNull must not turn every POST into a 400
        assertTrue("stamp must be server-owned for create validation; saw:\n" + controller,
            controller.matches("(?s).*SERVER_OWNED_ON_CREATE = Set\\.of\\([^)]*\"stamp\".*"));
    }

    @Test
    public void tphCreateDropsKeyDiscriminatorReadOnlyAndSiblingColumns() throws Exception {
        Path gen = generate("tph", TPH);
        String controller = Files.readString(gen.resolve("acme/own/AuthController.java"));
        // union components: id, type, reference, grade, quantity, approver
        assertTrue("Bridge route keeps reference and quantity only; saw:\n" + controller,
            controller.contains("dto = new AuthDto(null, null, dto.reference(), null, dto.quantity(), null);"));
        assertTrue("Prior route keeps reference and approver only; saw:\n" + controller,
            controller.contains("dto = new AuthDto(null, null, dto.reference(), null, null, dto.approver());"));
    }
}

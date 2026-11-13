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
 * dropped from the bound body before the repository sees it (1.2.x security patch). Behaviour is
 * gated by the api-contract {@code input-server-owned-dropped} scenarios; this pins the generated
 * source, including the TPH subtype {@code readOnly} case the shared TPH model does not declare.
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

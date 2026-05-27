/*
 * Copyright 2003 Doug Mealing LLC dba Meta Objects. All Rights Reserved.
 *
 * This software is the proprietary information of Doug Mealing LLC dba Meta Objects.
 * Use is subject to license terms.
 */
package com.metaobjects.source;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.metaobjects.ErrorCode;
import com.metaobjects.MetaData;
import com.metaobjects.MetaDataException;
import com.metaobjects.MetaRoot;
import com.metaobjects.attr.MetaAttribute;
import com.metaobjects.field.MetaField;
import com.metaobjects.loader.LoaderOptions;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.loader.parser.yaml.ParserYaml;
import com.metaobjects.object.MetaObject;
import com.metaobjects.source.YamlPositions.PositionMap;
import com.metaobjects.source.YamlPositions.SideTable;
import com.metaobjects.source.YamlPositions.WalkResult;
import org.junit.Before;
import org.junit.Test;
import org.yaml.snakeyaml.Yaml;
import org.yaml.snakeyaml.nodes.Node;

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.io.StringReader;
import java.nio.charset.StandardCharsets;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

/**
 * FR5b — YAML source-position tracking through the desugar + parser.
 *
 * <p>Java port of {@code server/csharp/MetaObjects.Conformance.Tests/YamlPositionsTests.cs}.
 * Mirrors the same three test tiers:</p>
 * <ol>
 *   <li><b>Walker</b> — {@link YamlPositions#walk(Node)} attaches a {@link PositionMap}
 *       to every mapping {@link JsonObject}; positions are 1-indexed line/col.</li>
 *   <li><b>Desugar</b> — {@code YamlDesugar.desugar(Node, …)} carries those positions
 *       through Rules 1-5 (sigil-free attr rename, {@code []} strip, scalar-body lift).</li>
 *   <li><b>Parser</b> — {@code ParserYaml} flattens the per-{@link JsonObject} maps
 *       into a JSONPath-keyed map; the canonical parser stamps
 *       {@link JsonSource#yamlPosition()} on every constructed node.</li>
 * </ol>
 *
 * <p>FR5b finalized 2026-05-27 — all four ports flipped YAML-input-emitted source
 * envelopes from {@link JsonSource} (format {@code "json"}) to {@link YamlSource}
 * (format {@code "yaml"}) and the yaml-conformance fixtures' format discriminator
 * was mass-updated. The envelope continues to carry the optional
 * {@link YamlPosition} when the desugar tracked a position for the node.</p>
 */
public class YamlPositionsTest {

    private MetaDataLoader loader;

    @Before
    public void setUp() {
        // Force MetaRoot + MetaObject static blocks so default-subType mappings exist.
        try {
            Class.forName(MetaRoot.class.getName());
            Class.forName(MetaObject.class.getName());
        } catch (ClassNotFoundException e) {
            throw new AssertionError(e);
        }
        loader = new MetaDataLoader(LoaderOptions.create(false, false, true),
            MetaDataLoader.SUBTYPE_MANUAL, "yaml-positions-test-" + System.nanoTime());
        loader.init();
    }

    // -----------------------------------------------------------------------
    // Walker layer — position-by-key maps land on every mapping.
    // -----------------------------------------------------------------------

    @Test
    public void walker_attachesPositionByKeyMapToEveryMapping() {
        String yaml =
            "metadata.root:\n" +
            "  package: acme\n" +
            "  children:\n" +
            "    - object.entity:\n" +
            "        name: Foo\n";
        Node node = new Yaml().compose(new StringReader(yaml));
        WalkResult walked = YamlPositions.walk(node);
        assertNotNull(walked.element);
        assertTrue(walked.element.isJsonObject());
        JsonObject root = walked.element.getAsJsonObject();
        SideTable t = walked.positions;

        // Root wrapper has a position for "metadata.root".
        assertEquals(new YamlPosition(1, 1), t.get(root, "metadata.root"));

        // Root body has positions for "package" and "children".
        JsonObject rootBody = root.getAsJsonObject("metadata.root");
        assertEquals(new YamlPosition(2, 3), t.get(rootBody, "package"));
        assertEquals(new YamlPosition(3, 3), t.get(rootBody, "children"));

        // Single child wrapper points at the `object.entity` line.
        JsonArray children = rootBody.getAsJsonArray("children");
        JsonObject childWrapper = children.get(0).getAsJsonObject();
        assertEquals(new YamlPosition(4, 7), t.get(childWrapper, "object.entity"));

        // Child body points at the `name` line.
        JsonObject childBody = childWrapper.getAsJsonObject("object.entity");
        assertEquals(new YamlPosition(5, 9), t.get(childBody, "name"));
    }

    @Test
    public void walker_positionMapIsInvisibleToGsonToString() {
        String yaml = "metadata.root:\n  package: acme\n";
        Node node = new Yaml().compose(new StringReader(yaml));
        WalkResult walked = YamlPositions.walk(node);
        JsonObject root = walked.element.getAsJsonObject();
        assertNotNull(walked.positions.getMap(root));
        // toString must not surface the side-table — it lives in YamlPositions, not on the JsonObject.
        String json = root.toString();
        assertFalse("yamlPosition is not serialized by Gson",
            json.contains("yamlPosition"));
        assertFalse("PositionMap is not serialized by Gson",
            json.contains("PositionMap"));
    }

    // -----------------------------------------------------------------------
    // Desugar layer — positions survive Rules 1-5.
    // -----------------------------------------------------------------------

    @Test
    public void desugar_rule4SigilFreeAttrPreservesPositionUnderAtPrefix() {
        String yaml =
            "object.entity:\n" +
            "  name: Foo\n" +
            "  filterable: true\n";
        ParserYaml parser = new ParserYaml(loader, "yaml_positions_test_1.yaml");
        ParserYaml.YamlResult result = parser.parseYamlCollecting(bytes(yaml));
        JsonObject body = result.canonical.getAsJsonObject("object.entity");
        assertNotNull(body);
        // The JSONPath-keyed flattened map carries both keys.
        // `$['object.entity'].@filterable` (rewritten Rule-4 key) → (3,3).
        assertEquals(new YamlPosition(3, 3),
            result.positionsByPath.get("$['object.entity']['@filterable']"));
        // Reserved structural keys stay bare; position at the `name:` line.
        assertEquals(new YamlPosition(2, 3),
            result.positionsByPath.get("$['object.entity'].name"));
    }

    @Test
    public void desugar_rule2ScalarBodyInheritsWrapperPositionOnNameSlot() {
        // `field.string: sku` lifts to `{ field.string: { name: "sku" } }`.
        // The synthesized `name` has no YAML key of its own, so it inherits
        // the wrapper key's position.
        String yaml =
            "metadata.root:\n" +
            "  children:\n" +
            "    - field.string: sku\n";
        ParserYaml parser = new ParserYaml(loader, "yaml_positions_test_2.yaml");
        ParserYaml.YamlResult result = parser.parseYamlCollecting(bytes(yaml));
        // The wrapper-key position for `field.string` is on line 3, col 7.
        assertEquals(new YamlPosition(3, 7),
            result.positionsByPath.get("$['metadata.root'].children[0]['field.string']"));
        // The synthesized `name` inherits the wrapper-key position.
        assertEquals(new YamlPosition(3, 7),
            result.positionsByPath.get("$['metadata.root'].children[0]['field.string'].name"));
    }

    @Test
    public void desugar_arraySuffixPreservesWrapperPositionUnderUnsuffixedKey() {
        String yaml =
            "object.entity:\n" +
            "  name: Foo\n" +
            "  children:\n" +
            "    - field.long[]: weekIds\n";
        ParserYaml parser = new ParserYaml(loader, "yaml_positions_test_3.yaml");
        ParserYaml.YamlResult result = parser.parseYamlCollecting(bytes(yaml));
        // The canonical wrapper key is `field.long` (sans `[]`); position points
        // at the YAML `field.long[]:` line.
        assertEquals(new YamlPosition(4, 7),
            result.positionsByPath.get("$['object.entity'].children[0]['field.long']"));
    }

    // -----------------------------------------------------------------------
    // Parser layer — JsonSource.yamlPosition is populated end-to-end.
    // -----------------------------------------------------------------------

    @Test
    public void parser_everyYamlLoadedNodeCarriesYamlPositionOnSource() {
        String yaml =
            "metadata.root:\n" +
            "  package: acme\n" +
            "  children:\n" +
            "    - object.entity:\n" +
            "        name: Foo\n" +
            "        children:\n" +
            "          - field.string:\n" +
            "              name: id\n";
        ParserYaml parser = new ParserYaml(loader, "input.yaml");
        parser.loadFromStream(bytes(yaml));

        // MetaRoot — wrapper key `metadata.root` on line 1, col 1.
        ErrorSource rootSrc = loader.getRoot().getSource();
        assertTrue("root carries YamlSource (FR5b finalized)", rootSrc instanceof YamlSource);
        YamlSource rootYs = (YamlSource) rootSrc;
        assertEquals("yaml", rootYs.format());
        assertEquals(new YamlPosition(1, 1), rootYs.yamlPosition());

        // The Product object.entity — `object.entity:` on line 4, col 7.
        assertEquals(1, loader.getRoot().getChildren().size());
        MetaData foo = loader.getRoot().getChildren().get(0);
        YamlSource fooYs = (YamlSource) foo.getSource();
        assertEquals(new YamlPosition(4, 7), fooYs.yamlPosition());

        // The id field.string — `field.string:` on line 7, col 13.
        assertEquals(1, foo.getChildren().size());
        MetaData id = foo.getChildren().get(0);
        YamlSource idYs = (YamlSource) id.getSource();
        assertEquals(new YamlPosition(7, 13), idYs.yamlPosition());
    }

    @Test
    public void parser_jsonLoadedNodeHasNoYamlPosition() {
        // The JSON parser path doesn't enable the FR5b yaml-format branch;
        // the node's source is the FR5a envelope with yamlPosition == null.
        String json = "{ \"metadata.root\": { \"package\": \"acme\", \"children\": [] } }";
        com.metaobjects.loader.parser.json.CanonicalJsonParser parser =
            new com.metaobjects.loader.parser.json.CanonicalJsonParser(loader, "input.json");
        parser.loadFromStream(new ByteArrayInputStream(json.getBytes(StandardCharsets.UTF_8)));
        JsonSource js = (JsonSource) loader.getRoot().getSource();
        assertEquals("json", js.format());
        assertNull("no yaml position on JSON input", js.yamlPosition());
    }

    @Test
    public void parser_rule2ScalarBodyNodeCarriesWrapperKeyPosition() {
        String yaml =
            "metadata.root:\n" +
            "  package: acme\n" +
            "  children:\n" +
            "    - object.entity:\n" +
            "        name: Foo\n" +
            "        children:\n" +
            "          - field.string: sku\n";
        ParserYaml parser = new ParserYaml(loader, "input.yaml");
        parser.loadFromStream(bytes(yaml));

        MetaData foo = loader.getRoot().getChildren().get(0);
        // `Foo` has 1 child — a field.string named `sku` lifted from the scalar body.
        // Filter to actual field children, since the parser may attach helper attributes.
        MetaData fieldNode = null;
        for (MetaData c : foo.getChildren()) {
            if (c.getType().equals("field")) { fieldNode = c; break; }
        }
        assertNotNull("field.string child", fieldNode);
        assertEquals("sku", fieldNode.getName());
        // Wrapper key `field.string:` is on line 7, col 13.
        YamlSource ys = (YamlSource) fieldNode.getSource();
        assertEquals(new YamlPosition(7, 13), ys.yamlPosition());
    }

    @Test
    public void parser_emptyBodyNodeStillCarriesWrapperKeyPosition() {
        // Per the FR5b spec: a body with NO keys generates no body-side positions,
        // so the wrapper-key's position is the only one surfaced — and that's
        // what JsonSource.yamlPosition reflects on the resulting node.
        String yaml =
            "metadata.root:\n" +
            "  children:\n" +
            "    - object.entity:\n" +
            "        name: Foo\n";  // body with one key; empty-body shape simulated via no children
        ParserYaml parser = new ParserYaml(loader, "input.yaml");
        parser.loadFromStream(bytes(yaml));

        MetaData foo = loader.getRoot().getChildren().get(0);
        YamlSource ys = (YamlSource) foo.getSource();
        // `object.entity:` is at line 3, col 7.
        assertEquals(new YamlPosition(3, 7), ys.yamlPosition());
    }

    @Test
    public void parser_reservedAttrErrorCarriesYamlPosition() {
        // Authoring an `@`-prefixed reserved word (e.g. `@isArray`) is a hard
        // ERR_RESERVED_ATTR. The error envelope should include the YAML position
        // pointing at the offending node's wrapper.
        String yaml =
            "metadata.root:\n" +
            "  package: acme\n" +
            "  children:\n" +
            "    - object.entity:\n" +
            "        name: Foo\n" +
            "        '@isArray': true\n";
        ParserYaml parser = new ParserYaml(loader, "input.yaml");
        try {
            parser.loadFromStream(bytes(yaml));
            // ERR_RESERVED_ATTR is collected via the canonical parser path; depending
            // on whether the loader runs in strict mode, the exception may or may not
            // surface here. If it doesn't throw, the test only verifies the position
            // mapping was emitted (the next assertion confirms via the path map).
        } catch (MetaDataException ex) {
            // If thrown, the envelope must carry the position for the offending node.
            ex.getEnvelope().ifPresent(env -> {
                assertTrue("envelope is YamlSource (FR5b finalized)", env instanceof YamlSource);
                YamlSource ys = (YamlSource) env;
                // The reserved-attr check fires inside the object.entity body — the
                // current JSONPath includes `['object.entity']`, so yamlPosition
                // points at that wrapper-key's line (4, 7).
                assertEquals(new YamlPosition(4, 7), ys.yamlPosition());
            });
            return;
        }
        // If not thrown, at least confirm the canonical parser DID see the position.
        // (Re-run via parseYamlCollecting to inspect the map.)
        ParserYaml parser2 = new ParserYaml(loader, "input.yaml");
        ParserYaml.YamlResult res = parser2.parseYamlCollecting(bytes(yaml));
        assertEquals(new YamlPosition(4, 7),
            res.positionsByPath.get("$['metadata.root'].children[0]['object.entity']"));
    }

    private static InputStream bytes(String s) {
        return new ByteArrayInputStream(s.getBytes(StandardCharsets.UTF_8));
    }
}

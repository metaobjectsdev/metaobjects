/*
 * Copyright 2003 Doug Mealing LLC dba Meta Objects
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
package com.metaobjects.loader.parser.yaml;

import com.google.gson.JsonObject;
import com.metaobjects.ErrorCode;
import com.metaobjects.MetaDataException;
import com.metaobjects.MetaRoot;
import com.metaobjects.loader.LoaderOptions;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.object.MetaObject;
import org.junit.Before;
import org.junit.Test;

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

/**
 * End-to-end smoke tests for {@link ParserYaml} — author a small YAML document,
 * run the full {@code parseYamlCollecting → buildTree} pipeline, and verify the
 * loader root carries the expected canonical-shaped children.
 */
public class ParserYamlTest {

    private MetaDataLoader loader;

    @Before
    public void setUp() {
        try {
            Class.forName(MetaRoot.class.getName());
            Class.forName(MetaObject.class.getName());
        } catch (ClassNotFoundException e) {
            throw new AssertionError(e);
        }
        loader = new MetaDataLoader(LoaderOptions.create(false, false, true),
            MetaDataLoader.SUBTYPE_MANUAL, "yaml-parser-test");
        loader.init();
    }

    @Test
    public void desugarsBareMetadata_andLoadsEntity() {
        String yaml =
            "metadata:\n" +
            "  package: acme::shop\n" +
            "  children:\n" +
            "    - object.entity:\n" +
            "        name: Product\n" +
            "        children:\n" +
            "          - field.string:\n" +
            "              name: sku\n" +
            "              column: sku_code\n" +
            "              required: true\n";

        ParserYaml parser = new ParserYaml(loader, "smoke.yaml");
        InputStream is = bytes(yaml);
        parser.loadFromStream(is);

        // The MetaRoot now carries one child (the Product entity, FQN'd by package).
        assertNotNull(loader.getRoot());
        assertEquals("one top-level child", 1, loader.getRoot().getChildren().size());
        assertTrue("entity name ends with Product",
            loader.getRoot().getChildren().get(0).getName().endsWith("Product"));
    }

    @Test
    public void arraySuffixOnKey_setsIsArrayOnCanonical() {
        String yaml =
            "metadata:\n" +
            "  children:\n" +
            "    - object.entity:\n" +
            "        name: Program\n" +
            "        children:\n" +
            "          - field.long[]: weekIds\n";

        ParserYaml parser = new ParserYaml(loader, "isarray.yaml");
        JsonObject canonical;
        try (InputStream is = bytes(yaml)) {
            ParserYaml.YamlResult result = parser.parseYamlCollecting(is);
            assertEquals("no desugar errors", 0, result.errors.size());
            canonical = result.canonical;
        } catch (Exception e) {
            throw new AssertionError(e);
        }

        // Walk to children[0].children[0] (field.long) and verify isArray.
        JsonObject metaRoot = canonical.getAsJsonObject("metadata.root");
        JsonObject entity = metaRoot.getAsJsonArray("children")
            .get(0).getAsJsonObject().getAsJsonObject("object.entity");
        JsonObject field = entity.getAsJsonArray("children")
            .get(0).getAsJsonObject().getAsJsonObject("field.long");
        assertEquals("weekIds", field.get("name").getAsString());
        assertTrue("isArray on the canonical body", field.get("isArray").getAsBoolean());
    }

    @Test
    public void invalidYaml_surfacesMalformedYamlCode() {
        // Unclosed flow mapping → SnakeYAML rejects the document.
        String yaml = "metadata: { unclosed: ";
        ParserYaml parser = new ParserYaml(loader, "bad.yaml");
        try {
            parser.loadFromStream(bytes(yaml));
            fail("expected MetaDataException for invalid YAML");
        } catch (MetaDataException ex) {
            assertEquals("ERR_MALFORMED_YAML code",
                ErrorCode.ERR_MALFORMED_YAML, ex.getCode().orElseThrow());
        }
    }

    @Test
    public void coercionInStringAttr_surfacesYamlCoercionCode_inLoadPath() {
        // The single-error loader contract surfaces the FIRST collected desugar error.
        // Authoring an unquoted boolean for a string-typed attr fires ERR_YAML_COERCION.
        String yaml =
            "metadata:\n" +
            "  children:\n" +
            "    - object.entity:\n" +
            "        name: Product\n" +
            "        children:\n" +
            "          - field.string:\n" +
            "              name: active\n" +
            "              column: TRUE\n";

        ParserYaml parser = new ParserYaml(loader, "coerce.yaml");
        try {
            parser.loadFromStream(bytes(yaml));
            fail("expected MetaDataException for ERR_YAML_COERCION");
        } catch (MetaDataException ex) {
            assertEquals(ErrorCode.ERR_YAML_COERCION, ex.getCode().orElseThrow());
        }
    }

    @Test
    public void parseYamlCollecting_returnsAllDiagnostics_andDoesNotThrow() {
        // The multi-error contract DOES NOT throw on coercion. The conformance harness
        // uses this entrypoint to union desugar errors with subsequent buildTree
        // validation errors.
        String yaml =
            "metadata:\n" +
            "  children:\n" +
            "    - object.entity:\n" +
            "        name: Product\n" +
            "        children:\n" +
            "          - field.string:\n" +
            "              name: active\n" +
            "              column: TRUE\n";

        ParserYaml parser = new ParserYaml(loader, "collect.yaml");
        ParserYaml.YamlResult result = parser.parseYamlCollecting(bytes(yaml));
        assertEquals("one coercion error collected", 1, result.errors.size());
        assertEquals(ErrorCode.ERR_YAML_COERCION, result.errors.get(0).code);
        // The canonical is still usable (the coercion does not halt desugar).
        assertTrue(result.canonical.has("metadata.root"));
    }

    private static InputStream bytes(String s) {
        return new ByteArrayInputStream(s.getBytes(StandardCharsets.UTF_8));
    }
}

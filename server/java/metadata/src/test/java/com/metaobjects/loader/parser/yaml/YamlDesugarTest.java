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
import com.metaobjects.MetaRoot;
import com.metaobjects.object.MetaObject;
import com.metaobjects.registry.MetaDataRegistry;
import org.junit.Before;
import org.junit.Test;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

/**
 * Unit tests for {@link YamlDesugar} — covers each of the ADR-0006 sugar rules in
 * isolation, exactly mirroring the per-rule TS tests in {@code yaml-desugar.test.ts}.
 *
 * <p>These tests construct the raw Java map shape SnakeYAML would produce (LinkedHashMap
 * + ArrayList + boxed scalars) and assert the canonical-JSON-shape output. The full
 * end-to-end fixture roundtrip is exercised by {@code YamlConformanceTest}.</p>
 */
public class YamlDesugarTest {

    private MetaDataRegistry registry;

    @Before
    public void setUp() {
        // Force MetaRoot + MetaObject static blocks so default-subType mappings exist.
        // Both are on the metadata-module classpath; touching them is idempotent.
        try {
            Class.forName(MetaRoot.class.getName());
            Class.forName(MetaObject.class.getName());
        } catch (ClassNotFoundException e) {
            throw new AssertionError(e);
        }
        registry = MetaDataRegistry.getInstance();
    }

    // -----------------------------------------------------------------------
    // Rule 1 — fused-key default subType
    // -----------------------------------------------------------------------

    @Test
    public void rule1_bareMetadataKey_fusesToMetadataRoot() {
        // metadata: {}
        Map<String, Object> doc = singleton("metadata", new LinkedHashMap<>());
        YamlDesugar.DesugarResult result = YamlDesugar.desugar(doc, registry);

        assertEquals("no errors", 0, result.errors.size());
        assertTrue("canonical has metadata.root wrapper",
            result.canonical.has("metadata.root"));
    }

    @Test
    public void rule1_bareObjectKey_fusesToObjectEntity() {
        // object: { name: Foo }
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("name", "Foo");
        Map<String, Object> doc = singleton("object", body);
        YamlDesugar.DesugarResult result = YamlDesugar.desugar(doc, registry);

        assertEquals("no errors", 0, result.errors.size());
        assertTrue("canonical has object.entity wrapper",
            result.canonical.has("object.entity"));
        assertEquals("name carries through",
            "Foo", result.canonical.getAsJsonObject("object.entity").get("name").getAsString());
    }

    @Test
    public void rule1_alreadyFusedKey_passesThrough() {
        // field.string: { name: sku }
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("name", "sku");
        Map<String, Object> doc = singleton("field.string", body);
        YamlDesugar.DesugarResult result = YamlDesugar.desugar(doc, registry);

        assertEquals(0, result.errors.size());
        assertTrue(result.canonical.has("field.string"));
    }

    @Test
    public void rule1_unknownBareKey_collectsErrorAndPassesThrough() {
        // bogusType: {}
        Map<String, Object> doc = singleton("bogusType", new LinkedHashMap<>());
        YamlDesugar.DesugarResult result = YamlDesugar.desugar(doc, registry);

        assertEquals("one collected error", 1, result.errors.size());
        assertTrue("error mentions default subType",
            result.errors.get(0).message.contains("no default subType"));
        // The key passes through as the original (unresolved) for downstream reporting.
        assertTrue(result.canonical.has("bogusType"));
    }

    // -----------------------------------------------------------------------
    // Rule 2 — scalar-or-map body
    // -----------------------------------------------------------------------

    @Test
    public void rule2_scalarStringBody_becomesNameKey() {
        // field.long[]: weekIds   — Rule 4 strips [], Rule 2 wraps scalar
        // Use a non-array case: field.string: sku
        Map<String, Object> doc = singleton("field.string", "sku");
        YamlDesugar.DesugarResult result = YamlDesugar.desugar(doc, registry);

        assertEquals(0, result.errors.size());
        JsonObject body = result.canonical.getAsJsonObject("field.string");
        assertEquals("sku", body.get("name").getAsString());
    }

    @Test
    public void rule2_nullBody_becomesEmptyObject() {
        // field.string:  (null body)
        Map<String, Object> doc = singleton("field.string", null);
        YamlDesugar.DesugarResult result = YamlDesugar.desugar(doc, registry);

        assertEquals(0, result.errors.size());
        JsonObject body = result.canonical.getAsJsonObject("field.string");
        assertEquals("empty body", 0, body.size());
    }

    @Test
    public void rule2_listBody_collectsError() {
        // field.string: [bad]
        Map<String, Object> doc = singleton("field.string",
            new ArrayList<>(Arrays.asList("bad")));
        YamlDesugar.DesugarResult result = YamlDesugar.desugar(doc, registry);

        assertEquals(1, result.errors.size());
        assertTrue(result.errors.get(0).message.contains("must be a scalar or mapping"));
    }

    // -----------------------------------------------------------------------
    // Rule 4 — []-suffix on the key
    // -----------------------------------------------------------------------

    @Test
    public void rule4_arraySuffix_stripsKeyAndSetsIsArray() {
        // field.long[]: weekIds
        Map<String, Object> doc = singleton("field.long[]", "weekIds");
        YamlDesugar.DesugarResult result = YamlDesugar.desugar(doc, registry);

        assertEquals(0, result.errors.size());
        assertTrue("key is stripped to field.long",
            result.canonical.has("field.long"));
        JsonObject body = result.canonical.getAsJsonObject("field.long");
        assertEquals("weekIds", body.get("name").getAsString());
        assertTrue("isArray: true is stamped on the body",
            body.has("isArray") && body.get("isArray").getAsBoolean());
    }

    // -----------------------------------------------------------------------
    // Rule 5 / D1 — sigil-free attrs are @-prefixed
    // -----------------------------------------------------------------------

    @Test
    public void rule5_sigilFreeAttrs_getPrefixedWithAt() {
        // field.string: { name: sku, column: sku_code, required: true }
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("name", "sku");
        body.put("column", "sku_code");
        body.put("required", true);
        Map<String, Object> doc = singleton("field.string", body);
        YamlDesugar.DesugarResult result = YamlDesugar.desugar(doc, registry);

        assertEquals("D2 schema-aware path: column is string-typed so no coercion; required is boolean-typed and the boolean true is correct",
            0, result.errors.size());
        JsonObject out = result.canonical.getAsJsonObject("field.string");
        assertEquals("sku", out.get("name").getAsString());
        assertEquals("sku_code", out.get("@column").getAsString());
        assertTrue(out.get("@required").getAsBoolean());
        // The bare-named keys are NOT present (they were rewritten with @-prefix).
        assertFalse(out.has("column"));
        assertFalse(out.has("required"));
    }

    @Test
    public void rule5_reservedKeys_stayBare() {
        // object.entity: { name: P, package: acme, extends: Base, abstract: true,
        //                  overlay: true, isArray: true, children: [] }
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("name", "P");
        body.put("package", "acme");
        body.put("extends", "Base");
        body.put("abstract", true);
        body.put("overlay", true);
        body.put("isArray", true);
        body.put("children", new ArrayList<>());
        Map<String, Object> doc = singleton("object.entity", body);
        YamlDesugar.DesugarResult result = YamlDesugar.desugar(doc, registry);

        assertEquals(0, result.errors.size());
        JsonObject out = result.canonical.getAsJsonObject("object.entity");
        for (String k : Arrays.asList("name", "package", "extends", "abstract",
            "overlay", "isArray", "children")) {
            assertTrue("reserved key " + k + " kept bare", out.has(k));
            assertFalse("reserved key " + k + " not @-prefixed", out.has("@" + k));
        }
    }

    @Test
    public void rule5_alreadyAtPrefixedAttrs_passThrough() {
        // field.string: { name: sku, "@column": sku_code }
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("name", "sku");
        body.put("@column", "sku_code");
        Map<String, Object> doc = singleton("field.string", body);
        YamlDesugar.DesugarResult result = YamlDesugar.desugar(doc, registry);

        assertEquals(0, result.errors.size());
        JsonObject out = result.canonical.getAsJsonObject("field.string");
        assertEquals("sku_code", out.get("@column").getAsString());
    }

    // -----------------------------------------------------------------------
    // Rule D2 — type-coercion guard
    // -----------------------------------------------------------------------

    @Test
    public void d2_unquotedBooleanInStringAttr_emitsCoercion() {
        // field.string: { name: active, column: TRUE }
        //   `column` is a string-typed attr; YAML coerces unquoted TRUE → boolean true.
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("name", "active");
        body.put("column", Boolean.TRUE);
        Map<String, Object> doc = singleton("field.string", body);
        YamlDesugar.DesugarResult result = YamlDesugar.desugar(doc, registry);

        assertEquals("one coercion error", 1, result.errors.size());
        assertEquals("stable error code",
            ErrorCode.ERR_YAML_COERCION, result.errors.get(0).code);
        assertTrue("error mentions the attr name",
            result.errors.get(0).message.contains("@column"));
        assertTrue("error hints at quoting",
            result.errors.get(0).message.contains("quote it"));
    }

    @Test
    public void d2_numberInStringArrayElement_emitsCoercion() {
        // field.enum: { name: status, values: [DRAFT, 42, PUBLISHED] }
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("name", "status");
        body.put("values", new ArrayList<>(Arrays.asList("DRAFT", 42, "PUBLISHED")));
        Map<String, Object> doc = singleton("field.enum", body);
        YamlDesugar.DesugarResult result = YamlDesugar.desugar(doc, registry);

        // Note: the per-element coercion fires because @values is declared as a
        // string-array attr.
        assertTrue("at least one coercion error",
            result.errors.size() >= 1);
        assertEquals("first error is coercion",
            ErrorCode.ERR_YAML_COERCION, result.errors.get(0).code);
        assertTrue("error mentions @values[1]",
            result.errors.get(0).message.contains("@values[1]"));
    }

    @Test
    public void d2_bareStringForStringArrayAttr_isLegit() {
        // identity.primary: { name: pk, fields: id }
        // A bare-string at a stringarray attr position is the legitimate one-element
        // authoring shorthand (parallels TS / Python). No coercion.
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("name", "pk");
        body.put("fields", "id");
        Map<String, Object> doc = singleton("identity.primary", body);
        YamlDesugar.DesugarResult result = YamlDesugar.desugar(doc, registry);

        assertEquals("no errors", 0, result.errors.size());
    }

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    private static Map<String, Object> singleton(String key, Object value) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put(key, value);
        return m;
    }
}

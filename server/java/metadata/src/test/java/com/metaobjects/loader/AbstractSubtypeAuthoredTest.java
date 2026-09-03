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
package com.metaobjects.loader;

import com.metaobjects.ErrorCode;
import com.metaobjects.MetaDataException;
import com.metaobjects.registry.SharedRegistryTestBase;
import org.junit.Test;

import java.util.Collections;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

/**
 * An authored {@code <type>.base} is refused with {@code ERR_ABSTRACT_SUBTYPE_AUTHORED}.
 *
 * <p>Every registered {@code base} subtype is the shared root that concrete subtypes inherit
 * their attrs and child rules from. It has no runtime semantics and no concrete
 * representation: {@code spec/metamodel/object.json} says so in as many words ("Has no
 * runtime semantics of its own; not authored directly"), and every {@code base} entry's
 * description in the byte-gated registry manifest opens with "Abstract".</p>
 *
 * <p>This port already refused the shape, but by ACCIDENT and with an unhelpful message: its
 * impl classes are {@code public abstract}, so instantiation failed with a raw missing-
 * constructor cause that named neither the rule nor the node. TypeScript, C# and Python
 * accepted it outright, so the same document loaded on three ports and failed to load on two
 * — the cross-port conformance gap the corpora exist to catch. It survived because every
 * {@code *.base} subtype sits in the registry corpus's own {@code untestedSubTypes} list;
 * {@code fixtures/conformance/error-abstract-subtype-authored} closes that.</p>
 *
 * <p>Also covers Kotlin — Kotlin inherits the JVM loader.</p>
 */
public class AbstractSubtypeAuthoredTest extends SharedRegistryTestBase {

    private MetaDataLoader load(String node, String id) {
        MetaDataLoader loader = createTestLoader(
            "AbstractSubtypeAuthoredTest-" + id, Collections.emptyList());
        String json = "{ \"metadata.root\": { \"package\": \"acme\", \"children\": [ "
            + node + " ] } }";
        loader.load(List.of(new InMemoryStringSource(json, id + ".json")));
        return loader;
    }

    private void assertRefused(String label, String node, String id) {
        MetaDataLoader loader = load(node, id);
        MetaDataException err = loader.getErrors().stream()
            .filter(e -> e.getCode().orElse(null) == ErrorCode.ERR_ABSTRACT_SUBTYPE_AUTHORED)
            .findFirst()
            .orElseThrow(() -> new AssertionError(
                "expected ERR_ABSTRACT_SUBTYPE_AUTHORED for " + label
                    + "; got " + loader.getErrors()));
        assertTrue(err.getMessage(), err.getMessage().contains(label));
        assertTrue(err.getMessage(), err.getMessage().contains("abstract registry anchor"));
    }

    // Every registered base subtype, authored in a position its type is legal in.

    @Test
    public void objectBaseIsRefused() {
        assertRefused("object.base",
            "{ \"object.base\": { \"name\": \"P\", \"children\": ["
                + " { \"field.long\": { \"name\": \"id\" } } ] } }", "obj");
    }

    @Test
    public void fieldBaseIsRefused() {
        assertRefused("field.base",
            "{ \"object.entity\": { \"name\": \"E1\", \"children\": ["
                + " { \"field.base\": { \"name\": \"f\" } } ] } }", "fld");
    }

    @Test
    public void sourceBaseIsRefused() {
        assertRefused("source.base",
            "{ \"object.entity\": { \"name\": \"E2\", \"children\": ["
                + " { \"source.base\": { \"name\": \"s\" } },"
                + " { \"field.long\": { \"name\": \"id\" } } ] } }", "src");
    }

    @Test
    public void validatorBaseIsRefused() {
        assertRefused("validator.base",
            "{ \"object.entity\": { \"name\": \"E3\", \"children\": ["
                + " { \"field.string\": { \"name\": \"s\", \"children\": ["
                + " { \"validator.base\": { \"name\": \"v\" } } ] } } ] } }", "val");
    }

    @Test
    public void viewBaseIsRefused() {
        assertRefused("view.base",
            "{ \"object.entity\": { \"name\": \"E4\", \"children\": ["
                + " { \"field.string\": { \"name\": \"s\", \"children\": ["
                + " { \"view.base\": { \"name\": \"v\" } } ] } } ] } }", "view");
    }

    @Test
    public void attrBaseIsRefused() {
        assertRefused("attr.base",
            "{ \"object.entity\": { \"name\": \"E5\", \"children\": ["
                + " { \"field.string\": { \"name\": \"s\", \"children\": ["
                + " { \"attr.base\": { \"name\": \"a\", \"value\": \"x\" } } ] } } ] } }", "attr");
    }

    // --- the OTHER spelling ---------------------------------------------------
    //
    // A BARE wrapper key omits the subType, so the type's DECLARED default decides — the same
    // accessor the YAML desugar consults, whose contract the shared corpus already pins
    // (yaml-bare-default-subtypes: bare `object:` becomes `object.entity`). Only a type
    // declaring NO default is refused, and then with ERR_MISSING_SUBTYPE: the author omitted a
    // subType, they did not author an anchor.
    //
    // Four ports gave three answers here. This one hardcoded the anchor and then failed to
    // INSTANTIATE it, naming a missing constructor rather than the rule; TypeScript and C#
    // guessed at registration order (landing on the anchor too) and LOADED; Python refused
    // every bare key outright, so raw JSON and desugared YAML meant different things there.

    private void assertBareRefused(String label, String node, String id) {
        MetaDataLoader loader = load(node, id);
        MetaDataException err = loader.getErrors().stream()
            .filter(e -> e.getCode().orElse(null) == ErrorCode.ERR_MISSING_SUBTYPE)
            .findFirst()
            .orElseThrow(() -> new AssertionError(
                "expected ERR_MISSING_SUBTYPE for bare '" + label + "'; got " + loader.getErrors()));
        assertTrue(err.getMessage(), err.getMessage().contains(label));
        assertTrue(err.getMessage(), err.getMessage().contains("has no default subType"));
    }

    // The ROOT door. Every parser states "one rule, both doors" in a comment, and only the
    // CHILD door was ever tested — in any port. The root wrapper key is a separate code path
    // with a separate throw.

    private MetaDataLoader loadRoot(String json, String id) {
        MetaDataLoader loader = createTestLoader(
            "AbstractSubtypeAuthoredTest-" + id, Collections.emptyList());
        loader.load(List.of(new InMemoryStringSource(json, id + ".json")));
        return loader;
    }

    /**
     * The root door THROWS rather than collecting — a document whose root wrapper key is
     * unusable has no tree to build around the failure, unlike a child, which is recorded and
     * skipped so the rest of the tree still loads. Asserting on {@code getErrors()} here would
     * pass vacuously if the throw were ever replaced by a collected error.
     */
    private void assertRootCode(String json, String id, ErrorCode expected) {
        try {
            loadRoot(json, id);
            fail("expected " + expected + " to be thrown from the root door");
        } catch (MetaDataException e) {
            assertEquals(e.getMessage(), expected, e.getCode().orElse(null));
        }
    }

    @Test
    public void theRootDoorRefusesAnAuthoredBase() {
        assertRootCode("{ \"object.base\": { \"name\": \"P\" } }", "root-base",
            ErrorCode.ERR_ABSTRACT_SUBTYPE_AUTHORED);
    }

    @Test
    public void theRootDoorRefusesABareKeyWithNoDeclaredDefault() {
        assertRootCode("{ \"field\": { \"name\": \"f\" } }", "root-bare",
            ErrorCode.ERR_MISSING_SUBTYPE);
    }

    /**
     * The missing-subtype throw runs before the registration check, so without a guard a
     * typo'd root key is diagnosed as a registered type that merely lacks a default.
     */
    @Test
    public void anUnregisteredBareRootTypeIsStillAnUnknownType() {
        assertRootCode("{ \"bogus\": { \"name\": \"P\" } }", "root-bogus",
            ErrorCode.ERR_UNKNOWN_TYPE);
    }

    /**
     * The control the refusals must not swallow. {@code object} DECLARES a default, and the
     * YAML corpus pins bare {@code object:} to {@code object.entity} cross-port; a JSON bare
     * key has to agree, or the two input formats mean different things.
     */
    @Test
    public void bareObjectKeyStillResolvesToObjectEntity() {
        MetaDataLoader loader = load(
            "{ \"object\": { \"name\": \"Product\", \"children\": ["
                + " { \"field.string\": { \"name\": \"sku\" } } ] } }", "bare-obj");
        assertEquals("expected a clean load, got " + loader.getErrors(),
            0, loader.getErrors().size());
        assertEquals("entity", loader.getMetaObjects().stream()
            .filter(o -> o.getName().endsWith("::Product")).findFirst().orElseThrow().getSubType());
    }

    @Test
    public void bareFieldKeyIsRefused() {
        assertBareRefused("field",
            "{ \"object.entity\": { \"name\": \"B1\", \"children\": ["
                + " { \"field\": { \"name\": \"f\" } } ] } }", "bare-fld");
    }

    @Test
    public void bareSourceKeyIsRefused() {
        assertBareRefused("source",
            "{ \"object.entity\": { \"name\": \"B2\", \"children\": ["
                + " { \"source\": { \"name\": \"s\" } },"
                + " { \"field.long\": { \"name\": \"id\" } } ] } }", "bare-src");
    }

    @Test
    public void bareViewKeyIsRefused() {
        assertBareRefused("view",
            "{ \"object.entity\": { \"name\": \"B3\", \"children\": ["
                + " { \"field.string\": { \"name\": \"s\", \"children\": ["
                + " { \"view\": { \"name\": \"v\" } } ] } } ] } }", "bare-view");
    }

    /** The control arm. Without it, a check that refused every node would pass above. */
    @Test
    public void theConcreteSiblingOfEveryRefusedCaseStillLoads() {
        MetaDataLoader loader = load(
            "{ \"object.entity\": { \"name\": \"Fine\", \"children\": ["
                + " { \"source.rdb\": { \"name\": \"primary\", \"@table\": \"fines\" } },"
                + " { \"field.long\": { \"name\": \"id\" } },"
                + " { \"field.string\": { \"name\": \"s\", \"children\": ["
                + " { \"validator.required\": {} } ] } },"
                + " { \"field.currency\": { \"name\": \"price\", \"@currency\": \"USD\","
                + " \"children\": [ { \"view.currency\": { \"name\": \"v\" } } ] } },"
                + " { \"identity.primary\": { \"name\": \"pk\", \"@fields\": [\"id\"] } }"
                + " ] } }", "fine");
        assertEquals("expected a clean load, got " + loader.getErrors(),
            0, loader.getErrors().size());
    }

    /**
     * {@code attr.base} is REAL — it is what an untyped {@code @default} resolves to, with
     * its value type following the owning field. The loader picks it; an author never names
     * it. The rule refuses the authored spelling and must leave this path alone.
     */
    @Test
    public void anInlineDefaultStillReachesThePolymorphicAttrSubtype() {
        MetaDataLoader loader = load(
            "{ \"object.entity\": { \"name\": \"Item\", \"children\": ["
                + " { \"source.rdb\": { \"name\": \"primary\", \"@table\": \"items\" } },"
                + " { \"field.long\": { \"name\": \"id\" } },"
                + " { \"field.boolean\": { \"name\": \"enabled\", \"@default\": false } },"
                + " { \"identity.primary\": { \"name\": \"pk\", \"@fields\": [\"id\"] } }"
                + " ] } }", "inline-default");
        assertEquals("expected a clean load, got " + loader.getErrors(),
            0, loader.getErrors().size());
    }
}

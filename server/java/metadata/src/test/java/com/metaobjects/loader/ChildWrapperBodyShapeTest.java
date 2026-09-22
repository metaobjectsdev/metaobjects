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

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * A child wrapper's BODY must be an object (in LAX mode as well as strict), and an
 * unregistered child key is an unknown TYPE rather than a missing subType.
 *
 * <p>The conformance corpus runs the loader STRICT, so
 * {@code fixtures/conformance/error-child-not-object} and
 * {@code .../error-unknown-bare-child-type} prove the rule only on that path. This port had
 * the weakest lax behaviour of the four: a non-object child body went to an slf4j
 * {@code log.warn} and never reached {@link MetaDataLoader#getErrors()} at all, so the child
 * was dropped and the load succeeded entirely clean — a declared field simply not there.</p>
 *
 * <p>The body rule is therefore asserted in BOTH modes, and is deliberately NOT gated on
 * {@code isStrictLoad()} in the parser: lax mode tolerates an UNENFORCED TYPE, which it has
 * always done and still does (see {@code laxStillTolerates*} below); it has never meant
 * "accept input with no node in it". The KEY rule keeps the existing lax tolerance, so its
 * assertions are strict-only — stating that split here rather than leaving a reader to infer
 * it from which assertions happen to exist.</p>
 *
 * <p>Also covers Kotlin — Kotlin inherits the JVM loader.</p>
 */
public class ChildWrapperBodyShapeTest extends SharedRegistryTestBase {

    private MetaDataLoader load(String child, String id) {
        return load(child, id, true);
    }

    private MetaDataLoader load(String child, String id, boolean strict) {
        MetaDataLoader loader = createTestLoader(
            "ChildWrapperBodyShapeTest-" + id + (strict ? "" : "-lax"), Collections.emptyList());
        loader.getLoaderOptions().setStrict(strict);
        String json = "{ \"metadata.root\": { \"package\": \"acme\", \"children\": [ "
            + "{ \"object.entity\": { \"name\": \"Account\", \"children\": [ "
            + "  { \"field.long\": { \"name\": \"id\" } }, "
            + child + ", "
            + "  { \"identity.primary\": { \"name\": \"pk\", \"@fields\": [\"id\"] } } "
            + "] } } ] } }";
        loader.load(List.of(new InMemoryStringSource(json, id + ".json")));
        return loader;
    }

    private void assertCode(String id, String child, ErrorCode expected) {
        MetaDataLoader loader = load(child, id);
        assertTrue("expected " + expected + " for " + child + "; got " + loader.getErrors(),
            hasCode(loader, expected));
    }

    private void assertNotCode(String id, String child, ErrorCode unwanted) {
        MetaDataLoader loader = load(child, id);
        assertFalse("did not expect " + unwanted + " for " + child + "; got " + loader.getErrors(),
            hasCode(loader, unwanted));
    }

    private boolean hasCode(MetaDataLoader loader, ErrorCode code) {
        return loader.getErrors().stream()
            .map(MetaDataException::getCode)
            .anyMatch(c -> c.orElse(null) == code);
    }

    // --- the body ---

    @Test
    public void aRegisteredTypeWithAStringBodyIsRefused() {
        assertCode("string-body", "{ \"field.string\": \"label\" }",
            ErrorCode.ERR_CHILD_NOT_OBJECT);
    }

    @Test
    public void anArrayBodyIsRefused() {
        assertCode("array-body", "{ \"field.string\": [\"label\"] }",
            ErrorCode.ERR_CHILD_NOT_OBJECT);
    }

    @Test
    public void aNullBodyIsRefused() {
        assertCode("null-body", "{ \"field.string\": null }",
            ErrorCode.ERR_CHILD_NOT_OBJECT);
    }

    /**
     * The key is judged BEFORE the body. {@code $comment} is not a node, so telling the
     * author to give it a node body would send them to wrap prose that was never a node.
     */
    @Test
    public void anUnknownKeyWithANonObjectBodyIsAnUnknownType() {
        assertCode("comment", "{ \"$comment\": \"prose\" }", ErrorCode.ERR_UNKNOWN_TYPE);
        assertNotCode("comment-not", "{ \"$comment\": \"prose\" }",
            ErrorCode.ERR_CHILD_NOT_OBJECT);
    }

    /**
     * The ATTR door is a separate branch, so the rule needs asserting on it separately.
     * Python's is a separate FUNCTION, and fixing only the structural door left it
     * answering ERR_MISSING_REQUIRED_ATTR — the consequence of coercing the body to an
     * empty map, not the cause.
     */
    @Test
    public void anAttrChildWithANonObjectBodyIsRefused() {
        String child = "{ \"field.string\": { \"name\": \"s\", \"children\": [ "
            + "{ \"attr.string\": \"a note\" } ] } }";
        assertCode("attr-body", child, ErrorCode.ERR_CHILD_NOT_OBJECT);
        assertNotCode("attr-body-not", child, ErrorCode.ERR_MISSING_REQUIRED_ATTR);
    }

    // --- the key ---

    /**
     * The root door has carried the registration-first guard (and
     * {@link AbstractSubtypeAuthoredTest#anUnregisteredBareRootTypeIsStillAnUnknownType}
     * pins it); the child door did not, so {@code madeup} was answered with "write the full
     * 'madeup.&lt;subType&gt;'" — advice about a type that does not exist.
     */
    @Test
    public void anUnregisteredBareChildKeyIsAnUnknownType() {
        assertCode("bare-unknown", "{ \"madeup\": { \"name\": \"label\" } }",
            ErrorCode.ERR_UNKNOWN_TYPE);
        assertNotCode("bare-unknown-not", "{ \"madeup\": { \"name\": \"label\" } }",
            ErrorCode.ERR_MISSING_SUBTYPE);
    }

    /**
     * The control the guard must not swallow: {@code identity} IS registered and declares no
     * default subType, so it keeps ERR_MISSING_SUBTYPE — that advice is correct for it.
     */
    @Test
    public void aRegisteredTypeWithNoDeclaredDefaultStillReportsMissingSubtype() {
        assertCode("bare-identity", "{ \"identity\": { \"name\": \"alt\" } }",
            ErrorCode.ERR_MISSING_SUBTYPE);
        assertNotCode("bare-identity-not", "{ \"identity\": { \"name\": \"alt\" } }",
            ErrorCode.ERR_UNKNOWN_TYPE);
    }

    // --- the body rule holds in LAX mode too ---

    @Test
    public void laxAlsoRefusesANonObjectChildBody() {
        MetaDataLoader loader = load("{ \"field.string\": \"label\" }", "lax-string-body", false);
        assertTrue("lax must still refuse a bodyless child; got " + loader.getErrors(),
            hasCode(loader, ErrorCode.ERR_CHILD_NOT_OBJECT));
    }

    /**
     * The control for the clause above: lax mode's tolerance of an UNENFORCED TYPE is
     * unchanged. Without this the body rule's lax arm could be "fixed" by making lax strict,
     * which is a different and much larger change than the one this test defends.
     */
    @Test
    public void laxStillToleratesAnUnknownChildType() {
        MetaDataLoader loader = load("{ \"madeup\": { \"name\": \"label\" } }",
            "lax-unknown-type", false);
        assertFalse("lax must still tolerate an unknown type; got " + loader.getErrors(),
            hasCode(loader, ErrorCode.ERR_UNKNOWN_TYPE));
    }

    @Test
    public void theUnknownTypeErrorNamesTheTypeWithoutATrailingDot() {
        MetaDataLoader loader = load("{ \"madeup\": { \"name\": \"label\" } }", "trailing-dot");
        String msg = loader.getErrors().stream()
            .filter(e -> e.getCode().orElse(null) == ErrorCode.ERR_UNKNOWN_TYPE)
            .map(Throwable::getMessage)
            .findFirst()
            .orElseThrow(() -> new AssertionError("no ERR_UNKNOWN_TYPE: " + loader.getErrors()));
        assertTrue(msg, msg.contains("'madeup'"));
        assertFalse(msg, msg.contains("'madeup.'"));
    }
}

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

import com.metaobjects.MetaDataException;
import com.metaobjects.io.json.CanonicalJsonSerializer;
import org.junit.Test;

import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

/**
 * ADR-0059 R3/R10: a node records the default package of the FILE that declared it. A nested
 * node merged in from an overlay file with a different default package resolves its bare
 * {@code extends} in THAT file's package, not in the overlaid top-level node's package.
 * Pinned against the TypeScript reference, which gives the same results for these two texts.
 */
public class OverlayFileDefaultPackageTest {

    private static final String A = "{\"metadata.root\":{\"package\":\"a\",\"children\":["
        + "{\"object.entity\":{\"name\":\"Order\",\"children\":[]}},"
        + "{\"object.entity\":{\"name\":\"Base\",\"children\":[{\"field.long\":{\"name\":\"id\"}}]}}]}}";

    private static String b(String ref) {
        return "{\"metadata.root\":{\"package\":\"b\",\"children\":["
            + "{\"object.entity\":{\"name\":\"Base\",\"children\":[{\"field.long\":{\"name\":\"bid\"}}]}},"
            + "{\"object.entity\":{\"name\":\"Order\",\"package\":\"a\",\"overlay\":true,\"children\":["
            + "{\"field.long\":{\"name\":\"x\",\"extends\":\"" + ref + "\"}}]}}]}}";
    }

    private static MetaDataLoader load(String ref) {
        MetaDataLoader loader = new MetaDataLoader(LoaderOptions.create(false, false, true),
            MetaDataLoader.SUBTYPE_MANUAL, "");
        loader.init();
        try {
            loader.load(List.of(new InMemoryStringSource(A, "a.json"),
                new InMemoryStringSource(b(ref), "b.json")));
        } catch (MetaDataException ex) {
            loader.addError(ex);
        }
        return loader;
    }

    @Test
    public void bareExtendsResolvesInTheOverlayFilesPackage() {
        MetaDataLoader loader = load("Base.bid");
        assertTrue("unexpected errors: " + loader.getErrors(), loader.getErrors().isEmpty());
        String json = CanonicalJsonSerializer.canonicalSerialize(loader.getRoot());
        assertTrue("extends must bind b::Base.bid and spell canonically, got: " + json,
            json.contains("\"extends\": \"b::Base.bid\""));
    }

    @Test
    public void bareExtendsDoesNotFallBackToTheOverlaidNodesPackage() {
        MetaDataLoader loader = load("Base.id"); // a::Base.id exists; b::Base.id does not
        List<MetaDataException> errors = loader.getErrors();
        assertEquals("errors: " + errors, 1, errors.size());
        assertEquals("ERR_UNRESOLVED_SUPER", errors.get(0).getCode().map(Enum::name).orElse("?"));
    }
}

/*
 * Copyright 2026 Doug Mealing LLC dba Meta Objects
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
import com.metaobjects.MetaRoot;
import com.metaobjects.registry.SharedRegistryTestBase;
import org.junit.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.List;
import java.util.stream.Collectors;

import static org.junit.Assert.assertTrue;

/** F3h: a bad binding {@code @method} is reported even when the operation fails O1-O3 first. */
public class RulesValidationMethodOrderTest extends SharedRegistryTestBase {

    private static Path fixture() {
        Path dir = Paths.get("").toAbsolutePath();
        while (dir != null) {
            Path c = dir.resolve("fixtures/conformance/error-rules-binding-method-invalid/input/meta.purchasing.json");
            if (Files.isRegularFile(c)) return c;
            dir = dir.getParent();
        }
        throw new AssertionError("fixture not found");
    }

    @Test
    public void badMethodIsReportedAlongsideAnO1Failure() throws Exception {
        String json = Files.readString(fixture(), StandardCharsets.UTF_8);
        // Point the command's input at a projection: O1 (ERR_OPERATION_SHAPE) short-circuits the operation.
        String broken = json.replace("\"@inputRef\": \"DecisionInput\"", "\"@inputRef\": \"RequestSummary\"");
        assertTrue("fixture shape changed", !broken.equals(json));
        MetaDataLoader loader = new MetaDataLoader(
                LoaderOptions.create(false, false, true), MetaDataLoader.SUBTYPE_MANUAL, "rules-method-order");
        loader.setSourceURIs(java.util.Collections.emptyList());
        loader.init();
        try {
            loader.load(List.of(new InMemoryStringSource(broken, "meta.purchasing.json")));
        } catch (MetaDataException expected) {
            // the load fails on the rules; the tree is still built
        }
        MetaRoot root = loader.getRoot();
        List<ErrorCode> codes = RulesValidation.validate(root).stream()
                .map(e -> e.getCode().orElseThrow()).collect(Collectors.toList());
        assertTrue(codes.toString(), codes.contains(ErrorCode.ERR_OPERATION_SHAPE));
        assertTrue(codes.toString(), codes.contains(ErrorCode.ERR_BAD_ATTR_VALUE));
    }
}

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
package com.metaobjects.config;

import com.metaobjects.MetaDataException;
import org.junit.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

/**
 * Focused unit coverage for {@link SourceResolver#resolveSources} shapes not gated
 * by the shared {@code source-resolution-conformance} corpus.
 */
public class SourceResolverTest {

    private static Map<String, String> pathSpec(String path) {
        Map<String, String> m = new LinkedHashMap<>();
        m.put("path", path);
        return m;
    }

    // F12 — Pass 2 resolves in CONTENT order (natural string ordering of each
    // spec's `path`), not declared order, mirroring the TypeScript reference's
    // `orderedPathSpecs` (`sources.ts`: kind-validated, then sorted by
    // `JSON.stringify(spec)`, which for a validated `path`-only spec reduces to
    // the path string alone — verified empirically: `resolveSources(dir,
    // [{path:"zzz-missing"},{path:"aaa-missing"}])` names "aaa-missing", the
    // content-first one, even though "zzz-missing" is declared first). With
    // BOTH paths unresolvable, only a port that content-sorts before Pass 2
    // names "aaa-missing" here; a declared-order implementation names
    // "zzz-missing" instead.
    @Test
    public void twoUnresolvablePathsReportsTheContentFirstOne() throws IOException {
        Path root = Files.createTempDirectory("source-resolver-order-");
        try {
            List<Map<String, String>> specs = List.of(pathSpec("zzz-missing"), pathSpec("aaa-missing"));
            MetaDataException ex = assertThrows(MetaDataException.class,
                    () -> SourceResolver.resolveSources(root, specs));
            assertTrue("expected \"aaa-missing\" (content-first) in: " + ex.getMessage(),
                    ex.getMessage().contains("aaa-missing"));
            assertTrue("must NOT name \"zzz-missing\" (declared-first, content-second): " + ex.getMessage(),
                    !ex.getMessage().contains("zzz-missing"));
        } finally {
            Files.delete(root);
        }
    }
}

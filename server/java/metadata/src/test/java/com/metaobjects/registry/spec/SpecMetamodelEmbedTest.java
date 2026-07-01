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
package com.metaobjects.registry.spec;

import org.junit.Test;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.fail;

/**
 * FR-033 byte-identity gate — the spec/metamodel/*.json embedded into the metadata
 * jar (by the maven-resources-plugin copy) must be byte-for-byte identical to the
 * repo-root source. The descriptions are the cross-port single source of truth; a
 * silently-stale embedded copy would let the Java port drift from TS undetected.
 */
public class SpecMetamodelEmbedTest {

    @Test
    public void embeddedSpecFilesMatchRepoRootSourceByteForByte() {
        Path specDir = locateRepoRootSpecDir();
        ClassLoader loader = SpecMetamodelReader.class.getClassLoader();

        for (String file : SpecMetamodelReader.SPEC_FILES) {
            String resource = SpecMetamodelReader.EMBED_DIR + "/" + file;
            byte[] embedded;
            try (InputStream in = loader.getResourceAsStream(resource)) {
                assertNotNull("Embedded spec file missing from classpath: " + resource
                        + " (the maven-resources-plugin copy must bundle it).", in);
                embedded = in.readAllBytes();
            } catch (Exception e) {
                throw new AssertionError("Failed reading embedded " + resource, e);
            }

            byte[] source;
            try {
                source = Files.readAllBytes(specDir.resolve(file));
            } catch (Exception e) {
                throw new AssertionError("Failed reading repo-root spec/metamodel/" + file, e);
            }

            // Newline-normalize so a CRLF checkout can't mask a real divergence.
            String embeddedNorm = new String(embedded, StandardCharsets.UTF_8).replace("\r\n", "\n");
            String sourceNorm = new String(source, StandardCharsets.UTF_8).replace("\r\n", "\n");
            assertEquals("Embedded spec/metamodel/" + file + " diverges from the repo-root source "
                    + "(FR-033 single-source rule). Re-run the build so the resources copy refreshes.",
                    sourceNorm, embeddedNorm);
        }
    }

    @Test
    public void readerLoadsEveryEmbeddedFile() {
        // Smoke: the reader parses all 16 files off the classpath without throwing
        // and exposes a non-trivial set of type docs + the common-attr docs.
        SpecMetamodelReader reader = SpecMetamodelReader.load();
        assertNotNull("documentation @description common-attr doc must resolve",
                reader.commonAttrDoc("description"));
        assertNotNull("field.string type doc must resolve",
                reader.typeDoc("field", "string"));
        assertNotNull("field.string @maxLength attr doc must resolve",
                reader.attrDoc("field", "string", "maxLength"));
    }

    /** Walk up from the working dir to the {@code fixtures/} sibling to find {@code spec/metamodel}. */
    private static Path locateRepoRootSpecDir() {
        Path dir = Paths.get("").toAbsolutePath();
        while (dir != null) {
            Path candidate = dir.resolve("spec/metamodel");
            if (Files.isDirectory(candidate)) {
                return candidate;
            }
            dir = dir.getParent();
        }
        fail("Could not locate spec/metamodel by walking up from " + Paths.get("").toAbsolutePath());
        return null; // unreachable
    }
}

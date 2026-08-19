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

import com.metaobjects.ErrorCode;
import com.metaobjects.MetaDataException;
import org.junit.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

/**
 * Focused unit coverage for {@link NeutralConfig#read} on shapes NOT gated by the
 * shared {@code source-resolution-conformance} corpus — either because the
 * reference TypeScript implementation deliberately behaves differently
 * (whitespace-only path) or to pin a prior defect class directly.
 */
public class NeutralConfigTest {

    private static Path writeConfig(String payloadJson) throws IOException {
        Path dir = Files.createTempDirectory("neutral-config-");
        Path cfgDir = Files.createDirectories(dir.resolve(".metaobjects"));
        Files.write(cfgDir.resolve("config.json"), payloadJson.getBytes(StandardCharsets.UTF_8));
        return dir;
    }

    @Test
    public void whitespaceOnlyPathRaises() throws IOException {
        // Deliberately NOT gated by the shared cross-port corpus: the TS
        // reference (`config.ts`'s `z.string().min(1)`) rejects only a
        // fully-empty path, not a whitespace-only one, and the reference is out
        // of scope to change here. This port is stricter on this one edge case
        // by design.
        Path dir = writeConfig("{ \"schema_version\": 1, \"sources\": [ { \"path\": \"   \" } ] }");
        assertThrows(MetaDataException.class, () -> NeutralConfig.read(dir));
    }

    @Test
    public void nonStringSourceValueRaises() throws IOException {
        Path dir = writeConfig("{ \"schema_version\": 1, \"sources\": [ { \"path\": 123 } ] }");
        MetaDataException ex = assertThrows(MetaDataException.class, () -> NeutralConfig.read(dir));
        assertEquals(ErrorCode.ERR_BAD_ATTR_VALUE, ex.getCode().orElseThrow());
    }
}

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

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

import static org.junit.Assert.assertTrue;

/**
 * Deliberately NOT part of {@link SourceResolutionConformanceTest}'s
 * {@code @RunWith(Parameterized.class)} run: JUnit4's {@code Parameterized} runner
 * executes its {@code @Test} methods once PER PARAMETER ROW, so if {@code cases()}
 * ever returned zero rows — a bad path, a JSON-parsing bug, an accidental corpus
 * truncation — every {@code @Test} in that class (including a guard living inside
 * it) would run zero times and Maven would report the class GREEN, having checked
 * nothing. This is a plain, separate JUnit4 test class so it always runs exactly
 * once regardless of what the corpus contains. Mirrors the TS and Python runners'
 * identically-purposed guards ({@code source-resolution-conformance.test.ts},
 * {@code test_source_resolution_conformance.py::test_corpus_is_non_empty}).
 */
public class SourceResolutionCorpusNotEmptyTest {

    @Test
    public void corpusIsNonEmpty() throws IOException {
        String content = new String(
                Files.readAllBytes(SourceResolutionConformanceTest.corpus()), StandardCharsets.UTF_8);
        JsonObject root = JsonParser.parseString(content).getAsJsonObject();
        JsonArray cases = root.getAsJsonArray("cases");
        assertTrue("a silent zero-case corpus is a failed gate, not a pass", cases.size() > 0);
    }
}

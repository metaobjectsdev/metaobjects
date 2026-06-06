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
package com.metaobjects.loader.ai;

import com.metaobjects.field.MetaField;
import com.metaobjects.field.ObjectField;
import com.metaobjects.loader.LoaderOptions;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.loader.uri.URIHelper;
import com.metaobjects.object.MetaObject;
import org.junit.Test;

import java.net.URI;
import java.util.List;

import static org.junit.Assert.*;

/**
 * CI gate for the AI-trace field deriver (Slice 3). Mirrors the TS reference
 * {@code derive-trace-fields.test.ts}: an entity extending {@code LlmCallBase}
 * with a {@code template.prompt} carrying {@code @payloadRef}/{@code @responseRef}
 * gets {@code voRequest}/{@code voResponse} {@code field.object} jsonb columns
 * injected; entities missing either precondition are untouched; the pass is
 * idempotent; and the injected nodes survive strict validation (ADR-0023).
 */
public class LlmTraceFieldDeriverTest {

    private static MetaDataLoader load() {
        URI uri = URIHelper.toURI(
            "model:resource:com/metaobjects/loader/ai/trace-derive.yaml");
        // strict=true: prove the DERIVED field.object + @objectRef/@storage attrs
        // pass the same validation passes as hand-authored nodes (run because the
        // hook fires before ValidationPhase).
        return MetaDataLoader.fromUris(
            "test-trace-derive", List.of(uri),
            LoaderOptions.create(false, false, true),
            LlmTraceFieldDeriver::deriveTraceFields);
    }

    private static MetaField ownField(MetaObject obj, String name) {
        for (MetaField f : obj.getChildren(MetaField.class, false)) {
            if (name.equals(f.getShortName())) return f;
        }
        return null;
    }

    private static String attr(MetaField f, String attrName) {
        return f.hasMetaAttr(attrName, false)
            ? f.getMetaAttr(attrName, false).getValueAsString() : null;
    }

    @Test
    public void derivesTypedJsonbColumnsOnTraceEntity() {
        MetaDataLoader loader = load();
        MetaObject trace = loader.getMetaDataByName(MetaObject.class, "test::ai::TraceCall");

        MetaField voRequest = ownField(trace, LlmTraceFieldDeriver.VO_REQUEST);
        assertNotNull("voRequest must be derived", voRequest);
        assertTrue("voRequest must be a field.object", voRequest instanceof ObjectField);
        assertEquals("test::ai::ReqVo", attr(voRequest, ObjectField.ATTR_OBJECTREF));
        assertEquals("jsonb", attr(voRequest, ObjectField.ATTR_STORAGE));

        MetaField voResponse = ownField(trace, LlmTraceFieldDeriver.VO_RESPONSE);
        assertNotNull("voResponse must be derived", voResponse);
        assertTrue("voResponse must be a field.object", voResponse instanceof ObjectField);
        assertEquals("test::ai::RespVo", attr(voResponse, ObjectField.ATTR_OBJECTREF));
        assertEquals("jsonb", attr(voResponse, ObjectField.ATTR_STORAGE));
    }

    @Test
    public void skipsEntityWithoutPrompt() {
        MetaDataLoader loader = load();
        MetaObject bare = loader.getMetaDataByName(MetaObject.class, "test::ai::BareCall");
        assertNull(ownField(bare, LlmTraceFieldDeriver.VO_REQUEST));
        assertNull(ownField(bare, LlmTraceFieldDeriver.VO_RESPONSE));
    }

    @Test
    public void skipsEntityNotExtendingLlmCallBase() {
        MetaDataLoader loader = load();
        MetaObject plain = loader.getMetaDataByName(MetaObject.class, "test::ai::PlainEntity");
        assertNull(ownField(plain, LlmTraceFieldDeriver.VO_REQUEST));
        assertNull(ownField(plain, LlmTraceFieldDeriver.VO_RESPONSE));
    }

    @Test
    public void isIdempotent() {
        MetaDataLoader loader = load();
        MetaObject trace = loader.getMetaDataByName(MetaObject.class, "test::ai::TraceCall");

        // Re-run on the already-derived tree: no duplicate fields.
        LlmTraceFieldDeriver.deriveTraceFields(loader);

        int voResponseCount = 0;
        for (MetaField f : trace.getChildren(MetaField.class, false)) {
            if (LlmTraceFieldDeriver.VO_RESPONSE.equals(f.getShortName())) voResponseCount++;
        }
        assertEquals("idempotent re-run must not duplicate voResponse", 1, voResponseCount);
    }
}

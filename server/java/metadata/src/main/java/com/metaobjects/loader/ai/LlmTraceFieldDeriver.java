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

import com.metaobjects.MetaData;
import com.metaobjects.attr.StringAttribute;
import com.metaobjects.field.MetaField;
import com.metaobjects.field.ObjectField;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.object.MetaObject;
import com.metaobjects.template.PromptTemplate;

import java.util.List;

/**
 * AI-trace pre-freeze pass: inject typed {@code voRequest}/{@code voResponse}
 * {@code field.object} columns onto entities that extend {@code LlmCallBase} and
 * carry a nested {@code template.prompt} with {@code @payloadRef}/{@code @responseRef}.
 *
 * <p>Cross-port mirror of the TypeScript reference
 * ({@code codegen-ts/src/ai/derive-trace-fields.ts}). The TS reference wires this
 * as a codegen-only {@code preFreeze} hook because the TS runtime persists via a
 * direct row-write (no runtime metadata needed). The Java OMDB runtime is
 * <em>metadata-driven</em> — the generated {@code record<Entity>} helper calls
 * {@code setObject("voResponse", ...)} which OMDB maps to a jsonb column by reading
 * the <em>runtime-loaded</em> MetaObject. So in Java this derivation must also reach
 * the runtime load path; it is therefore exposed as a {@link MetaDataLoader}
 * {@code preFreeze} hook usable by BOTH codegen and runtime loaders.</p>
 *
 * <p>The injected fields carry {@code @objectRef} + {@code @storage="jsonb"} so the
 * existing owned-object typed-jsonb codec path handles them — identical to a
 * hand-authored {@code field.object}. The pass is idempotent: an own field of the
 * same name is left untouched, so explicit authoring still wins.</p>
 */
public final class LlmTraceFieldDeriver {

    /** Short name of the shipped abstract base every trace entity extends. */
    public static final String LLM_CALL_BASE = "LlmCallBase";

    /** Derived field name for the typed request payload VO. */
    public static final String VO_REQUEST = "voRequest";

    /** Derived field name for the typed extracted-response VO. */
    public static final String VO_RESPONSE = "voResponse";

    /** {@code @storage} value selecting the typed-jsonb owned-object codec. */
    private static final String STORAGE_JSONB = "jsonb";

    private LlmTraceFieldDeriver() {}

    /**
     * For every concrete entity in {@code loader} that (1) extends
     * {@code LlmCallBase} (directly or transitively) and (2) has an own
     * {@code template.prompt} carrying {@code @payloadRef}/{@code @responseRef},
     * inject {@code field.object} children named {@code voRequest}/{@code voResponse}
     * (respectively) with {@code @storage="jsonb"}. Idempotent.
     *
     * <p>Designed to be passed to {@link MetaDataLoader#setPreFreeze}.</p>
     */
    public static void deriveTraceFields(MetaDataLoader loader) {
        for (MetaObject obj : loader.getChildren(MetaObject.class)) {
            if (!extendsBase(obj, LLM_CALL_BASE)) continue;

            PromptTemplate prompt = findOwnPrompt(obj);
            if (prompt == null) continue;

            String payloadRef = prompt.getPayloadRef();
            String responseRef = prompt.getResponseRef();

            if (payloadRef != null && !payloadRef.isEmpty()) {
                injectObjField(obj, VO_REQUEST, payloadRef);
            }
            if (responseRef != null && !responseRef.isEmpty()) {
                injectObjField(obj, VO_RESPONSE, responseRef);
            }
        }
    }

    /** Walk the resolved super chain for a node whose short name equals {@code baseName}. */
    private static boolean extendsBase(MetaData obj, String baseName) {
        MetaData cur = obj.getSuperData();
        while (cur != null) {
            if (baseName.equals(cur.getShortName())) return true;
            cur = cur.getSuperData();
        }
        return false;
    }

    /** First OWN {@code template.prompt} child of {@code obj}, or {@code null}. */
    private static PromptTemplate findOwnPrompt(MetaObject obj) {
        List<PromptTemplate> prompts = obj.getChildren(PromptTemplate.class, false);
        return prompts.isEmpty() ? null : prompts.get(0);
    }

    /**
     * Inject a {@code field.object} child onto {@code entity} with {@code @objectRef}
     * + {@code @storage="jsonb"}, unless an own field of that name already exists.
     */
    private static void injectObjField(MetaObject entity, String fieldName, String objectRef) {
        for (MetaField existing : entity.getChildren(MetaField.class, false)) {
            if (fieldName.equals(existing.getShortName())) return; // idempotent
        }
        ObjectField f = new ObjectField(fieldName);
        f.addChild(StringAttribute.create(ObjectField.ATTR_OBJECTREF, objectRef));
        f.addChild(StringAttribute.create(ObjectField.ATTR_STORAGE, STORAGE_JSONB));
        entity.addChild(f);
    }
}

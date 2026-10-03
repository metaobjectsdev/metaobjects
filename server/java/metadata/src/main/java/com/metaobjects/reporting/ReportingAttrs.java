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
package com.metaobjects.reporting;

import com.metaobjects.MetaData;
import com.metaobjects.attr.MetaAttribute;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;

/**
 * Typed reads of the reporting attrs (FR-044), shared by the node classes and
 * {@link ReportAccessors}. Every read is RESOLVING (ADR-0039): a member declared on an
 * abstract base entity, or a node that {@code extends} another, reads its effective value.
 */
final class ReportingAttrs {

    private ReportingAttrs() {
    }

    /** The attr's value when it is a string, else {@code null}. */
    static String optionalString(MetaData node, String attrName) {
        if (!node.hasMetaAttr(attrName)) return null;
        Object v = node.getMetaAttr(attrName).getValue();
        return v instanceof String ? (String) v : null;
    }

    /**
     * A string-list attr: a list keeps its string items; a bare string is one item. A
     * {@code StringAttribute} stores an authored array comma-delimited when it is not in
     * array mode, so a string carrying commas is split (the same dual handling
     * {@code MetaRequirement} and {@code MetaIdentity.getFields()} apply).
     */
    static List<String> stringList(MetaData node, String attrName) {
        if (!node.hasMetaAttr(attrName)) return new ArrayList<>();
        Object v = node.getMetaAttr(attrName).getValue();
        List<String> out = new ArrayList<>();
        if (v instanceof List) {
            for (Object item : (List<?>) v) {
                if (item instanceof String) out.add((String) item);
            }
        } else if (v instanceof String) {
            for (String part : ((String) v).split(",")) {
                String trimmed = part.trim();
                if (!trimmed.isEmpty()) out.add(trimmed);
            }
        }
        return out;
    }

    /** True when the attr's value is boolean {@code true}. */
    static boolean isTrue(MetaData node, String attrName) {
        if (!node.hasMetaAttr(attrName)) return false;
        Object v = node.getMetaAttr(attrName).getValue();
        return Boolean.TRUE.equals(v);
    }

    /** The canonical (desugared) attr.filter map, when one is declared. */
    @SuppressWarnings("unchecked")
    static Map<String, Object> filterMap(MetaData node, String attrName) {
        if (!node.hasMetaAttr(attrName)) return null;
        MetaAttribute<?> attr = node.getMetaAttr(attrName);
        Object v = attr.getValue();
        return v instanceof Map ? Collections.unmodifiableMap((Map<String, Object>) v) : null;
    }
}

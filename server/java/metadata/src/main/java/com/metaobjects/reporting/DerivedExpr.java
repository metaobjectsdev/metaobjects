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

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * FR-044 R13 — the {@code @expr} grammar of a {@code measure.derived}: FR-037 R5's first
 * arithmetic wave. Ported from {@code server/typescript/packages/metadata/src/core/reporting/derived-expr.ts}.
 * A closed subset of the attr.expression node grammar: an operand is {@code { field: name }} or
 * {@code { value: number }}; an operation is {@code { fn: add | subtract | multiply | divide, args: [a, b] }}.
 * origin.computed's grammar does not take the arithmetic members yet.
 */
public final class DerivedExpr {

    private static final String KEY_FIELD = "field";
    private static final String KEY_VALUE = "value";
    private static final String KEY_FN = "fn";
    private static final String KEY_ARGS = "args";

    private DerivedExpr() {}

    /** True for a node of the grammar, its whole subtree included. */
    public static boolean isDerivedExpr(Object node) {
        if (!(node instanceof Map<?, ?> n)) return false;
        if (n.size() == 1 && n.containsKey(KEY_FIELD)) return n.get(KEY_FIELD) instanceof String s && !s.isEmpty();
        if (n.size() == 1 && n.containsKey(KEY_VALUE)) return isFiniteNumber(n.get(KEY_VALUE));
        if (n.size() == 2 && n.containsKey(KEY_FN) && n.containsKey(KEY_ARGS)) {
            return n.get(KEY_FN) instanceof String fn && ReportingConstants.DERIVED_FNS.contains(fn)
                    && n.get(KEY_ARGS) instanceof List<?> args && args.size() == 2
                    && args.stream().allMatch(DerivedExpr::isDerivedExpr);
        }
        return false;
    }

    /** The names a well-formed expression's {@code { field }} operands read, each once, in first-read order. */
    public static List<String> fields(Object node) {
        List<String> out = new ArrayList<>();
        collect(node, out);
        return out;
    }

    private static void collect(Object node, List<String> out) {
        if (!(node instanceof Map<?, ?> n)) return;
        if (n.get(KEY_FIELD) instanceof String name) {
            if (!out.contains(name)) out.add(name);
        } else if (n.get(KEY_ARGS) instanceof List<?> args) {
            for (Object a : args) collect(a, out);
        }
    }

    private static boolean isFiniteNumber(Object v) {
        if (v instanceof Double d) return Double.isFinite(d);
        if (v instanceof Float f) return Float.isFinite(f);
        return v instanceof Number;
    }
}

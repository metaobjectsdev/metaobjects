/*
 * Copyright 2003 Doug Mealing LLC dba Meta Objects. All Rights Reserved.
 *
 * This software is the proprietary information of Doug Mealing LLC dba Meta Objects.
 * Use is subject to license terms.
 */
package com.metaobjects.source;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Set;

/**
 * Cross-port-aligned semantic-equality compare for metadata trees
 * (FR5a / ADR-0009 §semantic_diff).
 *
 * <p>Returns {@code true} when the two inputs differ in any
 * semantically-meaningful way (excluding the {@code source} key, which is
 * loader output and never participates in the diff).</p>
 *
 * <p>Algorithm:</p>
 * <ol>
 *   <li>Sort attrs lexicographically; compare attr-by-attr; values by canonical
 *       structural equality (key-order independent, whitespace-insensitive).</li>
 *   <li>Children are compared as ordered sequences.</li>
 *   <li>Reserved structural keys ({@code name}, {@code package}, {@code extends},
 *       {@code abstract}, {@code overlay}, {@code isArray}, {@code value})
 *       participate in the diff like attrs.</li>
 *   <li>{@code source} is excluded from the diff.</li>
 * </ol>
 *
 * <p>FR5a does not exercise this — FR5c will consume the boolean to drive the
 * duplicate-with-no-change {@code WARN_DUPLICATE_DECLARATION} path. The
 * skeleton + tests ship now so the port is ready when FR5c lands.</p>
 *
 * <p>Mirrors {@code SemanticDiff} in
 * {@code server/csharp/MetaObjects/Source/SemanticDiff.cs}.</p>
 */
public final class SemanticDiff {

    private static final Set<String> EXCLUDED = Set.of("source");

    private SemanticDiff() {
        // Static-only utility.
    }

    /**
     * Returns {@code true} when {@code a} and {@code b} differ in any
     * semantically-meaningful way; otherwise {@code false}.
     *
     * @param a left tree (may be {@code null})
     * @param b right tree (may be {@code null})
     * @return {@code true} if the trees differ, {@code false} if equal
     */
    public static boolean diff(JsonElement a, JsonElement b) {
        return !equal(a, b);
    }

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------

    private static boolean equal(JsonElement a, JsonElement b) {
        if (a == null && b == null) return true;
        if (a == null || b == null) return false;

        if (a.isJsonNull() && b.isJsonNull()) return true;
        if (a.isJsonNull() || b.isJsonNull()) return false;

        if (a.isJsonArray() && b.isJsonArray()) {
            JsonArray arrA = a.getAsJsonArray();
            JsonArray arrB = b.getAsJsonArray();
            if (arrA.size() != arrB.size()) return false;
            for (int i = 0; i < arrA.size(); i++) {
                if (!equal(arrA.get(i), arrB.get(i))) return false;
            }
            return true;
        }

        if (a.isJsonObject() && b.isJsonObject()) {
            JsonObject objA = a.getAsJsonObject();
            JsonObject objB = b.getAsJsonObject();

            List<String> aKeys = sortedKeysExcludingSource(objA);
            List<String> bKeys = sortedKeysExcludingSource(objB);
            if (aKeys.size() != bKeys.size()) return false;
            for (int i = 0; i < aKeys.size(); i++) {
                if (!aKeys.get(i).equals(bKeys.get(i))) return false;
                if (!equal(objA.get(aKeys.get(i)), objB.get(bKeys.get(i)))) return false;
            }
            return true;
        }

        if (a.isJsonPrimitive() && b.isJsonPrimitive()) {
            // Compare by canonical JSON text — collapses 1 vs 1.0 / true vs True, etc.,
            // matching the C# JsonValue.ToJsonString() comparison.
            return a.toString().equals(b.toString());
        }

        return false;
    }

    private static List<String> sortedKeysExcludingSource(JsonObject obj) {
        List<String> keys = new ArrayList<>(obj.size());
        for (String k : obj.keySet()) {
            if (!EXCLUDED.contains(k)) {
                keys.add(k);
            }
        }
        Collections.sort(keys);
        return keys;
    }

    /** Convenience: classify a JsonNull as such for explicit comparison. */
    @SuppressWarnings("unused")
    private static boolean isNull(JsonElement el) {
        return el == null || el instanceof JsonNull;
    }
}

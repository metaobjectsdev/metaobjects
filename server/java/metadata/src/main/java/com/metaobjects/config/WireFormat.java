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

import com.metaobjects.MetaData;
import com.metaobjects.MetaRoot;

/**
 * ADR-0019 Amendment 2 — the project's wire-format setting ({@code wire} in
 * {@code .metaobjects/config.json}): the OUTPUT form of a generated REST surface. Input rules
 * (W2, W3) never change with it.
 *
 * <p>Both keys default to {@code native}: what the language's standard serializer writes (for
 * Java and Kotlin, Jackson as the host configures it: a decimal is a JSON number, a value
 * object's null member is {@code null} with the key present). {@code "decimals": "string"} and
 * {@code "nullMembers": "omit"} are the cross-port form the conformance corpora pin.</p>
 */
public record WireFormat(Decimals decimals, NullMembers nullMembers) {

    /** How a {@code field.decimal} is written. */
    public enum Decimals {
        /** The language's standard serializer: a JSON number for {@code BigDecimal}. */
        NATIVE("native"),
        /** The canonical string of ADR-0019 Amendment 1, W1. */
        STRING("string");

        private final String wireName;

        Decimals(String wireName) { this.wireName = wireName; }

        /** The value as spelled in {@code .metaobjects/config.json}. */
        public String wireName() { return wireName; }
    }

    /** How a value object's null member is written. */
    public enum NullMembers {
        /** The language's standard serializer: for Jackson, {@code null} with the key present. */
        NATIVE("native"),
        /** {@code null} with the key present. */
        EMIT("emit"),
        /** Left out. */
        OMIT("omit");

        private final String wireName;

        NullMembers(String wireName) { this.wireName = wireName; }

        /** The value as spelled in {@code .metaobjects/config.json}. */
        public String wireName() { return wireName; }
    }

    /** Both keys at {@code native}: what a tree loaded with no project carries. */
    public static final WireFormat DEFAULT = new WireFormat(Decimals.NATIVE, NullMembers.NATIVE);

    public WireFormat {
        if (decimals == null) decimals = Decimals.NATIVE;
        if (nullMembers == null) nullMembers = NullMembers.NATIVE;
    }

    /** True when a decimal is written as the canonical string (the serializer annotation is emitted). */
    public boolean decimalsAsString() {
        return decimals == Decimals.STRING;
    }

    /** True when a value object's null member is left out (Jackson's {@code NON_NULL} is emitted). */
    public boolean omitNullMembers() {
        return nullMembers == NullMembers.OMIT;
    }

    /** The {@code decimals} value spelled {@code raw}, or {@code null} when it names none. */
    public static Decimals decimalsOf(String raw) {
        for (Decimals d : Decimals.values()) if (d.wireName.equals(raw)) return d;
        return null;
    }

    /** The {@code nullMembers} value spelled {@code raw}, or {@code null} when it names none. */
    public static NullMembers nullMembersOf(String raw) {
        for (NullMembers n : NullMembers.values()) if (n.wireName.equals(raw)) return n;
        return null;
    }

    /** The wire setting {@code node}'s root carries, or {@link #DEFAULT} for a detached node. */
    public static WireFormat of(MetaData node) {
        for (MetaData n = node; n != null; n = n.getParent()) {
            if (n instanceof MetaRoot root) return root.getWireFormat();
        }
        return DEFAULT;
    }
}

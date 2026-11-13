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
package com.metaobjects.config;

import java.util.Locale;

/**
 * ADR-0063 — the project settings the business-rules vocabulary reads, from the {@code rules}
 * and {@code verify} blocks of {@code .metaobjects/config.json}. Every port reads the same keys
 * with the same defaults. A key that is absent takes its default, which is always the behaviour a
 * project had before the setting existed: no project declared an operation or a transition
 * before 1.3.0, so every default here is the safe one.
 *
 * @param permissionNames      {@code rules.permissions.names}
 * @param lifecycleCreate      {@code rules.lifecycle.create}: read and validated, changes nothing yet
 * @param lifecycleCommands    {@code rules.lifecycle.commands}
 * @param lifecycleUnreachable {@code verify.lifecycle.unreachable}
 */
public record RulesSettings(PermissionNames permissionNames, LifecycleCreate lifecycleCreate,
                            LifecycleCommands lifecycleCommands, LifecycleUnreachable lifecycleUnreachable) {

    public static final RulesSettings DEFAULT = new RulesSettings(
        PermissionNames.DERIVE, LifecycleCreate.INITIAL, LifecycleCommands.UNCLAIMED, LifecycleUnreachable.WARN);

    /** {@code derive} (default) says nothing, {@code advise} warns, {@code require} fails the build. */
    public enum PermissionNames {
        DERIVE, ADVISE, REQUIRE;

        public String wireName() { return name().toLowerCase(Locale.ROOT); }

        public static PermissionNames of(String s) { return parse(values(), s); }
    }

    /** Whether a create may start a row in any state ({@code any}) or only the initial one ({@code initial}, default). */
    public enum LifecycleCreate {
        INITIAL, ANY;

        public String wireName() { return name().toLowerCase(Locale.ROOT); }

        public static LifecycleCreate of(String s) { return parse(values(), s); }
    }

    /** Which transitions derive a command of their own: {@code unclaimed} (default), {@code all} or {@code none}. */
    public enum LifecycleCommands {
        UNCLAIMED, ALL, NONE;

        public String wireName() { return name().toLowerCase(Locale.ROOT); }

        public static LifecycleCommands of(String s) { return parse(values(), s); }
    }

    /** Severity of an unreachable state or transition: {@code warn} (default), {@code error} or {@code off}. */
    public enum LifecycleUnreachable {
        WARN, ERROR, OFF;

        public String wireName() { return name().toLowerCase(Locale.ROOT); }

        public static LifecycleUnreachable of(String s) { return parse(values(), s); }
    }

    /** The constant whose wire name is {@code s}, or {@code null}. */
    private static <E extends Enum<E>> E parse(E[] values, String s) {
        for (E e : values) if (e.name().toLowerCase(Locale.ROOT).equals(s)) return e;
        return null;
    }
}

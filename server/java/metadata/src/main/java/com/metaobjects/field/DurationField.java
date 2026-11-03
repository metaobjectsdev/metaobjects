/*
 * Copyright 2004 Doug Mealing LLC dba Meta Objects
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
package com.metaobjects.field;

import com.metaobjects.DataTypes;
import com.metaobjects.registry.MetaDataRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * A duration field — a fixed-length span of time (days, hours, minutes, seconds).
 *
 * <p>{@code field.duration} is a logical subtype (ADR-0036/0037): it fixes the value's
 * <em>meaning</em> and drives idiomatic native binding per language — {@code java.time.Duration}
 * on the JVM — independent of how the value is physically stored. Like {@link InetField} it is
 * a bare scalar with no own attributes.</p>
 *
 * <p><strong>Wire / storage contract.</strong> The value is carried as a {@code String}
 * ({@link DataTypes#STRING}): the canonical ISO-8601 duration {@link DurationWire} writes
 * ({@code [-]PT[nH][nM][n[.f]S]}). The DB column is the Postgres-native {@code interval}, text
 * elsewhere. Years, months and weeks are refused: a calendar span has no fixed length.</p>
 *
 * @since 1.2.0
 */
@SuppressWarnings("serial")
public class DurationField extends PrimitiveField<String> {

    private static final Logger log = LoggerFactory.getLogger(DurationField.class);

    /** duration field subtype constant — cross-language vocabulary ({@code field.duration}). */
    public static final String SUBTYPE_DURATION = "duration";

    public DurationField(String name) {
        // String-backed value: the wire/storage representation is the canonical ISO-8601
        // duration. The native java.time.Duration binding is a codegen concern.
        super(SUBTYPE_DURATION, name, DataTypes.STRING);
    }

    /**
     * Register the {@code field.duration} type with the MetaDataRegistry. A bare scalar
     * inheriting the common field attributes, with no own attrs. The cross-port description is
     * sourced from {@code spec/metamodel/field.json}.
     */
    public static void registerTypes(MetaDataRegistry registry) {
        try {
            registry.registerType(DurationField.class, def -> def
                .type(TYPE_FIELD).subType(SUBTYPE_DURATION)
                .description("duration field — fixed-length span of time; native java.time.Duration binding")
                .inheritsFrom(TYPE_FIELD, SUBTYPE_BASE));
            if (log != null) log.debug("Registered DurationField type with unified registry");
        } catch (Exception e) {
            if (log != null) log.error("Failed to register DurationField type with unified registry", e);
        }
    }

    /**
     * Manually create a DurationField.
     * @param name Name of the field
     * @return New DurationField
     */
    public static DurationField create(String name) {
        return new DurationField(name);
    }
}

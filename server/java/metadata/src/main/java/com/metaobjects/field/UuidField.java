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
 * A UUID field — a logical identity scalar whose value is a UUID.
 *
 * <p><strong>R6 Plan 2a.</strong> {@code field.uuid} is a logical subtype (ADR-0013):
 * it fixes the value's <em>meaning</em> (a UUID) and drives idiomatic native binding per
 * language (ADR-0001 — {@code java.util.UUID} on the JVM), independent of how the value is
 * physically stored. It is dialect-agnostic and a bare scalar like {@link LongField}:
 * <strong>no required attributes and no loader-level value validation</strong> (a UUID
 * instance value is runtime data, not a metamodel attr).</p>
 *
 * <p><strong>Wire / storage contract.</strong> The value is carried as a
 * lowercase-canonical UUID <em>string</em> on the wire ({@link DataTypes#STRING}, exactly
 * like {@link StringField}), so all value conversion, JDBC read/write, and the cross-port
 * row normalizer treat it uniformly. The native {@code java.util.UUID} binding is a
 * build-time codegen concern (see {@code SpringTypeMapper}), and the native Postgres
 * {@code uuid} column is a persistence concern (see the omdb drivers + the
 * {@code dbColumnType} routing) — neither changes the wire representation.</p>
 *
 * <p><strong>Generation.</strong> A {@code field.uuid} primary key with
 * {@code @generation: uuid} maps to a server-side {@code gen_random_uuid()} default on
 * Postgres (and an app-side mint on portable dialects), routed through the single existing
 * identity-generation path — never a parallel emitter.</p>
 *
 * <p>Cross-port: {@code field.uuid} is the cross-language identity-scalar subtype. Native
 * bindings: Java/Kotlin {@code java.util.UUID}, C# {@code System.Guid}, Python
 * {@code uuid.UUID}, TS {@code string}.</p>
 *
 * @since 7.0.0
 */
@SuppressWarnings("serial")
public class UuidField extends PrimitiveField<String> {

    private static final Logger log = LoggerFactory.getLogger(UuidField.class);

    /** UUID field subtype constant — cross-language vocabulary ({@code field.uuid}). */
    public static final String SUBTYPE_UUID = "uuid";

    public UuidField(String name) {
        // String-backed value: the wire/storage representation is a lowercase-canonical
        // UUID string. The native java.util.UUID binding is build-time codegen only.
        super(SUBTYPE_UUID, name, DataTypes.STRING);
    }

    /**
     * Register the {@code field.uuid} type with the MetaDataRegistry. Mirrors the
     * one-class-one-registration-line pattern of {@link FloatField} (ADR-0002):
     * a bare scalar inheriting the common field attributes, with no own required attrs.
     */
    public static void registerTypes(MetaDataRegistry registry) {
        try {
            registry.registerType(UuidField.class, def -> {
                def.type(TYPE_FIELD).subType(SUBTYPE_UUID)
                   .description("UUID field — logical identity scalar; native java.util.UUID binding")
                   .inheritsFrom(TYPE_FIELD, SUBTYPE_BASE);
            });
            if (log != null) log.debug("Registered UuidField type with unified registry");
        } catch (Exception e) {
            if (log != null) log.error("Failed to register UuidField type with unified registry", e);
        }
    }

    /**
     * Manually create a UuidField.
     * @param name Name of the field
     * @return New UuidField
     */
    public static UuidField create(String name) {
        return new UuidField(name);
    }
}

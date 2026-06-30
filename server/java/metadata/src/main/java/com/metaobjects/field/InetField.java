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
 * An inet field — a logical string scalar whose value is an IP address (ADR-0036/0037 Wave 3).
 *
 * <p>{@code field.inet} is a logical subtype (ADR-0013): it fixes the value's <em>meaning</em>
 * (an IPv4 or IPv6 address) and drives idiomatic native binding per language (ADR-0001 —
 * {@code java.net.InetAddress} on the JVM), independent of how the value is physically stored.
 * Like {@link UuidField} it is a bare scalar — <strong>no required attributes and no
 * loader-level value validation</strong>.</p>
 *
 * <p><strong>Wire / storage contract.</strong> The value is carried as a {@code String}
 * ({@link DataTypes#STRING}, exactly like {@link StringField}); the native
 * {@code java.net.InetAddress} binding is a build-time codegen concern. The DB column is the
 * Postgres-native {@code inet} type. Codegen emits an IP validator accepting both v4 and v6.</p>
 *
 * <p>Cross-port native bindings: Java/Kotlin {@code java.net.InetAddress}, C#
 * {@code System.Net.IPAddress}, Python {@code ipaddress}, TS {@code string}.</p>
 *
 * @since 7.7.0
 */
@SuppressWarnings("serial")
public class InetField extends PrimitiveField<String> {

    private static final Logger log = LoggerFactory.getLogger(InetField.class);

    /** inet field subtype constant — cross-language vocabulary ({@code field.inet}). */
    public static final String SUBTYPE_INET = "inet";

    public InetField(String name) {
        // String-backed value: the wire/storage representation is the IP string. The
        // native java.net.InetAddress binding is build-time codegen only.
        super(SUBTYPE_INET, name, DataTypes.STRING);
    }

    /**
     * Register the {@code field.inet} type with the MetaDataRegistry. Mirrors {@link UuidField}:
     * a bare scalar inheriting the common field attributes, with no own required attrs. The
     * cross-port description is sourced from {@code spec/metamodel/field.json}.
     */
    public static void registerTypes(MetaDataRegistry registry) {
        try {
            registry.registerType(InetField.class, def -> {
                def.type(TYPE_FIELD).subType(SUBTYPE_INET)
                   .description("inet field — logical string scalar; native java.net.InetAddress binding")
                   .inheritsFrom(TYPE_FIELD, SUBTYPE_BASE);
            });
            if (log != null) log.debug("Registered InetField type with unified registry");
        } catch (Exception e) {
            if (log != null) log.error("Failed to register InetField type with unified registry", e);
        }
    }

    /**
     * Manually create an InetField.
     * @param name Name of the field
     * @return New InetField
     */
    public static InetField create(String name) {
        return new InetField(name);
    }
}

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
 * A URI field — a logical string scalar whose value is a URI/URL (ADR-0036/0037 Wave 3).
 *
 * <p>{@code field.uri} is a logical subtype (ADR-0013): it fixes the value's <em>meaning</em>
 * (a URI/URL) and drives idiomatic native binding per language (ADR-0001 —
 * {@code java.net.URI} on the JVM), independent of how the value is physically stored. Like
 * {@link UuidField} it is a bare scalar — <strong>no required attributes and no loader-level
 * value validation</strong>.</p>
 *
 * <p><strong>Wire / storage contract.</strong> The value is carried as a {@code String}
 * ({@link DataTypes#STRING}, exactly like {@link StringField}); the native {@code java.net.URI}
 * binding is a build-time codegen concern. The DB column is plain {@code text} (Postgres has no
 * uri type). Codegen emits a URL/URI validator.</p>
 *
 * <p>Cross-port native bindings: Java/Kotlin {@code java.net.URI}, C# {@code System.Uri},
 * Python {@code urllib.parse}, TS {@code string}.</p>
 *
 * @since 7.7.0
 */
@SuppressWarnings("serial")
public class UriField extends PrimitiveField<String> {

    private static final Logger log = LoggerFactory.getLogger(UriField.class);

    /** URI field subtype constant — cross-language vocabulary ({@code field.uri}). */
    public static final String SUBTYPE_URI = "uri";

    public UriField(String name) {
        // String-backed value: the wire/storage representation is the URI string. The
        // native java.net.URI binding is build-time codegen only.
        super(SUBTYPE_URI, name, DataTypes.STRING);
    }

    /**
     * Register the {@code field.uri} type with the MetaDataRegistry. Mirrors {@link UuidField}:
     * a bare scalar inheriting the common field attributes, with no own required attrs. The
     * cross-port description is sourced from {@code spec/metamodel/field.json}.
     */
    public static void registerTypes(MetaDataRegistry registry) {
        try {
            registry.registerType(UriField.class, def -> {
                def.type(TYPE_FIELD).subType(SUBTYPE_URI)
                   .description("URI field — logical string scalar; native java.net.URI binding")
                   .inheritsFrom(TYPE_FIELD, SUBTYPE_BASE);
            });
            if (log != null) log.debug("Registered UriField type with unified registry");
        } catch (Exception e) {
            if (log != null) log.error("Failed to register UriField type with unified registry", e);
        }
    }

    /**
     * Manually create a UriField.
     * @param name Name of the field
     * @return New UriField
     */
    public static UriField create(String name) {
        return new UriField(name);
    }
}

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
package com.metaobjects.index;

import com.metaobjects.MetaData;
import com.metaobjects.attr.MetaAttribute;
import com.metaobjects.attr.StringAttribute;
import com.metaobjects.registry.MetaDataRegistry;

import static com.metaobjects.object.MetaObject.ATTR_DESCRIPTION;

/**
 * A non-unique lookup index on one or more fields ({@code index.lookup}).
 *
 * <p>Use for query-performance indexes that do NOT enforce uniqueness.
 * For a unique constraint, declare {@code identity.secondary} instead.</p>
 *
 * <p>{@link #ATTR_FIELDS} names the indexed columns; the db provider extends
 * this type with the RDB-physical attrs {@code @orders} / {@code @expr} /
 * {@code @where} / {@code @using} for physical tuning.</p>
 */
public class LookupIndex extends Index {

    /**
     * Create a {@code index.lookup} node with the given name.
     */
    public LookupIndex(String name) {
        super(SUBTYPE_LOOKUP, name);
    }

    /**
     * Register the {@code index.lookup} type in the given registry.
     * Called by {@link IndexTypesMetaDataProvider}.
     */
    public static void registerTypes(MetaDataRegistry registry) {
        registry.registerType(LookupIndex.class, def -> {
            def.type(TYPE_INDEX).subType(SUBTYPE_LOOKUP)
               .description("A non-unique lookup index on one or more fields. Use for "
                   + "query-performance indexes that do NOT enforce uniqueness — declare "
                   + "identity.secondary for unique constraints instead.")
               .inheritsFrom(MetaData.TYPE_METADATA, MetaData.SUBTYPE_BASE);

            // @fields: required — at least one field. The db provider adds the physical
            // attrs (@orders / @expr / @where / @using) via registry.extendType; when
            // @expr is present it is the key expression derived from these fields.
            def.requiredAttributeWithConstraints(ATTR_FIELDS)
               .ofType(StringAttribute.SUBTYPE_STRING).asArray();

            def.optionalAttributeWithConstraints(ATTR_DESCRIPTION)
               .ofType(StringAttribute.SUBTYPE_STRING).asSingle();

            // ACCEPTS ANY CHILD ATTRIBUTES (for extensibility from service providers)
            def.optionalChild(MetaAttribute.TYPE_ATTR, "*", "*");
        });
    }

    @Override
    public String toString() {
        return String.format("LookupIndex[%s:%s]{%s -> %s}",
            getType(), getSubType(), getName(), getFields());
    }
}

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
import com.metaobjects.attr.StringArrayAttribute;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * Abstract base class for index nodes ({@code type = "index"}).
 *
 * <p>An index describes a database index on one or more fields of an entity.
 * Unlike {@code identity.secondary} (which enforces uniqueness), index nodes
 * are purely physical-performance hints — they do NOT imply uniqueness.</p>
 *
 * <p>The single concrete subtype is {@link LookupIndex} ({@code index.lookup}).
 * {@code index.unique} is intentionally absent: use {@code identity.secondary}
 * for unique constraints.</p>
 */
public abstract class Index extends MetaData {

    /** The canonical type name for all index nodes. */
    public static final String TYPE_INDEX = "index";

    /** The single concrete subtype: a non-unique lookup index. */
    public static final String SUBTYPE_LOOKUP = "lookup";

    /**
     * Logical core attr: the field name(s) composing this index.
     * May be omitted when {@link #ATTR_EXPR} provides a functional expression instead.
     */
    public static final String ATTR_FIELDS = "fields";

    /**
     * RDB-physical attr contributed by the db provider: per-field index-key sort
     * direction array ({@code asc | desc}), positional to {@link #ATTR_FIELDS}.
     */
    public static final String ATTR_ORDERS = "orders";

    /**
     * RDB-physical attr contributed by the db provider: partial-index predicate
     * (raw SQL). When set, the index covers only matching rows.
     */
    public static final String ATTR_WHERE = "where";

    /**
     * RDB-physical attr contributed by the db provider: a raw key EXPRESSION for a
     * functional/expression index (e.g. {@code "lower(email)"}). Used INSTEAD of
     * {@link #ATTR_FIELDS} — the index key is the expression rather than plain columns.
     */
    public static final String ATTR_EXPR = "expr";

    /**
     * RDB-physical attr contributed by the db provider: index access method
     * (e.g. {@code "gin"}, {@code "gist"}, {@code "hash"}); default {@code "btree"}
     * (not rendered).
     */
    public static final String ATTR_USING = "using";

    protected Index(String subType, String name) {
        super(TYPE_INDEX, subType, name);
    }

    /**
     * Returns the field names composing this index.
     *
     * <p>ADR-0039: uses the RESOLVING {@code getMetaAttr} accessor (not own-only)
     * so that fields inherited via {@code extends:} are visible — a concrete index
     * node that inherits {@code @fields} from an abstract base resolves them here.</p>
     *
     * @return the list of field names, or an empty list when absent
     */
    public List<String> getFields() {
        if (!hasMetaAttr(ATTR_FIELDS)) {
            return new ArrayList<>();
        }
        MetaAttribute<?> attr = getMetaAttr(ATTR_FIELDS);

        if (attr instanceof StringArrayAttribute) {
            List<String> v = ((StringArrayAttribute) attr).getValue();
            return v != null ? v : new ArrayList<>();
        }
        if (attr instanceof StringAttribute) {
            String v = attr.getValueAsString();
            if (v == null || v.trim().isEmpty()) return new ArrayList<>();
            if (v.contains(",")) {
                List<String> out = new ArrayList<>();
                for (String s : v.split(",")) {
                    String t = s.trim();
                    if (!t.isEmpty()) out.add(t);
                }
                return out;
            }
            return Arrays.asList(v.trim());
        }
        return new ArrayList<>();
    }

    /**
     * Returns {@code true} if this is a lookup (non-unique) index.
     */
    public boolean isLookup() {
        return SUBTYPE_LOOKUP.equals(getSubType());
    }
}

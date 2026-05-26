package com.metaobjects.layout;

import com.metaobjects.attr.BooleanAttribute;
import com.metaobjects.attr.FilterAttribute;
import com.metaobjects.attr.IntAttribute;
import com.metaobjects.attr.StringAttribute;
import com.metaobjects.registry.MetaDataRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * DataGridLayout — {@code layout.dataGrid}. Describes a tabular display over
 * the owning entity's fields. Authors a column ordering, default sort, page
 * size, and (optional) inline filter clause.
 *
 * <p>Cross-port attrs:</p>
 * <ul>
 *   <li>{@code @columns}          — string-array of field names (required)</li>
 *   <li>{@code @defaultSortField} — string field name; must exist on entity</li>
 *   <li>{@code @defaultSortOrder} — "asc" / "desc"</li>
 *   <li>{@code @pageSize}         — int rows-per-page</li>
 *   <li>{@code @filterable}       — boolean; turns on the column filter UI</li>
 *   <li>{@code @filter}           — desugared filter clause (uses attr.filter)</li>
 * </ul>
 *
 * @since 7.0.0
 */
public class DataGridLayout extends MetaLayout {

    private static final Logger log = LoggerFactory.getLogger(DataGridLayout.class);

    public static final String SUBTYPE_DATA_GRID = "dataGrid";

    public static final String ATTR_COLUMNS = "columns";
    public static final String ATTR_DEFAULT_SORT_FIELD = "defaultSortField";
    public static final String ATTR_DEFAULT_SORT_ORDER = "defaultSortOrder";
    public static final String ATTR_PAGE_SIZE = "pageSize";
    public static final String ATTR_FILTERABLE = "filterable";
    public static final String ATTR_FILTER = "filter";

    public DataGridLayout(String name) {
        super(TYPE_LAYOUT, SUBTYPE_DATA_GRID, name);
    }

    public static void registerTypes(MetaDataRegistry registry) {
        try {
            registry.registerType(DataGridLayout.class, def -> {
                def.type(TYPE_LAYOUT).subType(SUBTYPE_DATA_GRID)
                   .description("Tabular display layout for an entity")
                   .inheritsFrom(TYPE_LAYOUT, SUBTYPE_BASE);

                def.optionalAttributeWithConstraints(ATTR_COLUMNS)
                   .ofType(StringAttribute.SUBTYPE_STRING).asArray();

                def.optionalAttributeWithConstraints(ATTR_DEFAULT_SORT_FIELD)
                   .ofType(StringAttribute.SUBTYPE_STRING).asSingle();

                def.optionalAttributeWithConstraints(ATTR_DEFAULT_SORT_ORDER)
                   .ofType(StringAttribute.SUBTYPE_STRING).withEnum("asc", "desc");

                def.optionalAttributeWithConstraints(ATTR_PAGE_SIZE)
                   .ofType(IntAttribute.SUBTYPE_INT).asSingle();

                def.optionalAttributeWithConstraints(ATTR_FILTERABLE)
                   .ofType(BooleanAttribute.SUBTYPE_BOOLEAN).asSingle();

                def.optionalAttributeWithConstraints(ATTR_FILTER)
                   .ofType(FilterAttribute.SUBTYPE_FILTER).asSingle();
            });
            log.debug("Registered DataGridLayout type with unified registry");
        } catch (Exception e) {
            log.error("Failed to register DataGridLayout type with unified registry", e);
        }
    }
}

package acme.shop;

import java.util.Map;

/**
 * GENERATED — per-object physical database names for Tag.
 */
public abstract class TagNames {

    public static final String TYPE = "object";
    public static final String SUB_TYPE = "entity";
    public static final String NAME = "Tag";

    public static final String SOURCE_PRIMARY_TYPE = "source";
    public static final String SOURCE_PRIMARY_SUB_TYPE = "rdb";
    public static final String SOURCE_PRIMARY_KIND = "table";
    public static final String SOURCE_PRIMARY_TABLE = "tags";

    public static final String ID_FIELD = "id";
    public static final String ID_COLUMN = "id";
    public static final String LABEL_FIELD = "label";
    public static final String LABEL_COLUMN = "label";

    public static final String IDENTITY_PK_TYPE = "identity";
    public static final String IDENTITY_PK_SUB_TYPE = "primary";
    public static final String IDENTITY_PK_NAME = "pk";

    public static final Map<String, String> COLUMNS_BY_FIELD = Map.ofEntries(
        Map.entry("id", ID_COLUMN),
        Map.entry("label", LABEL_COLUMN)
    );

    protected TagNames() {}
}

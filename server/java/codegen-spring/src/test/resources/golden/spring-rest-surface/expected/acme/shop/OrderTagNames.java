package acme.shop;

import java.util.Map;

/**
 * GENERATED — per-object physical database names for OrderTag.
 */
public abstract class OrderTagNames {

    public static final String TYPE = "object";
    public static final String SUB_TYPE = "entity";
    public static final String NAME = "OrderTag";

    public static final String SOURCE_PRIMARY_TYPE = "source";
    public static final String SOURCE_PRIMARY_SUB_TYPE = "rdb";
    public static final String SOURCE_PRIMARY_KIND = "table";
    public static final String SOURCE_PRIMARY_TABLE = "order_tags";

    public static final String ORDER_ID_FIELD = "orderId";
    public static final String ORDER_ID_COLUMN = "order_id";
    public static final String TAG_ID_FIELD = "tagId";
    public static final String TAG_ID_COLUMN = "tag_id";

    public static final String IDENTITY_FK_ORDER_TYPE = "identity";
    public static final String IDENTITY_FK_ORDER_SUB_TYPE = "reference";
    public static final String IDENTITY_FK_ORDER_NAME = "fkOrder";
    public static final String IDENTITY_FK_TAG_TYPE = "identity";
    public static final String IDENTITY_FK_TAG_SUB_TYPE = "reference";
    public static final String IDENTITY_FK_TAG_NAME = "fkTag";
    public static final String IDENTITY_PK_TYPE = "identity";
    public static final String IDENTITY_PK_SUB_TYPE = "primary";
    public static final String IDENTITY_PK_NAME = "pk";

    public static final Map<String, String> COLUMNS_BY_FIELD = Map.ofEntries(
        Map.entry("orderId", ORDER_ID_COLUMN),
        Map.entry("tagId", TAG_ID_COLUMN)
    );

    protected OrderTagNames() {}
}

package com.metaobjects.object;

import com.metaobjects.field.BooleanField;
import com.metaobjects.field.DateField;
import com.metaobjects.field.DecimalField;
import com.metaobjects.field.DoubleField;
import com.metaobjects.field.FloatField;
import com.metaobjects.field.IntegerField;
import com.metaobjects.field.LongField;
import com.metaobjects.field.MetaField;
import com.metaobjects.field.StringField;
import com.metaobjects.object.value.ValueObject;

/**
 * object.value — a value object (no identity). Map-backed (ValueObject) by default.
 */
@SuppressWarnings("serial")
public class ValueMetaObject extends AbstractObjectRepresentation {
    public ValueMetaObject(String name) { super(MetaObject.SUBTYPE_VALUE, name); }
    protected ValueMetaObject(String subType, String name) { super(subType, name); }
    @Override protected Class<?> getDefaultObjectClass() { return ValueObject.class; }

    /**
     * Builds an ad-hoc {@code ValueMetaObject} from a comma-separated template of
     * {@code name:type} field declarations (e.g. {@code "id:int, name:string"}).
     *
     * <p>Lifted from the retired dynamic representation; the OQL inline-result-class
     * path in {@code ObjectManagerDB} is the intended caller.</p>
     *
     * @param name     fully-qualified name for the synthesized object
     * @param template comma-separated {@code field:type} pairs ({@code int}, {@code long},
     *                 {@code decimal}, {@code boolean}, {@code float}, {@code double},
     *                 {@code date}; anything else → {@code string})
     * @return a populated {@code ValueMetaObject}
     */
    public static ValueMetaObject createFromTemplate(String name, String template) {
        ValueMetaObject mc = new ValueMetaObject(name);

        if (template != null && template.length() == 0) {
            template = null;
        }

        while (template != null) {
            String param;

            int i = template.indexOf(',');
            if (i >= 0) {
                param = template.substring(0, i).trim();
                template = template.substring(i + 1).trim();
                if (template.length() == 0) {
                    template = null;
                }
            } else {
                param = template.trim();
                template = null;
            }

            i = param.indexOf(':');
            if (i <= 0) {
                throw new IllegalArgumentException("Malformed template field parameter [" + param + "]");
            }

            String field = param.substring(0, i).trim();
            String type = param.substring(i + 1).trim();

            if (field.length() == 0) {
                throw new IllegalArgumentException("Malformed template field name parameter [" + param + "]");
            }

            if (type.length() == 0) {
                throw new IllegalArgumentException("Malformed template field type parameter [" + param + "]");
            }

            MetaField mf;
            switch (type) {
                case "int":     mf = new IntegerField(field); break;
                case "long":    mf = new LongField(field); break;
                case "decimal": mf = new DecimalField(field); break;
                case "boolean": mf = new BooleanField(field); break;
                case "float":   mf = new FloatField(field); break;
                case "double":  mf = new DoubleField(field); break;
                case "date":    mf = new DateField(field); break;
                default:        mf = new StringField(field); break;
            }

            mc.addMetaField(mf);
        }

        return mc;
    }
}

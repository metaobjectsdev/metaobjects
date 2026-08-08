package com.metaobjects.io.object.gson;

import com.metaobjects.MetaDataException;
import com.metaobjects.field.MetaField;
import com.metaobjects.io.MetaDataIOException;
import com.metaobjects.io.json.JsonIOConstants;
import com.metaobjects.io.json.JsonSerializationHandler;
import com.metaobjects.io.json.TemporalWireFormat;
import com.metaobjects.io.json.raw.GsonSerializationHandler;
import com.metaobjects.io.string.StringSerializationHandler;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.object.MetaObject;

import com.metaobjects.util.MetaDataUtil;
import com.google.gson.*;

import java.io.IOException;
import java.lang.reflect.Type;
import java.util.ArrayList;
import java.util.Date;
import java.util.Iterator;
import java.util.List;

import static com.metaobjects.io.json.JsonIOUtil.*;

public class MetaObjectDeserializer implements JsonDeserializer<Object> {

    private final MetaDataLoader loader;
    private final MetaObject metaObject;
    private final boolean requiresType;

    public MetaObjectDeserializer(MetaDataLoader loader, boolean requiresType) {
        this.loader = loader;
        this.metaObject = null;
        this.requiresType = requiresType;
    }

    public MetaObjectDeserializer(MetaObject metaObject) {
        this.loader = metaObject.getLoader();
        this.metaObject = metaObject;
        this.requiresType = false;
    }

    @Override
    public Object deserialize(JsonElement json, Type type, JsonDeserializationContext context)
            throws JsonParseException {

        MetaObject mo = metaObject;

        // Check the @type if it exists, and use it to override the local one
        final JsonObject jsonObject = json.getAsJsonObject();
        if (jsonObject.has(JsonIOConstants.ATTR_ATTYPE)) {
            JsonPrimitive prim = (JsonPrimitive) jsonObject.get(JsonIOConstants.ATTR_ATTYPE);
            String metaObjectName = prim.getAsString();
            if (metaObject == null || !metaObject.getName().equals(metaObjectName)) {
                mo = loader.getMetaObjectByName(metaObjectName);
            }
        }

        if ( mo == null ) throw new JsonParseException("No '@type' attribute was found, and MetaObject not "+
                "specified in the MetaObjectDeserializer");

        Object o = mo.newInstance();

        readObjectFields( mo, o, jsonObject, context );

        return o;
    }

    protected void readObjectFields(MetaObject mo, Object vo, JsonObject json, JsonDeserializationContext context) {

        for (MetaField mf : mo.getMetaFields() ) {
            readFieldValue( mo, mf, vo, json, context );
        }
    }


    protected void readFieldValue(MetaObject mo, MetaField mf, Object vo,
                                  JsonObject json, JsonDeserializationContext context)  {

        String jsonName = getJsonName(mf);
        if ( !json.has( jsonName)) return;

        JsonElement el = json.get(jsonName);
        if ( el.isJsonNull()) {
            mf.setObject( vo, null);
        }
        else {
            switch (mf.getDataType()) {
                case BOOLEAN:
                    // Check if this is an array field using universal @isArray support
                    if (mf.isArrayType()) {
                        if (el.isJsonArray()) mf.setObject(vo, context.deserialize(el, List.class));
                        else mf.setBoolean(vo, el.getAsBoolean());
                    } else {
                        mf.setBoolean(vo, el.getAsBoolean());
                    }
                    break;

                case BYTE:
                case SHORT:
                case INT:
                    // Check if this is an array field using universal @isArray support
                    if (mf.isArrayType()) {
                        if (el.isJsonArray()) mf.setObject(vo, context.deserialize(el, List.class));
                        else mf.setInt(vo, el.getAsInt());
                    } else {
                        mf.setInt(vo, el.getAsInt());
                    }
                    break;

                case LONG:
                    // Check if this is an array field using universal @isArray support
                    if (mf.isArrayType()) {
                        if (el.isJsonArray()) mf.setObject(vo, context.deserialize(el, List.class));
                        else mf.setLong(vo, el.getAsLong());
                    } else {
                        mf.setLong(vo, el.getAsLong());
                    }
                    break;

                case DATE:
                    // #275: DATE used to share LONG's branch unconditionally, which only ever
                    // worked for the legacy epoch-millis form. Number -> epoch millis (kept, the
                    // existing LONG coercion path -- this is what makes the release a PATCH:
                    // nothing that parsed before stops parsing). String -> tolerant ISO parse
                    // (TemporalWireFormat). Array: element-wise into a List<Date> via
                    // setObjectArray (bypasses DataConverter.toType/DATE_ARRAY, which is
                    // unsupported, and skips context.deserialize(el, List.class), which yields a
                    // type-losing List<Double>).
                    if (mf.isArrayType() && el.isJsonArray()) {
                        List<Date> dates = new ArrayList<>();
                        for (JsonElement item : el.getAsJsonArray()) {
                            dates.add(readDateElement(mf, item));
                        }
                        mf.setObjectArray(vo, dates);
                    } else if (el.isJsonPrimitive() && el.getAsJsonPrimitive().isNumber()) {
                        mf.setLong(vo, el.getAsLong());
                    } else {
                        mf.setDate(vo, parseDate(mf, el.getAsString()));
                    }
                    break;

                case FLOAT:
                case DOUBLE:
                    // Check if this is an array field using universal @isArray support
                    if (mf.isArrayType()) {
                        if (el.isJsonArray()) mf.setObject(vo, context.deserialize(el, List.class));
                        else mf.setDouble(vo, el.getAsDouble());
                    } else {
                        mf.setDouble(vo, el.getAsDouble());
                    }
                    break;

                case DECIMAL:
                    // Read the JSON number losslessly as a BigDecimal (getAsBigDecimal
                    // parses the exact text, never via double). No array form for decimal.
                    mf.setDecimal(vo, el.getAsBigDecimal());
                    break;

                case STRING_ARRAY:
                    if (el.isJsonArray()) mf.setStringArray(vo, context.deserialize(el, List.class));
                    else mf.setString(vo, el.getAsString());
                    break;

                case STRING:
                    // Check if this is an array field using universal @isArray support
                    if (mf.isArrayType()) {
                        if (el.isJsonArray()) mf.setStringArray(vo, context.deserialize(el, List.class));
                        else mf.setString(vo, el.getAsString());
                    } else {
                        mf.setString(vo, el.getAsString());
                    }
                    break;

                case OBJECT:
                    // Check if this is an array field using universal @isArray support
                    if (mf.isArrayType()) {
                        readFieldObjectArray(mo, mf, vo, el, context);
                    } else {
                        readFieldObject(mo, mf, vo, el, context);
                    }
                    break;

                case OBJECT_ARRAY:
                    readFieldObjectArray(mo, mf, vo, el, context);
                    break;

                case CUSTOM:
                    readFieldCustom(mo, mf, vo, el, context);
                    break;

                default:
                    throw new UnsupportedOperationException(
                            "DataType [" + mf.getDataType() + "] not supported [" + mf + "]");
            }
        }
    }

    /** Single JSON array element of a DATE-array field: number -> epoch millis, string -> tolerant ISO parse. */
    private Date readDateElement(MetaField mf, JsonElement el) {
        if (el.isJsonPrimitive() && el.getAsJsonPrimitive().isNumber()) {
            return new Date(el.getAsLong());
        }
        return parseDate(mf, el.getAsString());
    }

    /** TemporalWireFormat.parse has no MetaField context; add it here, matching this class's
     * existing MetaDataException-with-field-name convention (see getObjectRefClass/readFieldObject). */
    private Date parseDate(MetaField mf, String s) {
        try {
            return TemporalWireFormat.parse(s);
        } catch (IllegalArgumentException e) {
            throw new MetaDataException("Error reading MetaField [" + mf + "]: " + e.getMessage(), e);
        }
    }

    private Class getObjectRefClass(MetaField mf) {

        MetaObject refmo = null;
        if (MetaDataUtil.hasObjectRef(mf)) {
            refmo = MetaDataUtil.getObjectRef(mf);
        }
        if (refmo == null) throw new MetaDataException("Cannot read Object as MetaField "+
                "["+mf+"] had no objectRef attribute set");

        Class clazz;
        try {
            clazz = refmo.getObjectClass();
        } catch (ClassNotFoundException e) {
            throw new MetaDataException("Cannot read Object as field ["+mf.getName()+"] had an ObjectRef "+
                    "without a valid ObjectClass: "+refmo.getName());
        }

        return clazz;
    }

    protected void readFieldObjectArray(MetaObject mo, MetaField mf, Object vo,
                                        JsonElement el, JsonDeserializationContext context) {

        List<Object> objects = new ArrayList<>();

        if (!el.isJsonArray()) throw new MetaDataException("Expected JsonArray when reading MetaField "+
                "["+mf+"], but found JsonElement: "+el);

        Iterator<JsonElement> iter = ((JsonArray)el).iterator();
        while(iter.hasNext()) {
            JsonElement elo = iter.next();
            if (!elo.isJsonObject()) throw new MetaDataException("Expected JsonObject when reading MetaField "+
                    "["+mf+"], but found JsonElement: "+elo);

            objects.add( context.deserialize( elo, getObjectRefClass(mf)));
        }

        mf.setObjectArray( vo, objects );
    }

    protected void readFieldObject(MetaObject mo, MetaField mf, Object vo,
                                   JsonElement el, JsonDeserializationContext context) {

        if (!el.isJsonObject()) throw new MetaDataException("Expected JsonObject when reading MetaField "+
                "["+mf+"], but found JsonElement: "+el);

        mf.setObject( vo, context.deserialize( el, getObjectRefClass(mf)));
    }

    protected void readFieldCustom(MetaObject mo, MetaField mf, Object vo,
                                   JsonElement el, JsonDeserializationContext context) {

        if ( mf instanceof GsonSerializationHandler) {
            ((GsonSerializationHandler)mf).gsonDeserialize(vo,el,context);
        }
        else if (mf instanceof StringSerializationHandler){
            ((StringSerializationHandler)mf).setValueAsString(vo,el.getAsString());
        }
        else {
            throw new UnsupportedOperationException(
                    "Custom DataType and does not implement GsonSerializationHandler [" + mf + "]");
        }
    }
}

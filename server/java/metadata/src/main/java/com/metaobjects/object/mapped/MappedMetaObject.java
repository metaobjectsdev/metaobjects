package com.metaobjects.object.mapped;

import com.metaobjects.MetaDataException;
import com.metaobjects.field.MetaField;
import com.metaobjects.object.MetaObject;
import com.metaobjects.object.MetaObjectAware;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.Map;

/**
 * Map-based MetaObject with key-value field access.
 *
 * <p>Not a registered subtype. {@code object.map} is retired (ADR-0005); this
 * class survives only as a resolver-selected representation impl. Its public
 * {@code (String name)} ctor stamps the semantic subType {@code entity} —
 * representation is orthogonal to the semantic subtype.</p>
 *
 * @version 6.0
 */
public class MappedMetaObject extends MetaObject
{
    private static final Logger log = LoggerFactory.getLogger(MappedMetaObject.class);

    private String metaObjectKey = "metaObject";

    /**
     * Constructs a Map-based MetaObject with the semantic subType {@code entity}
     * (representation is orthogonal to the semantic subtype — ADR-0005).
     */
    public MappedMetaObject(String name) {
        super(MetaObject.SUBTYPE_ENTITY, name);
    }

    protected MappedMetaObject(String subType, String name) {
        super(subType,name);
    }

    public static MappedMetaObject create( String name ) {
        return new MappedMetaObject( name );
    }

    public String getMetaObjectKey() {
        return metaObjectKey;
    }

    public void setMetaObjectKey(String metaObjectKey) {
        this.metaObjectKey = metaObjectKey;
    }

    /*@Override
    public Object newInstance()  {

        Object o = null;

        // See if we have this cached already
        Boolean isMap = (Boolean) getCacheValue( KEY );
        if ( isMap == null ) {
            try {
                if (getObjectClass() != null) o = newInstance();
            } catch(MetaDataException | ClassNotFoundException ignore) {}

            setCacheValue( KEY, isMap );
        }
        else if ( isMap == false ) {
            o = super.newInstance();
        }

        if ( o == null ) {
            o = new MappedObject( this );
            setDefaultValues(o);
        }
        return o;
    }*/

    /**
     * Retrieves the object class of an object, or MappedObject if one is not specified
     */
    public Class<?> getObjectClass() throws ClassNotFoundException {

        Class<?> c = null;

        if ( hasObjectAttr())
            c = getObjectClassFromAttr();

        if (c == null)
            return MappedObject.class;

        return c;
    }

    @Override
    public void attachMetaObject(Object o) {
        if ( o instanceof MetaObjectAware ) {
            ((MetaObjectAware) o ).setMetaData(this);
        } else if ( o instanceof Map ) {
            Map m = (Map) o;
            m.put( metaObjectKey, this );
        } else {
            super.attachMetaObject(o);
        }
    }

    @Override
    public boolean produces(Object obj) {

        if ( obj instanceof MetaObjectAware ) {
            MetaObject mo = ((MetaObjectAware) obj).getMetaData();
            if ( mo != null )
                return hasChild( mo.getName(), MetaObject.class );
        }
        if (obj instanceof Map) {
            Map m = (Map) obj;
            if ( m.containsKey(getMetaObjectKey())) {
                MetaObject mo = (MetaObject) m.get(getMetaObjectKey());
                return hasChild( mo.getName(), MetaObject.class );
            }
        }
        return false;
    }

    @Override
    public Object getValue(MetaField f, Object obj) {
        if (obj instanceof Map) {
            Map m = (Map) obj;
            return m.get(f.getName());
        } else {
            throw new MetaDataException("Object is not a Map so cannot get value for: " + f);
        }
    }

    @Override
    public void setValue(MetaField f, Object obj, Object val) {
        if (obj instanceof Map) {
            Map m = (Map) obj;
            m.put(f.getName(), val);
        } else {
            throw new MetaDataException("Object is not a Map so cannot set value for: " + f);
        }
    }
}

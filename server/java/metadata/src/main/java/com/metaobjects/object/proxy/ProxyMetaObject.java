package com.metaobjects.object.proxy;

import com.metaobjects.InvalidMetaDataException;
import com.metaobjects.MetaDataException;
import com.metaobjects.attr.MetaAttribute;
import com.metaobjects.attr.StringAttribute;
import com.metaobjects.field.MetaField;
import com.metaobjects.object.MetaObject;
import com.metaobjects.object.MetaObjectAware;
import com.metaobjects.object.pojo.PojoMetaObject;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.lang.reflect.Constructor;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;

/**
 * Proxy MetaObject with dynamic-proxy field access.
 *
 * <p>Not a registered subtype. {@code object.proxy} is retired (ADR-0005);
 * this class survives only as a resolver-selected representation impl (the
 * resolver picks it for {@code object.entity} nodes whose {@code @object}
 * names an interface). Its public {@code (String name)} ctor stamps the
 * semantic subType {@code entity} via the inherited Pojo ctor — representation
 * is orthogonal to the semantic subtype.</p>
 *
 * @version 6.0
 */
public class ProxyMetaObject extends PojoMetaObject
{
    private static final Logger log = LoggerFactory.getLogger(ProxyMetaObject.class);

    public final static String ATTR_PROXYOBJECT = "proxyObject";

    /**
     * Constructs a Proxy MetaObject. The inherited Pojo ctor stamps the
     * semantic subType {@code entity} (representation is orthogonal to the
     * semantic subtype — ADR-0005).
     */
    public ProxyMetaObject(String name) {
        super(name);
    }

    protected ProxyMetaObject(String subType, String name) {
        super(subType,name);
    }

    public static MetaObject create(String name, Class<?> objectClass ) {
        return create( name, objectClass, null );
    }
    public static MetaObject create(String name, Class<?> objectClass, Class<?> proxyObjectClass ) {
        MetaObject mo = new ProxyMetaObject( name );
        mo.addChild(StringAttribute.create(ATTR_OBJECT, objectClass.getName() ));
        if ( proxyObjectClass != null )
            mo.addChild(StringAttribute.create(ATTR_PROXYOBJECT, proxyObjectClass.getName() ));
        return mo;
    }

    @Override
    public Object newInstance()  {

        Class<?> clazz = getObjectClass();

        Object o = Proxy.newProxyInstance(
                ProxyObject.class.getClassLoader(),
                new Class[] { clazz },    // To make this extensible, add the interface here
                new ProxyObjectHandler( newProxyInstance() ));

        //if ( o == null ) {
        //    throw new MetaDataException("Cannot instantiate proxy object ["+clazz.getName()+"], null returned");
        //}

        setDefaultValues(o);

        return o;
    }

    @Override
    public void attachMetaObject(Object o) {
        if ( o instanceof MetaObjectAware ) {
            ((MetaObjectAware) o ).setMetaData(this);
        }
    }

    /**
     * Retrieves the object class of an object, or null if one is not specified
     */
    @Override
    public Class<?> getObjectClass() {

        if ( hasObjectAttr()) {
            try {
                Class<?> c = getObjectClassFromAttr();
                if ( !c.isInterface() ) {
                    throw new InvalidMetaDataException( this,
                            "Object class ["+getMetaAttr(ATTR_OBJECT)+"] must be an interface");
                }
                return c;
            }
            catch (ClassNotFoundException e) {
                throw new InvalidMetaDataException( this, "Object class ["+getMetaAttr(ATTR_OBJECT)+"] was not found");
            }
        }
        else {
            throw new InvalidMetaDataException( this,
                    "An '"+ATTR_OBJECT+"' attribute must be specified and it must be an interface");
        }
    }

    /**
     * Retrieves the object class of an object, or null if one is not specified
     */
    public Class<?> getProxyObjectClass() {

        final String KEY = "ProxyObjectClass";

        // See if we have this cached already
        Class<?> oc = (Class<?>) getCacheValue( KEY );
        if ( oc == null ) {

            if ( hasMetaAttr(ATTR_PROXYOBJECT)) {

                MetaAttribute proxyObjectAttr = getMetaAttr(ATTR_PROXYOBJECT);
                String proxyObject = proxyObjectAttr.getValueAsString();

                try {
                    oc = loadClass( proxyObject );

                    if ( oc.isInterface() ) {
                        throw new InvalidMetaDataException( proxyObjectAttr, "ProxyObject Class ["+proxyObject+"] "+
                                "for MetaObject [" + getName() + "] cannot be an interface");
                    }
                    else if ( !MetaObjectAware.class.isAssignableFrom( oc )) {
                        throw new InvalidMetaDataException( proxyObjectAttr, "ProxyObject Class ["+proxyObject+"] "+
                                "for MetaObject [" + getName() + "] must implement MetaDataAware");
                    }
                }
                catch (ClassNotFoundException e) {
                    throw new InvalidMetaDataException( proxyObjectAttr,
                            "Could not find ProxyObject Class ["+proxyObject+"] for MetaObject [" + getName() + "]: "
                                    + e.getMessage() );
                }
            }

            if ( oc==null ) oc = ProxyObject.class;

            // Store the resulting Class in the cache
            setCacheValue( KEY, oc );
        }

        return oc;
    }

    /**
     * Return a new MetaObject instance from the MetaObject
     */
    public MetaObjectAware newProxyInstance()  {

        Class<?> oc = getProxyObjectClass();

        try {
            // Construct the object and pass the MetaObject into the constructor
            Constructor c = oc.getConstructor( MetaObject.class );
            c.setAccessible(true);
            return (MetaObjectAware) c.newInstance((MetaObject) this);
        }
        catch (IllegalAccessException | InstantiationException | InvocationTargetException | NoSuchMethodException e) {
            throw new MetaDataException(
                    "Could not construct ProxyObject with single MetaObject parameter " +
                            "[" + oc + "] " + "for MetaObject [" + getName() + "]: " + e.getMessage(), e);
        }
    }


    @Override
    public boolean produces(Object obj) {
        if ( obj instanceof MetaObjectAware ) {
            MetaObject mo = ((MetaObjectAware) obj).getMetaData();
            if ( mo != null )
                return hasChild( mo.getName(), MetaObject.class );
        }
        return false;
    }

    @Override
    public Object getValue(MetaField f, Object obj) {
        return super.getValue(f,obj);
    }

    @Override
    public void setValue(MetaField f, Object obj, Object val) {
        super.setValue( f, obj, val );
    }
}

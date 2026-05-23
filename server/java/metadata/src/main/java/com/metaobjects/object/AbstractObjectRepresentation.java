/*
 * Copyright 2002 Doug Mealing LLC dba Meta Objects. All Rights Reserved.
 *
 * This software is the proprietary information of Doug Mealing LLC dba Meta Objects.
 * Use is subject to license terms.
 */
package com.metaobjects.object;

import com.metaobjects.InvalidValueException;
import com.metaobjects.MetaDataException;
import com.metaobjects.field.MetaField;
import com.metaobjects.object.data.DataObjectBase;
import com.metaobjects.util.DataConverter;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.util.Arrays;
import java.util.List;

/**
 * Shared base for the two object representations (entity / value).
 *
 * <p>Consolidates reflection-based accessors and the live-object map hybrid into one
 * base (ADR-0005). Value access resolves in this order:</p>
 * <ol>
 *   <li>An {@code @objectAdapter} (a Java-only extension seam, an FQN of an
 *       {@link ObjectAdapter}) — when present, all access delegates to it.</li>
 *   <li>A {@link DataObjectBase} runtime object — reflection when a getter/setter
 *       exists, otherwise the dynamic attribute bag.</li>
 *   <li>Any other runtime object — reflection only.</li>
 * </ol>
 *
 * <p>{@link #getObjectClass()} falls back to {@link #getDefaultObjectClass()} (the
 * unbound default runtime class, e.g. {@code ValueObject}). {@link #allowExtensions()}
 * and {@link #isStrict()} override {@link MetaObject}'s defaults, reading the
 * {@code @allowExtensions} / {@code @isStrict} attributes.</p>
 *
 * @version 6.0
 */
@SuppressWarnings("serial")
public abstract class AbstractObjectRepresentation extends MetaObject {

    public static final String ATTR_OBJECT_ADAPTER = "objectAdapter";
    public static final String ATTR_ALLOWEXTENSIONS = "allowExtensions";
    public static final String ATTR_ISSTRICT = "isStrict";
    private static final String CACHE_ADAPTER = "objectAdapterInstance";

    // Reflection method caches (getter/setter Method, and has-getter/setter miss bypass)
    private static final String CACHE_PARAM_GETTER_METHOD = "getterMethod";
    private static final String CACHE_PARAM_SETTER_METHOD = "setterMethod";
    private static final String CACHE_PARAM_HAS_GETTER_METHOD = "hasGetterMethod";
    private static final String CACHE_PARAM_HAS_SETTER_METHOD = "hasSetterMethod";

    /** Bean accessors to skip so the hybrid falls through to the attribute bag rather than matching getClass()/getMetaData(). */
    private static final List<String> IGNORE_GETTER_FIELD_NAMES = Arrays.asList("class", "metaData");

    protected AbstractObjectRepresentation(String subType, String name) {
        super(subType, name);
    }

    /** Subclasses supply the unbound-default runtime class (e.g. ValueObject). */
    protected abstract Class<?> getDefaultObjectClass();

    ////////////////////////////////////////////////////
    // REFLECTION HELPERS

    /**
     * Uppercase the first character of the field name
     * @param b StringBuilder to use for upper case output
     * @param name Name of the field
     */
    protected void uppercase( StringBuilder b, String name ) {
        if (name.length() > 0) {
            b.append(Character.toUpperCase(name.charAt(0)));
            if (name.length() > 1) {
                b.append(name.substring(1));
            }
        }
    }

    protected String getGetterName( MetaField f, String prefix ) {
        // Create the getter name
        StringBuilder m = new StringBuilder();
        m.append( prefix);
        uppercase( m, f.getName() );
        return m.toString();
    }

    /**
     * Get the getter method name for the object for this MetaField
     * @param f MetaField to get the getter for
     * @return Name of getter method
     */
    protected Method findGetterName(Class objClass, MetaField f) {

        Method method = null;
        try {
            method = objClass.getMethod( getGetterName(f,"get"));
        } catch (NoSuchMethodException e) {
            try {
                method = objClass.getMethod( getGetterName(f,"is"));
            } catch (NoSuchMethodException e2) {
                throw new NoSuchMethodError("No getter exists named [(get/is)" +f.getName()+ "] on object [" +objClass.getName()+ "]");
            }
        }
        return method;
    }

    /**
     * Retrieve GET Method.
     *
     * <p>Returns null for the {@link #IGNORE_GETTER_FIELD_NAMES} (e.g. {@code class},
     * {@code metaData}) so the hybrid falls through to the dynamic attribute bag instead
     * of matching a spurious {@code getClass()} / {@code getMetaData()}.</p>
     */
    protected Method retrieveGetterMethod(MetaField f, Class<?> objClass) //throws MetaException
    {
        if ( IGNORE_GETTER_FIELD_NAMES.contains( f.getName() )) return null;

        Method method = (Method) f.getCacheValue(CACHE_PARAM_GETTER_METHOD + "." + objClass.getName());
        if (method == null) {
            method = findGetterName(objClass, f);

            f.setCacheValue(CACHE_PARAM_GETTER_METHOD + "." + objClass.getName(), method);
        }

        return method;
    }

    /**
     * Get the setter method on the object for this MetaField
     * @param f MetaField to get the setter for
     * @return Setter method name
     */
    protected String getSetterName(MetaField f) {

        // Create the getter name
        StringBuilder b = new StringBuilder();
        b.append("set");
        uppercase( b, f.getName() );
        return b.toString();
    }

    /**
     * Retrieve SET Method
     */
    protected Method retrieveSetterMethod(MetaField f, Class<?> objClass) //throws MetaException
    {
        synchronized (f) {
            Method method = (Method) f.getCacheValue(CACHE_PARAM_SETTER_METHOD + "." + objClass.getName());
            if (method == null) {

                String name = getSetterName(f);

                try {
                    method = objClass.getMethod( name,f.getValueClass() );
                } catch (NoSuchMethodException e) {
                    throw new NoSuchMethodError("No setter with a single variable exists named [" + name + "] with argument class [" + f.getValueClass().getSimpleName() + "] on object [" + objClass.getName() + "]");
                }

                f.setCacheValue(CACHE_PARAM_SETTER_METHOD + "." + objClass.getName(), method);
            }

            return method;
        }
    }

    protected void setValueWithReflection(MetaField f, Object obj, Object val) {

        if (obj == null)
            throw new IllegalArgumentException("Cannot set value on a null Object for field [" + f + "]");

        Method method = retrieveSetterMethod(f, obj.getClass());

        Class<?> c = method.getParameterTypes()[ 0];

        if (val != null && !c.isAssignableFrom(val.getClass() )) {
            throw new InvalidValueException("Setter expected class [" + c.getName() + "] but value was of type [" + val.getClass() + "]");
        }

        try {
            method.invoke(obj, val);
        } catch (InvocationTargetException e) {
            throw new RuntimeException("Invocation Target Exception setting field [" + f + "] on object [" + obj.getClass() + "]: " + e.getMessage(), e);
        } catch (IllegalAccessException e) {
            throw new RuntimeException("Illegal Access Exception setting field [" + f + "] on object [" + obj.getClass() + "]: " + e.getMessage(), e);
        }
    }

    /** Reads a field via reflection (the getter). */
    protected Object getValueWithReflection(MetaField f, Object obj) {

        if (obj == null)
            throw new IllegalArgumentException("Null object found, Object expected for field [" + f + "]");

        Method method = retrieveGetterMethod(f, obj.getClass());

        try {
            return method.invoke(obj);
        } catch (InvocationTargetException e) {
            throw new RuntimeException("Invocation Target Exception reading field [" + f + "] on object [" + obj.getClass() + "]: " + e.getMessage(), e);
        } catch (IllegalAccessException e) {
            throw new RuntimeException("Illegal Access Exception reading field [" + f + "] on object [" + obj.getClass() + "]: " + e.getMessage(), e);
        }
    }

    ////////////////////////////////////////////////////
    // HAS-METHOD HELPERS

    protected boolean hasGetterMethod(MetaField f, Class<?> objClass) {

        String cacheKey = CACHE_PARAM_HAS_GETTER_METHOD + "." + objClass.getName();
        Boolean cached = (Boolean) f.getCacheValue(cacheKey);
        if (cached != null) {
            return cached.booleanValue();
        }

        boolean exists;
        try {
            exists = retrieveGetterMethod(f, objClass) != null;
        } catch (NoSuchMethodError e) {
            exists = false;
        }

        f.setCacheValue(cacheKey, exists);
        return exists;
    }

    protected boolean hasSetterMethod(MetaField f, Class<?> objClass) {

        String cacheKey = CACHE_PARAM_HAS_SETTER_METHOD + "." + objClass.getName();
        Boolean cached = (Boolean) f.getCacheValue(cacheKey);
        if (cached != null) {
            return cached.booleanValue();
        }

        boolean exists;
        try {
            exists = retrieveSetterMethod(f, objClass) != null;
        } catch (NoSuchMethodError e) {
            exists = false;
        }

        f.setCacheValue(cacheKey, exists);
        return exists;
    }

    ////////////////////////////////////////////////////
    // VALUE ACCESS (merged hybrid: adapter → live-object dispatch → reflection)

    @Override
    public Object getValue(MetaField f, Object obj) {
        ObjectAdapter adapter = resolveAdapter();
        if (adapter != null) return adapter.getValue(this, f, obj);
        if (obj instanceof DataObjectBase) {
            return hasGetterMethod(f, obj.getClass())
                ? getValueWithReflection(f, obj)
                : ((DataObjectBase) obj)._getObjectAttribute(f.getName());
        }
        if (obj instanceof java.util.Map) {
            return ((java.util.Map<?, ?>) obj).get(f.getName());
        }
        return getValueWithReflection(f, obj);
    }

    @Override
    public void setValue(MetaField f, Object obj, Object value) {
        ObjectAdapter adapter = resolveAdapter();
        if (adapter != null) { adapter.setValue(this, f, obj, value); return; }
        value = DataConverter.toType(f.getDataType(), value);
        if (obj instanceof DataObjectBase) {
            if (hasSetterMethod(f, obj.getClass())) setValueWithReflection(f, obj, value);
            else ((DataObjectBase) obj)._setObjectAttribute(f.getName(), value);
            return;
        }
        if (obj instanceof java.util.Map) {
            @SuppressWarnings("unchecked")
            java.util.Map<String, Object> m = (java.util.Map<String, Object>) obj;
            m.put(f.getName(), value);
            return;
        }
        setValueWithReflection(f, obj, value);
    }

    ////////////////////////////////////////////////////
    // OBJECT CLASS / PRODUCES

    /**
     * Retrieves the object class for this representation. Resolution precedence follows
     * ADR-0001: {@code @object} attr → {@link com.metaobjects.registry.ObjectClassRegistry}
     * (FQN-keyed binding) → name-convention. Unlike the base {@link MetaObject}, an unresolved
     * class is not an error — it falls back to {@link #getDefaultObjectClass()} (the map-backed
     * runtime), so dynamic/unbound objects still work.
     */
    @Override
    public Class<?> getObjectClass() throws ClassNotFoundException {

        Class<?> c = null;

        if (hasObjectAttr())
            c = getObjectClassFromAttr();

        if (c == null)
            c = com.metaobjects.registry.ObjectClassRegistry.global().resolve(getName());

        if (c == null)
            c = createClassFromMetaDataName( false );

        if ( c == null )
            c = getDefaultObjectClass();

        return c;
    }

    /**
     * Whether the MetaObject produces the object specified
     */
    @Override
    public boolean produces(Object obj) {

        if (obj == null) {
            return false;
        }

        if (obj instanceof DataObjectBase) {

            DataObjectBase o = (DataObjectBase) obj;

            if (o._getObjectName() == null) {
                // See if we can match by the object produced
                return producesByClass(obj);
            }

            // TODO: WARNING:  This doesn't match up class loaders!
            if (o._getObjectName().equals(getName())) {
                return true;
            }
        }

        return false;
    }

    /** Class-equality produces() check, used as the DataObjectBase fallback when no object name is set. */
    private boolean producesByClass(Object obj) {
        try {
            return obj.getClass().equals( getObjectClass() );
        }
        catch (ClassNotFoundException e) {
            return false;
        }
    }

    ////////////////////////////////////////////////////
    // EXTENSION / STRICTNESS (override MetaObject's defaults from attrs)

    @Override
    public boolean allowExtensions() {
        return hasMetaAttr(ATTR_ALLOWEXTENSIONS) ? DataConverter.toBoolean(getMetaAttr(ATTR_ALLOWEXTENSIONS)) : false;
    }

    @Override
    public boolean isStrict() {
        return hasMetaAttr(ATTR_ISSTRICT) ? DataConverter.toBoolean(getMetaAttr(ATTR_ISSTRICT)) : true;
    }

    ////////////////////////////////////////////////////
    // INSTANTIATION + ADAPTER RESOLUTION

    @Override
    public Object newInstance() {
        ObjectAdapter adapter = resolveAdapter();
        if (adapter != null) return adapter.newInstance(this);
        // MetaObject.newInstance instantiates getObjectClass() (→ bound class,
        // else the default class via our getObjectClass override).
        return super.newInstance();
    }

    /** Resolve + cache the @objectAdapter instance, or null when absent (→ built-in hybrid). */
    protected ObjectAdapter resolveAdapter() {
        ObjectAdapter cached = (ObjectAdapter) getCacheValue(CACHE_ADAPTER);
        if (cached != null) return cached;
        if (!hasMetaAttr(ATTR_OBJECT_ADAPTER)) return null;
        String fqn = getMetaAttr(ATTR_OBJECT_ADAPTER).getValueAsString();
        if (fqn == null || fqn.isEmpty()) return null;
        try {
            Class<?> c = Class.forName(fqn, true, getClass().getClassLoader());
            ObjectAdapter a = (ObjectAdapter) c.getDeclaredConstructor().newInstance();
            setCacheValue(CACHE_ADAPTER, a);
            return a;
        } catch (Exception e) {
            throw new MetaDataException("@objectAdapter class not usable: " + fqn + " (on " + getName() + ")", e);
        }
    }
}

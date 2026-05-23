package com.metaobjects.object.managed;

import com.metaobjects.MetaDataException;
import com.metaobjects.field.*;
import com.metaobjects.manager.ManagerAwareMetaObject;
import com.metaobjects.manager.ObjectManager;
import com.metaobjects.manager.StateAwareMetaObject;
import com.metaobjects.object.EntityMetaObject;
import com.metaobjects.registry.MetaDataRegistry;
import com.metaobjects.util.DataConverter;

import static com.metaobjects.object.MetaObject.TYPE_OBJECT;
import static com.metaobjects.object.MetaObject.SUBTYPE_BASE;

/**
 * Managed MetaObject with state awareness and object manager integration.
 *
 * <p>An {@code om}-local {@code object.managed} subtype (sanctioned subclass extension).
 * Extends {@link EntityMetaObject} to inherit the reflection/map hybrid, but dispatches
 * value access against {@link ManagedObject} (a {@code Map}-backed live object, not a
 * {@code DataObjectBase}): reflection when a getter/setter exists, the object attribute
 * bag otherwise. The {@link StateAwareMetaObject} / {@link ManagerAwareMetaObject}
 * interfaces are consumed by {@code ObjectManager} for persistence state.</p>
 */
@SuppressWarnings("serial")
public class ManagedMetaObject extends EntityMetaObject implements StateAwareMetaObject, ManagerAwareMetaObject
{
    public final static String SUBTYPE_MANAGED = "managed";

    /**
     * Register this type with the MetaDataRegistry (called by provider)
     */
    public static void registerTypes(MetaDataRegistry registry) {
        registry.registerType(ManagedMetaObject.class, def -> def
            .type(TYPE_OBJECT).subType(SUBTYPE_MANAGED)
            .description("Managed MetaObject with state awareness and object manager integration")
            .inheritsFrom(TYPE_OBJECT, SUBTYPE_BASE)
        );
    }

    /**
     * Constructs the MetaClassObject for MetaObjects.
     *
     * <p>Routes through {@link EntityMetaObject}'s protected {@code (subType, name)}
     * ctor with {@code "managed"} so registry {@code createInstance("object","managed",…)}
     * yields a node whose {@code getSubType()} is {@code "managed"} (not {@code "entity"}).</p>
     */
    public ManagedMetaObject(String name) {
        super(SUBTYPE_MANAGED, name);
    }

    /*public static MetaObject createFromTemplate(String name, String template) {
        // Let's create one from scratch
        ManagedMetaObject mc = new ManagedMetaObject(name);
        //mc.setName( name );

        if (template.length() == 0) {
            template = null;
        }

        while (template != null) {
            String param = null;

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

            MetaField mf = null;
            if (type.equals("int")) {
                mf = new IntegerField(field);
            } else if (type.equals("long")) {
                mf = new LongField(field);
            } else if (type.equals("decimal")) {
                mf = new DecimalField(field);
            } else if (type.equals("boolean")) {
                mf = new BooleanField(field);
            } else if (type.equals("float")) {
                mf = new FloatField(field);
            } else if (type.equals("double")) {
                mf = new DoubleField(field);
            } else if (type.equals("date")) {
                mf = new DateField(field);
            } else {
                mf = new StringField(field);
            }

            //mf.setName(field);

            mc.addMetaField(mf);
        }

        return mc;
    }*/

    /**
     * Retrieves the object class of an object
     */
    public Class<?> getObjectClass() throws ClassNotFoundException {
        try { 
            return super.getObjectClass();
        } catch( MetaDataException e ) {
            return ManagedObject.class;
        }
    }

    /**
     * Whether the MetaClass handles the object specified
     */
    public boolean produces(Object obj) {
        
        if (obj == null) {
            return false;
        }

        if (obj instanceof ManagedObject) {
            
            ManagedObject mo = (ManagedObject) obj;

            if (mo.getMetaObjectName() == null) {
                //log.warn("MetaObject with no MetaClassName: [" + obj.getClass() + "]");

                // See if we can match by the object produced (class-equality fallback)
                try {
                    return obj.getClass().equals(getObjectClass());
                } catch (ClassNotFoundException e) {
                    return false;
                }
            }

            // TODO: WARNING:  This doesn't match up class loaders!
            if (mo.getMetaObjectName().equals(getName())) {
                return true;
            }
        }

        return false;
    }

    ////////////////////////////////////////////////////
    // PERSISTENCE METHODS
    
    /**
     * Attaches a Object Manager to the object
     */
    @Override
    public void attachManager( ObjectManager mm, Object obj )
     {
         //try { 
             getManagedObject( obj ).attachObjectManager( mm ); 
         //} catch( MetaException e ) { System.err.println( "Failed to attach: " + e.getMessage() ); }
     }
    
    /**
     * Gets the Object Manager for the object
     */
    @Override
    public ObjectManager getManager( Object obj )
    {
        return getManagedObject( obj ).getObjectManager();
    }
    
    /**
     * Get the ManagedObject instance
     */
    private ManagedObject getManagedObject(Object o) {
        
        if (o == null) {
            throw new MetaDataException("Null value found, MetaObject expected");
        }

        if (!(o instanceof ManagedObject)) {
            throw new MetaDataException("MetaObject expected, not [" + o.getClass().getName() + "]");
        }

        return (ManagedObject) o;
    }

    ////////////////////////////////////////////////////
    // PERSISTENCE METHODS

    private ManagedObject.Value getAttributeValue(MetaField f, Object obj)
            throws MetaDataException {
        if (!(obj instanceof ManagedObject)) {
            throw new MetaDataException("MetaObject expected, not [" + obj.getClass().getName() + "]");
        }

        return ((ManagedObject) obj).getObjectAttributeValue(f.getName());
    }

    /**
     * Gets the object attribute represented by this MetaField.
     *
     * <p>Overrides the inherited hybrid: it dispatches against {@link ManagedObject}
     * (a {@code Map}-backed live object, not a {@code DataObjectBase}), so reflection
     * via the inherited {@code getValueWithReflection} when a getter exists, else the
     * managed object's attribute bag.</p>
     */
    @Override
    public Object getValue(MetaField f, Object obj) //throws MetaException
    {
        if (!(obj instanceof ManagedObject)) {
            throw new IllegalArgumentException("MetaObject expected, Invalid object of class [" + obj.getClass().getName() + "]");
        }

        if (hasGetterMethod(f, obj.getClass())) {
            return getValueWithReflection(f, obj);
        } else {
            return ((ManagedObject) obj).getObjectAttribute(f.getName());
        }
    }

    /**
     * Sets the object attribute represented by this MetaField.
     *
     * <p>See {@link #getValue(MetaField, Object)}: dispatches against {@link ManagedObject},
     * using the inherited {@code setValueWithReflection} when a setter exists.</p>
     */
    @Override
    public void setValue(MetaField f, Object obj, Object value) //throws MetaException
    {
        if (!(obj instanceof ManagedObject)) {
            throw new IllegalArgumentException("MetaObject expected, Invalid object of class [" + obj.getClass().getName() + "]");
        }

        // Convert the value to the appropriate type
        if (value != null && f.getValueClass() != value.getClass()) {
            value = DataConverter.toType(f.getDataType(), value);
        }

        if (hasSetterMethod(f, obj.getClass())) {
            setValueWithReflection(f, obj, value);
        } else {
            ((ManagedObject) obj).setObjectAttribute(f.getName(), value);
        }
    }

    //////////////////////////////////////////////////////////////
    // Stateful methods
    public boolean isNew(Object obj)
            throws MetaDataException {
        return getManagedObject(obj).isNew();
    }

    public boolean isModified(Object obj)
            throws MetaDataException {
        return getManagedObject(obj).isModified();
    }

    public boolean isDeleted(Object obj)
            throws MetaDataException {
        return getManagedObject(obj).isDeleted();
    }

    public void setNew(Object obj, boolean state)
            throws MetaDataException {
        getManagedObject(obj).setNew(state);
    }

    public void setModified(Object obj, boolean state)
            throws MetaDataException {
        getManagedObject(obj).setModified(state);
    }

    public void setDeleted(Object obj, boolean state)
            throws MetaDataException {
        getManagedObject(obj).setDeleted(state);
    }

    public long getCreationTime(Object obj)
            throws MetaDataException {
        return getManagedObject(obj).getCreationTime();
    }

    public long getModifiedTime(Object obj)
            throws MetaDataException {
        return getManagedObject(obj).getModifiedTime();
    }

    public long getDeletedTime(Object obj)
            throws MetaDataException {
        return getManagedObject(obj).getDeletedTime();
    }

    /**
     * Returns whether the field on the object was modified
     */
    public boolean isFieldModified(MetaField f, Object obj)
            throws MetaDataException {
        return getAttributeValue(f, obj).isModified();
    }

    /**
     * Sets whether the field is modified
     */
    public void setFieldModified(MetaField f, Object obj, boolean state)
            throws MetaDataException {
        getAttributeValue(f, obj).setModified(state);
    }

    /**
     * Gets the time the field was modified
     */
    public long getFieldModifiedTime(MetaField f, Object obj)
            throws MetaDataException {
        return getAttributeValue(f, obj).getModifiedTime();
    }
}

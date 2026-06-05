/*
 * Copyright 2002 Doug Mealing LLC dba Meta Objects
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
package com.metaobjects.attr;

import com.metaobjects.DataTypes;
import com.metaobjects.registry.MetaDataRegistry;

import static com.metaobjects.attr.MetaAttribute.TYPE_ATTR;
import static com.metaobjects.attr.MetaAttribute.SUBTYPE_BASE;

/**
 * A Java Class Attribute with provider-based registration.
 */
@SuppressWarnings("serial")
public class ClassAttribute extends MetaAttribute<Class<?>> {

    public final static String SUBTYPE_CLASS = "class";

    /**
     * Register this type with the MetaDataRegistry (called by provider)
     */
    public static void registerTypes(MetaDataRegistry registry) {
        registry.registerType(ClassAttribute.class, def -> def
            .type(TYPE_ATTR).subType(SUBTYPE_CLASS)
            .description("Class attribute for Java class metadata")
            .inheritsFrom(TYPE_ATTR, SUBTYPE_BASE)
        );
    }

    /**
     * Constructs the MetaClass
     */
    public ClassAttribute(String name ) {
        super( SUBTYPE_CLASS, name, DataTypes.CUSTOM);
    }

    /**
     * Manually create a Class MetaAttribute with a Class&lt;?&gt; value
     * @param name the name of the attribute
     * @param value the class value to set
     * @return ClassAttribute with the specified name and class value
     */
    public static ClassAttribute create(String name, Class<?> value ) {
        ClassAttribute a = new ClassAttribute( name );
        a.setValue( value );
        return a;
    }

    /**
     * Manually create a Class MetaAttribute with a String classname value
     */
    public static ClassAttribute create(String name, String value ) {
        ClassAttribute a = new ClassAttribute( name );
        a.setValueAsString( value );
        return a;
    }

    @Override
    public void setValue(Class<?> value) {
        super.setValue(value);
    }

    @Override
    public void setValueAsObject(Object value) {
        if ( value == null ) {
            setValue( null );
        } else if ( value instanceof String ) {
            setValueAsString( (String) value );
        }
        else if ( value instanceof Class ) {
            setValue( (Class<?>) value );
        }
        else {
            throw new InvalidAttributeValueException( "Can not set value with class [" + value.getClass() + "] for object: " + value );
        }
    }

    @Override
    public void setValueAsString(String value) {
        try {
            if ( value == null ) {
                setValue( null );
            } else {
                setValue( (Class<?>) loadClass(value));
            }
        } catch (ClassNotFoundException e) {
            throw new InvalidAttributeValueException("Invalid Class Name [" + value + "] for ClassAttribute");
        }
    }

    @Override
    public String getValueAsString() {
        if ( getValue() == null ) return null;
        return getValue().getName();
    }
}

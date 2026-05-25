package com.metaobjects.metadata.ktx

import com.metaobjects.MetaDataNotFoundException
import com.metaobjects.field.MetaField
import com.metaobjects.`object`.MetaObject

/**
 * Reified typed-field accessors over [MetaObject.getMetaField] / [MetaObject.getMetaFields].
 *
 * Kotlin's `inline reified` lets the caller write `obj.field<StringField>("s")`
 * instead of the Java class-token shape `obj.getMetaField("s", StringField.class)`.
 */

/** Typed lookup; returns null when the field is absent OR not the requested subtype. */
inline fun <reified T : MetaField<*>> MetaObject.field(name: String): T? =
    try {
        getMetaField(name) as? T
    } catch (_: MetaDataNotFoundException) {
        null
    }

/**
 * Typed lookup; throws when the field is absent (mirrors [MetaObject.getMetaField]).
 * Casts to [T]; throws [ClassCastException] when the field is the wrong subtype.
 */
inline fun <reified T : MetaField<*>> MetaObject.requireField(name: String): T =
    getMetaField(name) as T

/** All fields matching the requested subtype, in declaration order. */
inline fun <reified T : MetaField<*>> MetaObject.fieldsOfType(): List<T> =
    metaFields.filterIsInstance<T>()

package com.metaobjects.metadata.ktx

import com.metaobjects.MetaDataNotFoundException
import com.metaobjects.loader.MetaDataLoader
import com.metaobjects.`object`.MetaObject
import com.metaobjects.registry.MetaDataLoaderRegistry
import com.metaobjects.template.MetaTemplate
import com.metaobjects.template.OutputTemplate
import com.metaobjects.template.PromptTemplate
import com.metaobjects.template.TemplateConstants

/**
 * Null-returning lookups for [MetaObject] and the FR-004 [MetaTemplate] subtypes.
 *
 * Java's [MetaDataLoader.getMetaObjectByName] throws [MetaDataNotFoundException]
 * on miss; idiomatic Kotlin prefers `T?`. These extensions trade the throw for
 * `null`, which is what every call site that "may or may not find it" wants.
 */

/** Lookup a [MetaObject] by FQN on this loader; returns null if not found. */
fun MetaDataLoader.metaObjectOrNull(name: String): MetaObject? =
    try {
        getMetaObjectByName(name)
    } catch (_: MetaDataNotFoundException) {
        null
    }

/** Lookup a [MetaObject] by FQN across all registered loaders; returns null if not found. */
fun MetaDataLoaderRegistry.metaObjectOrNull(name: String): MetaObject? =
    try {
        findMetaObjectByName(name)
    } catch (_: MetaDataNotFoundException) {
        null
    }

/** Lookup a [MetaTemplate] (any subtype) by FQN; returns null if not found or not a template. */
fun MetaDataLoader.templateOrNull(name: String): MetaTemplate? =
    try {
        root.getChildOfType(TemplateConstants.TYPE_TEMPLATE, name) as? MetaTemplate
    } catch (_: MetaDataNotFoundException) {
        null
    }

/** Lookup a [PromptTemplate] by FQN; returns null if not found OR not a prompt template. */
fun MetaDataLoader.promptTemplateOrNull(name: String): PromptTemplate? =
    templateOrNull(name) as? PromptTemplate

/** Lookup an [OutputTemplate] by FQN; returns null if not found OR not an output template. */
fun MetaDataLoader.outputTemplateOrNull(name: String): OutputTemplate? =
    templateOrNull(name) as? OutputTemplate

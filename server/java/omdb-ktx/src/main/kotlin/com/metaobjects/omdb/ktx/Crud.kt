package com.metaobjects.omdb.ktx

fun OmdbSession.create(obj: Any) = manager.createObject(connection, obj)
fun OmdbSession.update(obj: Any) = manager.updateObject(connection, obj)
fun OmdbSession.delete(obj: Any) = manager.deleteObject(connection, obj)
fun OmdbSession.load(obj: Any) = manager.loadObject(connection, obj)

/**
 * Finds an object by its string reference, returning null if it does not exist.
 *
 * Name resolution (FQN -> MetaObject) is delegated to the engine, which in production relies on
 * the global loader registry populated during Spring/OSGi bootstrap. In a bare/standalone context
 * (no active ServiceRegistryFactory bindings) this can throw MetaDataNotFoundException rather than
 * return null. The cast to [T] is unchecked — callers are responsible for passing the correct type.
 */
@Suppress("UNCHECKED_CAST")
fun <T : Any> OmdbSession.findByRef(refStr: String): T? =
    manager.findObjectByRef(connection, refStr).orElse(null) as T?

package com.metaobjects.omdb.ktx

fun OmdbSession.create(obj: Any) = manager.createObject(connection, obj)
fun OmdbSession.update(obj: Any) = manager.updateObject(connection, obj)
fun OmdbSession.delete(obj: Any) = manager.deleteObject(connection, obj)
fun OmdbSession.load(obj: Any) = manager.loadObject(connection, obj)

@Suppress("UNCHECKED_CAST")
fun <T : Any> OmdbSession.findByRef(refStr: String): T? =
    manager.findObjectByRef(connection, refStr).orElse(null) as T?

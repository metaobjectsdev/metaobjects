package com.metaobjects.omdb.ktx

import com.metaobjects.manager.ObjectManager
import com.metaobjects.manager.QueryBuilder
import com.metaobjects.`object`.MetaObject
import kotlinx.coroutines.future.await

/** Suspend wrapper over [ObjectManager.getObjectsAsync]. */
suspend fun ObjectManager.awaitGetObjects(mc: MetaObject): Collection<*> =
    getObjectsAsync(mc).await()

/** Suspend wrapper over [QueryBuilder.executeAsync]. */
suspend fun QueryBuilder.awaitExecute(): Collection<*> =
    executeAsync().await()

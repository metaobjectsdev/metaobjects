package com.metaobjects.omdb.ktx

import com.metaobjects.manager.ObjectManager
import com.metaobjects.manager.ObjectConnection

/** Bundles the manager + an open connection so extension functions read naturally. */
class OmdbSession(val manager: ObjectManager, val connection: ObjectConnection)

package com.metaobjects.manager.db.defs;

/**
 * Read-only mapping target for a {@code source.rdb @kind=view} entity. OMDB reads
 * from a view that already exists in the database (created by the migrate
 * toolchain); it no longer synthesizes or creates view DDL, so this carries no
 * view body.
 */
public class ViewDef extends BaseTableDef {

	public ViewDef( NameDef name ) {
		super( name );
	}
}

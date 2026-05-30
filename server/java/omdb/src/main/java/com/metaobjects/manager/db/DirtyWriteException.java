package com.metaobjects.manager.db;

import com.metaobjects.manager.PersistenceException;

/**
 * Exception thrown when a dirty write conflict is detected during database operations.
 * Carries the conflicting object for context.
 *
 * @since 1.0
 */
public class DirtyWriteException extends PersistenceException {
	
	private static final long serialVersionUID = 103419229085271187L;
	
	private final Object object;
	
    /**
     * Creates a DirtyWriteException with default message.
     * Backward compatible constructor.
     */
    public DirtyWriteException() {
        super("DirtyWriteException");
        this.object = null;
    }

    /**
     * Creates a DirtyWriteException with a custom message.
     * Backward compatible constructor.
     * 
     * @param msg the error message
     */
    public DirtyWriteException(String msg) {
        super(msg);
        this.object = null;
    }

    /**
     * Creates a DirtyWriteException for a specific object.
     * Backward compatible constructor.
     * 
     * @param o the object that caused the dirty write conflict
     */
    public DirtyWriteException(Object o) {
        super("DirtyWriteException");
    	this.object = o;
    }

    /**
     * Returns the object that caused the dirty write conflict.
     *
     * @return the object that caused the conflict, or null if not applicable
     */
    public Object getObject() {
  	    return object;
    }

    /**
     * Enhanced toString that includes object context when available.
     */
    @Override
    public String toString() {
  	    if (object == null) {
  		    return super.toString();
  	    } else {
  		    return "[" + object.toString() + "] " + super.toString();
  	    }
    }
}

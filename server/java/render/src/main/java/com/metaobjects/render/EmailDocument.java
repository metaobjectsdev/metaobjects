package com.metaobjects.render;

/** A rendered email: subject + HTML body + optional plain-text alternative (MIME multipart/alternative). */
public record EmailDocument(String subject, String htmlBody, String textBody) {}

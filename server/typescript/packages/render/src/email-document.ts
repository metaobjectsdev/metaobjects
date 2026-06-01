/** A rendered email: subject + HTML body + optional plain-text alternative (MIME multipart/alternative). */
export interface EmailDocument {
  subject: string;
  htmlBody: string;
  textBody?: string;
}

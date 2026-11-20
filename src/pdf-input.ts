/** Inline PDF inputs are JSON strings so the workflow can snapshot, hash and replay them like other options. */
export function checkPdfInputs(pdfs: unknown, supported: boolean): void {
  if (pdfs === undefined) return;
  if (!Array.isArray(pdfs)) throw new TypeError('pdfs must be an array of base64-encoded PDF documents');
  if (!supported && pdfs.length)
    throw new Error('PDF inputs require the Gemini runner; select a Gemini model');
  for (const [index, data] of pdfs.entries()) {
    if (typeof data !== 'string' || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
      throw new TypeError(`pdfs[${index}] must be a non-empty base64-encoded PDF document`);
    }
  }
}

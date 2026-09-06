import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export class PdfPasswordError extends Error {
  constructor(msg = 'password required') {
    super(msg);
    this.name = 'PdfPasswordError';
  }
}

/**
 * Extract text from a (possibly password-protected) PDF, reconstructing visual
 * lines from Y coordinates so table rows (date | narration | amount) stay on
 * one line. Throws PdfPasswordError when the password is wrong or missing.
 */
export async function extractPdfText(data: Uint8Array, password?: string | null): Promise<string> {
  let doc: pdfjs.PDFDocumentProxy;
  try {
    doc = await pdfjs.getDocument({ data: data.slice(), ...(password ? { password } : {}) }).promise;
  } catch (err) {
    const name = (err as { name?: string })?.name;
    if (name === 'PasswordException') throw new PdfPasswordError(String((err as Error).message));
    throw err;
  }
  try {
    const pages: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      let lastY: number | null = null;
      let text = '';
      for (const item of content.items) {
        if (!('str' in item)) continue;
        const y = item.transform[5] as number;
        if (lastY !== null && Math.abs(y - lastY) > 2) text += '\n';
        else if (text && !text.endsWith('\n')) text += ' ';
        text += item.str;
        lastY = y;
      }
      pages.push(text.replace(/[ \t]+/g, ' '));
    }
    const text = pages.join('\n\n');
    if (text.trim().length < 300) {
      throw new Error('PDF appears to be scanned (image-only) — text extraction is not possible');
    }
    return text;
  } finally {
    await doc.destroy();
  }
}

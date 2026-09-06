import { describe, expect, it } from 'vitest';
import { parseBatch } from '../src/google/gmail';

const B = 'batch_abc';
const part = (i: number, status: number, body: string) =>
  `--${B}\r\nContent-Type: application/http\r\nContent-ID: <response-item${i}>\r\n\r\nHTTP/1.1 ${status} OK\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${body}\r\n`;

describe('parseBatch', () => {
  it('parses parts and orders them by Content-ID', () => {
    const text = part(1, 200, '{"id":"b"}') + part(0, 200, '{"id":"a"}') + part(2, 429, '{"error":{"message":"rate"}}') + `--${B}--`;
    const parts = parseBatch(text, B);
    expect(parts.map((p) => p.status)).toEqual([200, 200, 429]);
    expect(JSON.parse(parts[0]!.body).id).toBe('a');
    expect(JSON.parse(parts[1]!.body).id).toBe('b');
  });
  it('handles bodies containing blank lines', () => {
    const text = part(0, 200, '{"snippet":"line one\\n\\nline two"}') + `--${B}--`;
    expect(JSON.parse(parseBatch(text, B)[0]!.body).snippet).toContain('line two');
  });
});

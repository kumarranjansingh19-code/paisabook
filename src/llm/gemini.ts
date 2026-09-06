import { settings } from '../store/local';

export type LlmTier = 'bulk' | 'reasoning';

export interface JsonSchema {
  type: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean';
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: string[];
  nullable?: boolean;
}

export class LlmError extends Error {
  retryAfterMs?: number;
  constructor(msg: string, public status?: number) {
    super(msg);
    this.name = 'LlmError';
  }
}

export interface LlmUsage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
}
export const usage: LlmUsage = { calls: 0, inputTokens: 0, outputTokens: 0 };

function model(tier: LlmTier): string {
  const s = settings();
  return tier === 'bulk' ? s.modelBulk : s.modelReasoning;
}

interface GenerateOpts {
  tier: LlmTier;
  systemInstruction?: string;
  thinking?: 'low' | 'high';
  maxRetries?: number;
  signal?: AbortSignal;
}

async function call(body: unknown, tier: LlmTier, signal?: AbortSignal): Promise<string> {
  const key = settings().geminiApiKey;
  if (!key) throw new LlmError('Gemini API key not configured');
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model(tier)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify(body),
    signal,
  });
  const json = (await res.json().catch(() => ({}))) as {
    error?: { message?: string };
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  };
  if (!res.ok) {
    const err = new LlmError(json.error?.message ?? `Gemini ${res.status}`, res.status);
    // Gemini says how long to wait either in Retry-After or in the message ("retry in 23.5s").
    const ra = Number(res.headers.get('Retry-After'));
    const inMsg = /retry (?:in|after) (\d+(?:\.\d+)?)\s*s/i.exec(json.error?.message ?? '');
    err.retryAfterMs = ra ? ra * 1000 : inMsg ? Number(inMsg[1]) * 1000 : undefined;
    throw err;
  }
  usage.calls++;
  usage.inputTokens += json.usageMetadata?.promptTokenCount ?? 0;
  usage.outputTokens += json.usageMetadata?.candidatesTokenCount ?? 0;
  const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
  if (!text) throw new LlmError(`empty response (${json.candidates?.[0]?.finishReason ?? 'no candidates'})`);
  return text;
}

/**
 * Structured extraction in JSON mode constrained by a JSON schema. Retries on
 * throttling; callers decide what to do with a final failure.
 */
export async function generateJson<T>(schema: JsonSchema, prompt: string, opts: GenerateOpts): Promise<T> {
  const maxRetries = opts.maxRetries ?? 5;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const text = await call(
        {
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          ...(opts.systemInstruction ? { systemInstruction: { parts: [{ text: opts.systemInstruction }] } } : {}),
          generationConfig: {
            temperature: 0,
            responseMimeType: 'application/json',
            responseJsonSchema: schema,
            ...(opts.thinking ? { thinkingConfig: { thinkingLevel: opts.thinking.toUpperCase() } } : {}),
          },
        },
        opts.tier,
        opts.signal,
      );
      return JSON.parse(text) as T;
    } catch (err) {
      lastErr = err;
      if (opts.signal?.aborted) throw err;
      const status = (err as LlmError).status;
      if (status && status < 500 && status !== 429) throw err; // bad key, bad schema — retrying won't help
      if (attempt < maxRetries) {
        // Per-minute quotas differ per account/tier: wait what Gemini asks for (capped at 65s), else back off.
        const asked = (err as LlmError).retryAfterMs;
        const wait = Math.min(asked ? asked + 500 : Math.min(2000 * 2 ** attempt, 30_000) + Math.random() * 1000, 65_000);
        if (status === 429 && typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('paisabook:ratelimit', { detail: { status, waitMs: wait, attempt } }));
        await new Promise((r, rej) => {
          const t = setTimeout(r, wait);
          opts.signal?.addEventListener('abort', () => {
            clearTimeout(t);
            rej(new DOMException('aborted', 'AbortError'));
          }, { once: true });
        });
      }
    }
  }
  throw new LlmError(`LLM call failed after ${maxRetries + 1} attempts: ${String(lastErr)}`);
}

export async function generateText(prompt: string, opts: Omit<GenerateOpts, 'tier'> & { tier?: LlmTier; search?: boolean } = {}): Promise<string> {
  return call(
    {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      ...(opts.systemInstruction ? { systemInstruction: { parts: [{ text: opts.systemInstruction }] } } : {}),
      ...(opts.search ? { tools: [{ googleSearch: {} }] } : {}),
      generationConfig: { ...(opts.thinking ? { thinkingConfig: { thinkingLevel: opts.thinking.toUpperCase() } } : {}) },
    },
    opts.tier ?? 'reasoning',
    opts.signal,
  );
}

/** Cheap connectivity check for the setup wizard. */
export async function testGemini(): Promise<string> {
  const r = await generateJson<{ ok: boolean; model: string }>(
    { type: 'object', properties: { ok: { type: 'boolean' }, model: { type: 'string' } }, required: ['ok', 'model'] },
    'Reply with ok=true and the name you go by.',
    { tier: 'bulk', maxRetries: 0 },
  );
  return r.model;
}

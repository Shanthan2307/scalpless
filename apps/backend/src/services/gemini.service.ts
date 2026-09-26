// Gemini client for the Scalpless agent: structured (JSON-schema) output only, so every decision is
// machine-checkable before the agent acts on it.
const API = 'https://generativelanguage.googleapis.com/v1beta/models';

export const geminiModel = () => process.env.GEMINI_MODEL?.trim() || 'gemini-flash-latest';
// Tried in order when a model is overloaded or unavailable.
const FALLBACKS = ['gemini-3-flash-preview', 'gemini-flash-lite-latest'];
export const geminiEnabled = () => !!process.env.GEMINI_API_KEY?.trim();

export async function geminiJson<T>(system: string, prompt: string, responseSchema: Record<string, unknown>): Promise<T & { _model: string }> {
  let lastError: unknown;
  for (const model of [geminiModel(), ...FALLBACKS]) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return { ...(await callModel<T>(model, system, prompt, responseSchema)), _model: model };
      } catch (err) {
        lastError = err;
        if (!/demand|overloaded|unavailable|429|503|500/i.test(String(err))) break; // not transient: next model
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      }
    }
  }
  throw lastError;
}

async function callModel<T>(model: string, system: string, prompt: string, responseSchema: Record<string, unknown>): Promise<T> {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) throw new Error('[env] GEMINI_API_KEY is not set');
  const res = await fetch(`${API}/${model}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2, responseMimeType: 'application/json', responseSchema },
    }),
  });
  const body = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
    error?: { message: string };
  };
  if (!res.ok || body.error) throw new Error(`Gemini: ${body.error?.message ?? res.status}`);
  const text = body.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
  return JSON.parse(text) as T;
}

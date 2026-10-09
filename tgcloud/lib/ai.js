// Claude Messages API over the platform's fetch. The key lives in the `config` table
// (set with /key in a private chat with the bot), never in code.
import { fetch } from 'sdk';
import { getConfig } from './store.js';

export const DEFAULT_MODEL = 'claude-haiku-5-5';

export async function aiReady() {
  return !!(await getConfig('anthropic_key'));
}

// Returns the reply text, or throws. `null` when no key is configured.
export async function askClaude(system, user, maxTokens = 1800) {
  const key = await getConfig('anthropic_key');
  if (!key) return null;
  const model = (await getConfig('model')) || DEFAULT_MODEL;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    console.warn('claude error', res.status, body.slice(0, 400));
    const err = new Error(`claude_http_${res.status}`);
    err.status = res.status;
    err.body = body.slice(0, 400);
    throw err;
  }
  const data = await res.json();
  return (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
}

// Tolerant JSON extraction: whole text, a ```json fence, or first { … last }.
export function parseJson(text) {
  if (!text) return null;
  const tries = [text];
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) tries.push(fence[1]);
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a >= 0 && b > a) tries.push(text.slice(a, b + 1));
  for (const t of tries) {
    try { return JSON.parse(t); } catch (e) { /* next */ }
  }
  return null;
}

// Talks to the Anthropic Messages API and streams the reply back a delta at a
// time. Kept apart from main.js so the request shape, the SSE parsing and the
// error paths can be exercised directly against a local server.

const DEFAULT_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

const SYSTEM_PROMPT =
  'You are looking at a cropped region of a hand-drawn infinite whiteboard — ' +
  'notes, sketches, diagrams or working. Read what is actually there, including ' +
  'messy handwriting, and answer the question about it. Be concise and concrete: ' +
  'the answer is read in a narrow side panel. Use short paragraphs, and plain ' +
  'text rather than markdown headings. If the region is ambiguous or you cannot ' +
  'make something out, say so plainly instead of guessing.';

function describeFailure(status, body) {
  let detail = '';
  try {
    detail = JSON.parse(body)?.error?.message ?? '';
  } catch {}
  if (status === 401) return 'The API key was rejected.';
  if (status === 429) return 'Rate limited — try again in a moment.';
  if (status >= 500) return 'The API had a problem.';
  return detail || `Request failed (${status}).`;
}

/**
 * Streams a reply. Resolves once the stream ends; failures are reported through
 * onError rather than thrown, since the caller is an IPC handler with nowhere
 * to put an exception.
 */
async function askClaude({ url, key, model, messages, maxTokens = 1024, signal, onDelta, onError, onDone }) {
  if (!key) {
    onError('No API key set.');
    return;
  }
  try {
    const res = await fetch(url || DEFAULT_URL, {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': API_VERSION,
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system: SYSTEM_PROMPT,
        messages,
        stream: true,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      onError(describeFailure(res.status, body));
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // A chunk can split mid-line, so the tail is held back until it completes.
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data) continue;
        let event;
        try {
          event = JSON.parse(data);
        } catch {
          continue;
        }
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
          onDelta(event.delta.text);
        } else if (event.type === 'error') {
          onError(event.error?.message ?? 'The stream failed.');
          return;
        }
      }
    }
    onDone();
  } catch (err) {
    // An abort is a deliberate stop, not a failure worth showing.
    if (signal?.aborted) onDone();
    else onError(err?.message ?? 'Could not reach the API.');
  }
}

module.exports = { askClaude, SYSTEM_PROMPT, DEFAULT_URL, API_VERSION };

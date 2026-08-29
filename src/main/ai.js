const YAGAMI_URL = 'http://127.0.0.1:8787/v1/messages';

// Yagami completions deliberately expose no function tools. Drawing therefore
// travels as a small tagged JSON block and is validated again in the renderer
// before it can become board content.
const SYSTEM_PROMPT =
  'You are working with a cropped region of a hand-drawn infinite whiteboard. ' +
  'Read what is actually there, including messy handwriting, and answer concisely. ' +
  'You can also draw on the board. When the user asks you to draw, annotate, circle, ' +
  'connect, correct, or extend something, emit the exact form ' +
  '<betterboard-draw>{"commands":[]}</betterboard-draw> with valid JSON. Supported ' +
  'commands are stroke, line, arrow, rectangle, and ellipse. Coordinates run from ' +
  '0 to 1000 across the selected image in both axes. A stroke has points containing ' +
  'x, y, and optional pressure. Lines and arrows use x1, y1, x2, y2. Rectangles and ' +
  'ellipses use x, y, width, and height. Commands may include a six-digit hex color ' +
  'and size from 1 to 28. Keep drawings inside the range, briefly explain what you ' +
  'drew outside the tag, and never claim you drew unless you supplied commands.';

function normalizeUrl(raw) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  const url = new URL(value || YAGAMI_URL);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Yagami URL must use http:// or https://.');
  }
  if (url.username || url.password) throw new Error('Yagami URL must not contain credentials.');
  url.hash = '';
  url.pathname = url.pathname.replace(/\/+$/, '');
  if (!url.pathname.endsWith('/v1/messages')) {
    const tail = url.pathname.endsWith('/v1') ? '/messages' : '/v1/messages';
    url.pathname = `${url.pathname}${tail}`.replace(/^\/\//, '/');
  }
  return url.toString();
}

function endpointFor(connection) {
  if (connection?.kind !== 'remote') throw new Error('Only remote Yagami connections have a URL.');
  return normalizeUrl(connection.url);
}

function describeFailure(status, body) {
  let detail = '';
  try {
    const parsed = JSON.parse(body);
    detail = parsed?.error?.message ?? parsed?.message ?? '';
  } catch {}
  if (status === 401 || status === 403) return 'The Yagami personal API key was rejected.';
  if (status === 429) return 'Yagami is rate limited — try again in a moment.';
  if (status >= 500) return detail || 'The selected coding-agent harness had a problem.';
  return detail || `Yagami request failed (${status}).`;
}

async function expectOk(response) {
  if (response.ok) return response;
  const body = await response.text().catch(() => '');
  throw new Error(describeFailure(response.status, body));
}

function extractTaggedDraw(text, onDraw) {
  return text.replace(/<betterboard-draw>([\s\S]*?)<\/betterboard-draw>/g, (_match, raw) => {
    try {
      onDraw(JSON.parse(raw));
      return '';
    } catch {
      return '[The drawing commands were invalid.]';
    }
  }).trim();
}

function yagamiMessages(messages) {
  return messages.map((message) => {
    if (!message.image) return { role: message.role, content: message.text };
    return {
      role: message.role,
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: message.image } },
        { type: 'text', text: message.text },
      ],
    };
  });
}

function yagamiRequest(connection, messages, stream) {
  const body = {
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    messages: yagamiMessages(messages),
    stream,
  };
  if (connection.model) body.model = connection.model;
  return body;
}

let enginePromise = null;
async function localEngine() {
  if (!enginePromise) {
    enginePromise = import('@justin06lee/yagami')
      .then(({ YagamiEngine }) => new YagamiEngine({ appName: 'BetterBoard' }))
      .catch((error) => {
        enginePromise = null;
        throw error;
      });
  }
  return enginePromise;
}

async function localProviderState(engine) {
  try {
    const yagami = engine ?? await localEngine();
    const providers = yagami.providerIds;
    return providers.length > 0
      ? { providers, error: '' }
      : { providers: [], error: 'No supported coding-agent CLI was found on this computer.' };
  } catch (error) {
    return { providers: [], error: error?.message ?? 'No supported coding-agent CLI was found.' };
  }
}

async function askEmbedded({ connection, messages, signal, onDelta, onDraw, engine }) {
  const yagami = engine ?? await localEngine();
  const { events } = yagami.stream(yagamiRequest(connection, messages, true), { signal });
  let raw = '';
  for await (const event of events) {
    const data = event?.data;
    if (data?.type === 'content_block_delta' && data.delta?.type === 'text_delta') {
      raw += data.delta.text ?? '';
    } else if (event?.event === 'error') {
      throw new Error(data?.error?.message ?? 'The local coding-agent harness failed.');
    }
  }
  const text = extractTaggedDraw(raw, onDraw);
  if (text) onDelta(text);
}

async function askRemote({ connection, messages, signal, onDelta, onDraw }) {
  const headers = { 'content-type': 'application/json' };
  if (connection.key) headers['x-api-key'] = connection.key;
  const response = await expectOk(await fetch(endpointFor(connection), {
    method: 'POST',
    signal,
    headers,
    body: JSON.stringify(yagamiRequest(connection, messages, false)),
  }));
  const data = await response.json();
  const raw = (data.content ?? [])
    .filter((block) => block?.type === 'text')
    .map((block) => String(block.text ?? ''))
    .join('');
  const text = extractTaggedDraw(raw, onDraw);
  if (text) onDelta(text);
}

async function askAI(options) {
  const { connection, signal, onError, onDone } = options;
  try {
    if (connection.kind === 'embedded') await askEmbedded(options);
    else if (connection.kind === 'remote') await askRemote(options);
    else throw new Error('Unknown Yagami connection type.');
    onDone();
  } catch (error) {
    if (signal?.aborted) onDone();
    else onError(error?.message ?? 'Could not use Yagami.');
  }
}

module.exports = {
  askAI,
  askEmbedded,
  askRemote,
  localProviderState,
  endpointFor,
  extractTaggedDraw,
  SYSTEM_PROMPT,
  YAGAMI_URL,
};

const { describe, expect, test } = require('bun:test');
const { askAI, endpointFor, extractTaggedDraw, localProviderState } = require('./ai');

describe('endpointFor', () => {
  test('fills the Yagami Messages API path', () => {
    expect(endpointFor({ kind: 'remote', url: 'http://localhost:8787' })).toBe('http://localhost:8787/v1/messages');
    expect(endpointFor({ kind: 'remote', url: 'http://localhost:8787/v1' })).toBe('http://localhost:8787/v1/messages');
    expect(endpointFor({ kind: 'remote', url: 'http://localhost:8787/v1/messages' })).toBe('http://localhost:8787/v1/messages');
  });

  test('rejects unsafe endpoint schemes and embedded credentials', () => {
    expect(() => endpointFor({ kind: 'remote', url: 'file:///tmp/api' })).toThrow('http:// or https://');
    expect(() => endpointFor({ kind: 'remote', url: 'http://key@localhost:8787' })).toThrow('must not contain credentials');
  });
});

describe('extractTaggedDraw', () => {
  test('extracts drawing JSON and removes it from visible text', () => {
    const drawings = [];
    const text = extractTaggedDraw(
      'Done. <betterboard-draw>{"commands":[{"type":"line","x1":0,"y1":0,"x2":10,"y2":10}]}</betterboard-draw>',
      (drawing) => drawings.push(drawing)
    );
    expect(text).toBe('Done.');
    expect(drawings[0].commands[0].type).toBe('line');
  });
});

describe('Yagami adapters', () => {
  test('reports coding-agent providers detected by the embedded engine', async () => {
    expect(await localProviderState({ providerIds: ['claude', 'codex', 'opencode'] })).toEqual({
      providers: ['claude', 'codex', 'opencode'],
      error: '',
    });
  });

  test('reports when embedded mode cannot find an installed harness', async () => {
    expect(await localProviderState({ providerIds: [] })).toEqual({
      providers: [],
      error: 'No supported coding-agent CLI was found on this computer.',
    });
  });

  test('drives an installed local harness through the embedded engine', async () => {
    let request;
    let streamOptions;
    const engine = {
      stream(body, options) {
        request = body;
        streamOptions = options;
        return { events: (async function* () {
          yield { event: 'content_block_delta', data: { type: 'content_block_delta', delta: {
            type: 'text_delta',
            text: 'Local. <betterboard-draw>{"commands":[{"type":"line","x1":0,"y1":0,"x2":10,"y2":10}]}</betterboard-draw>',
          } } };
        })() };
      },
    };
    const drawings = [];
    const deltas = [];
    const controller = new AbortController();
    await askAI({
      connection: { kind: 'embedded', key: '', model: 'codex', url: '' },
      messages: [{ role: 'user', text: 'draw locally', image: 'abc' }],
      signal: controller.signal,
      engine,
      onDelta: (text) => deltas.push(text),
      onDraw: (drawing) => drawings.push(drawing),
      onError: (error) => { throw new Error(error); },
      onDone: () => {},
    });
    expect(request.model).toBe('codex');
    expect(request.stream).toBe(true);
    expect(request.messages[0].content[0].type).toBe('image');
    expect(streamOptions.signal).toBe(controller.signal);
    expect(drawings[0].commands[0].type).toBe('line');
    expect(deltas.join('')).toBe('Local.');
  });

  test('sends an optional personal key, routed model, and image to a remote server', async () => {
    const originalFetch = global.fetch;
    let request;
    const drawings = [];
    const deltas = [];
    try {
      global.fetch = async (url, options) => {
        request = { url, headers: options.headers, body: JSON.parse(options.body) };
        return Response.json({
          content: [{
            type: 'text',
            text: 'Added it. <betterboard-draw>{"commands":[{"type":"ellipse","x":1,"y":2,"width":3,"height":4}]}</betterboard-draw>',
          }],
        });
      };
      await askAI({
        connection: { kind: 'remote', key: 'ygm_personal', model: 'codex:gpt-5.6-sol', url: 'http://127.0.0.1:8787' },
        messages: [{ role: 'user', text: 'circle it', image: 'abc' }],
        signal: new AbortController().signal,
        onDelta: (text) => deltas.push(text),
        onDraw: (drawing) => drawings.push(drawing),
        onError: (error) => { throw new Error(error); },
        onDone: () => {},
      });
      expect(request.url).toBe('http://127.0.0.1:8787/v1/messages');
      expect(request.headers['x-api-key']).toBe('ygm_personal');
      expect(request.body.model).toBe('codex:gpt-5.6-sol');
      expect(request.body.tools).toBeUndefined();
      expect(request.body.messages[0].content[0].type).toBe('image');
      expect(drawings[0].commands[0].type).toBe('ellipse');
      expect(deltas.join('')).toBe('Added it.');
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('omits authentication when a remote connection has no personal key', async () => {
    const originalFetch = global.fetch;
    let headers;
    try {
      global.fetch = async (_url, options) => {
        headers = options.headers;
        return Response.json({ content: [{ type: 'text', text: 'Hello.' }] });
      };
      await askAI({
        connection: { kind: 'remote', key: '', model: '', url: 'http://server:8787' },
        messages: [{ role: 'user', text: 'hello' }],
        signal: new AbortController().signal,
        onDelta: () => {},
        onDraw: () => {},
        onError: (error) => { throw new Error(error); },
        onDone: () => {},
      });
      expect(headers['x-api-key']).toBeUndefined();
    } finally {
      global.fetch = originalFetch;
    }
  });
});

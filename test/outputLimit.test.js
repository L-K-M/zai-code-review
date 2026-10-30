const { EventEmitter } = require('events');

jest.mock('https', () => ({ request: jest.fn() }));
const https = require('https');

const { reviewOneChunk } = require('../src/index');

const LENGTH = 'data: {"choices":[{"delta":{"reasoning_content":"…"},"finish_reason":"length"}]}\n\n';
const STOP = 'data: {"choices":[{"delta":{"content":"Looks fine."},"finish_reason":"stop"}]}\n\n';

// Answers each request with the next queued stream and records its body.
function queueStreams(streams) {
  const bodies = [];
  https.request.mockImplementation((_options, onResponse) => {
    const request = new EventEmitter();
    let written = '';
    request.setTimeout = jest.fn();
    request.destroy = jest.fn();
    request.write = chunk => {
      written += chunk;
    };
    request.end = () => {
      bodies.push(JSON.parse(written));
      const response = new EventEmitter();
      response.statusCode = 200;
      response.headers = { 'content-type': 'text/event-stream' };
      onResponse(response);
      const next = streams.shift();
      if (!next) {
        throw new Error(`request ${bodies.length} has no stream queued`);
      }
      response.emit('data', Buffer.from(`${next}data: [DONE]\n\n`));
      response.emit('end');
    };
    return request;
  });
  return bodies;
}

function review(files, model = 'glm-5.3', reasoningEffort = 'high') {
  return reviewOneChunk({
    apiKey: 'key',
    model,
    systemPrompt: 'system',
    chunkFiles: files,
    chunkIndex: 0,
    totalChunks: 1,
    maxChunkSize: 25000,
    apiOptions: { reasoningEffort },
    scopeMode: 'full',
    customPatterns: [],
  });
}

const FILE = { filename: 'src/a.js', status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b' };
// Two files whose patches together exceed half of the 25000 chunk size.
const LARGE = '@@ -1 +1 @@\n' + '+line\n'.repeat(1500);

beforeEach(() => {
  https.request.mockReset();
});

describe('a section that reaches the output token limit', () => {
  test('is retried whole with low reasoning effort before it is split', async () => {
    const bodies = queueStreams([LENGTH, STOP]);

    const result = await review([FILE]);

    expect(result.rawReview).toBe('Looks fine.');
    expect(bodies.map(body => body.reasoning_effort)).toEqual(['high', 'low']);
    expect(bodies[1]).toEqual({ ...bodies[0], reasoning_effort: 'low' });
  });

  test('is split as before when low reasoning effort also overflows', async () => {
    const files = [
      { ...FILE, patch: LARGE },
      { ...FILE, filename: 'src/b.js', patch: LARGE },
    ];
    const bodies = queueStreams([LENGTH, LENGTH, STOP, STOP]);

    const result = await review(files);

    expect(result.rawReview).toBe('Looks fine.\n\nLooks fine.');
    // The halves keep the lowered effort rather than overflowing at high again.
    expect(bodies.map(body => body.reasoning_effort)).toEqual(['high', 'low', 'low', 'low']);
  });

  test.each([
    ['a model without reasoning effort', 'mimo-v2.6-pro', 'high', undefined],
    ['a section already at low effort', 'glm-5.3', 'low', 'low'],
  ])('keeps its effort for %s', async (_name, model, effort, sent) => {
    jest.useFakeTimers();
    try {
      const bodies = queueStreams([LENGTH, STOP]);

      const pending = review([FILE], model, effort);
      await jest.runAllTimersAsync();

      expect((await pending).rawReview).toBe('Looks fine.');
      expect(bodies.map(body => body.reasoning_effort)).toEqual([sent, sent]);
    } finally {
      jest.useRealTimers();
    }
  });
});

const { EventEmitter } = require('events');

jest.mock('https', () => ({ request: jest.fn() }));
const https = require('https');

const {
  buildModelRoutingNotice,
  callZaiApi,
  parseFallbackProvider,
  reviewChunkWithFallbacks,
} = require('../src/index');

const FALLBACK = {
  apiKey: 'fallback-key',
  apiUrl: 'https://token-plan-sgp.xiaomimimo.com/v1/chat/completions',
  model: 'mimo-v2.6-pro',
};

function httpError(statusCode) {
  const error = new Error(`Z.ai API: HTTP ${statusCode}.`);
  error.statusCode = statusCode;
  return error;
}

// Fake reviewOneChunk: each model answers with the queued outcome.
function fakeReviewer(outcomes) {
  const calls = [];
  const reviewChunk = jest.fn(async args => {
    calls.push({ model: args.model, apiKey: args.apiKey, endpoint: args.apiOptions.endpoint });
    const outcome = outcomes[args.model];
    if (outcome instanceof Error) {
      throw outcome;
    }
    return { index: args.chunkIndex, rawReview: outcome, success: true, model: args.model };
  });
  return { reviewChunk, calls };
}

function primary(overrides = {}) {
  return {
    apiKey: 'zai-key',
    apiOptions: { maxOutputTokens: 98304 },
    model: 'glm-5.3',
    tier: 'deep',
    degradeModel: 'glm-5.3-flash',
    ...overrides,
  };
}

describe('parseFallbackProvider', () => {
  test('is disabled without a key', () => {
    expect(parseFallbackProvider({ apiKey: ' ', apiUrl: FALLBACK.apiUrl, model: FALLBACK.model })).toBeNull();
  });

  test('accepts a complete https provider', () => {
    expect(parseFallbackProvider({ apiKey: ' fallback-key ', apiUrl: FALLBACK.apiUrl, model: ' mimo-v2.6-pro ' }))
      .toEqual(FALLBACK);
  });

  test.each([
    ['a missing model', { apiUrl: FALLBACK.apiUrl, model: '' }],
    ['a missing URL', { apiUrl: '', model: FALLBACK.model }],
    ['a non-https URL', { apiUrl: 'http://token-plan-sgp.xiaomimimo.com/v1/chat/completions', model: FALLBACK.model }],
    ['an invalid URL', { apiUrl: 'not a url', model: FALLBACK.model }],
  ])('is disabled by %s', (_name, input) => {
    expect(parseFallbackProvider({ apiKey: 'fallback-key', ...input })).toBeNull();
  });
});

describe('reviewChunkWithFallbacks', () => {
  const chunk = { chunkIndex: 0, chunkFiles: [] };

  test('returns the routed Z.ai review without other attempts', async () => {
    const { reviewChunk, calls } = fakeReviewer({ 'glm-5.3': 'deep review' });
    const outcome = await reviewChunkWithFallbacks({ chunk, primary: primary(), fallback: FALLBACK, label: 'Chunk 1/1', reviewChunk });
    expect(outcome.result).toMatchObject({ rawReview: 'deep review', tier: 'deep' });
    expect(outcome.primaryRateLimited).toBe(false);
    expect(calls.map(call => call.model)).toEqual(['glm-5.3']);
  });

  test('degrades a rate-limited deep chunk to the fast model before the fallback', async () => {
    const { reviewChunk, calls } = fakeReviewer({ 'glm-5.3': httpError(429), 'glm-5.3-flash': 'fast review' });
    const outcome = await reviewChunkWithFallbacks({ chunk, primary: primary(), fallback: FALLBACK, label: 'Chunk 1/1', reviewChunk });
    expect(outcome.result).toMatchObject({ rawReview: 'fast review', tier: 'degraded' });
    expect(calls.map(call => call.model)).toEqual(['glm-5.3', 'glm-5.3-flash']);
  });

  test('sends the chunk to the fallback endpoint and key when Z.ai is rate-limited', async () => {
    const { reviewChunk, calls } = fakeReviewer({
      'glm-5.3': httpError(429),
      'glm-5.3-flash': httpError(429),
      'mimo-v2.6-pro': 'mimo review',
    });
    const outcome = await reviewChunkWithFallbacks({ chunk, primary: primary(), fallback: FALLBACK, label: 'Chunk 1/1', reviewChunk });
    expect(outcome.result).toMatchObject({ rawReview: 'mimo review', tier: 'fallback' });
    expect(outcome.primaryRateLimited).toBe(true);
    expect(calls).toEqual([
      { model: 'glm-5.3', apiKey: 'zai-key', endpoint: undefined },
      { model: 'glm-5.3-flash', apiKey: 'zai-key', endpoint: undefined },
      { model: 'mimo-v2.6-pro', apiKey: 'fallback-key', endpoint: FALLBACK.apiUrl },
    ]);
    expect(reviewChunk.mock.calls[2][0].apiOptions).toMatchObject({ maxOutputTokens: 98304, errorPrefix: 'Fallback API: ' });
  });

  test('skips the fast model when the deep failure was not a rate limit', async () => {
    const { reviewChunk, calls } = fakeReviewer({ 'glm-5.3': httpError(500), 'mimo-v2.6-pro': 'mimo review' });
    const outcome = await reviewChunkWithFallbacks({ chunk, primary: primary(), fallback: FALLBACK, label: 'Chunk 1/1', reviewChunk });
    expect(outcome.result.tier).toBe('fallback');
    expect(outcome.primaryRateLimited).toBe(false);
    expect(calls.map(call => call.model)).toEqual(['glm-5.3', 'mimo-v2.6-pro']);
  });

  test('tries the fallback first after an earlier rate limit, keeping Z.ai as the backstop', async () => {
    const { reviewChunk, calls } = fakeReviewer({ 'mimo-v2.6-pro': httpError(503), 'glm-5.3': 'deep review' });
    const outcome = await reviewChunkWithFallbacks({
      chunk, primary: primary(), fallback: FALLBACK, skipPrimary: true, label: 'Chunk 2/2', reviewChunk,
    });
    expect(outcome.result.tier).toBe('deep');
    expect(calls.map(call => call.model)).toEqual(['mimo-v2.6-pro', 'glm-5.3']);
  });

  test('reports every failed attempt when nothing answers', async () => {
    const { reviewChunk } = fakeReviewer({
      'glm-5.3': httpError(429),
      'glm-5.3-flash': httpError(429),
      'mimo-v2.6-pro': httpError(401),
    });
    const outcome = await reviewChunkWithFallbacks({ chunk, primary: primary(), fallback: FALLBACK, label: 'Chunk 1/1', reviewChunk });
    expect(outcome.result).toBeUndefined();
    expect(outcome.error).toBe(
      'glm-5.3: Z.ai API: HTTP 429.; glm-5.3-flash: Z.ai API: HTTP 429.; mimo-v2.6-pro: Z.ai API: HTTP 401.'
    );
    expect(outcome.primaryRateLimited).toBe(true);
  });

  test('a rate-limited fallback does not count as a Z.ai rate limit', async () => {
    const { reviewChunk } = fakeReviewer({ 'mimo-v2.6-pro': httpError(429), 'glm-5.3': 'deep review' });
    const outcome = await reviewChunkWithFallbacks({
      chunk, primary: primary(), fallback: FALLBACK, skipPrimary: true, label: 'Chunk 2/2', reviewChunk,
    });
    expect(outcome.result.tier).toBe('deep');
    expect(outcome.primaryRateLimited).toBe(false);
  });

  test('keeps the previous behavior without a fallback', async () => {
    const { reviewChunk, calls } = fakeReviewer({ 'glm-5.3': httpError(500) });
    const outcome = await reviewChunkWithFallbacks({
      chunk, primary: primary({ degradeModel: '' }), skipPrimary: true, label: 'Chunk 1/1', reviewChunk,
    });
    expect(outcome.error).toBe('glm-5.3: Z.ai API: HTTP 500.');
    expect(calls.map(call => call.model)).toEqual(['glm-5.3']);
  });
});

describe('buildModelRoutingNotice', () => {
  test('counts chunks the fallback reviewed', () => {
    const notice = buildModelRoutingNotice({
      deepModel: 'glm-5.3',
      fastModel: 'glm-5.3-flash',
      fallbackModel: 'mimo-v2.6-pro',
      reviews: [
        { success: true, tier: 'deep' },
        { success: true, tier: 'fallback' },
        { success: true, tier: 'fallback' },
      ],
    });
    expect(notice).toBe(
      '> [!NOTE]\n> Model routing: 1 deep (glm-5.3), 2 reviewed by fallback mimo-v2.6-pro after Z.ai failed.'
    );
  });
});

describe('callZaiApi endpoint', () => {
  test('posts to the fallback endpoint with its key', async () => {
    let options;
    https.request.mockImplementation((requestOptions, onResponse) => {
      options = requestOptions;
      const request = new EventEmitter();
      request.setTimeout = jest.fn();
      request.write = jest.fn();
      request.destroy = jest.fn();
      request.end = () => {
        const response = new EventEmitter();
        response.statusCode = 200;
        response.headers = { 'content-type': 'text/event-stream' };
        onResponse(response);
        response.emit('data', Buffer.from(
          'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n'
            + 'data: [DONE]\n\n'
        ));
        response.emit('end');
      };
      return request;
    });

    const review = await callZaiApi('fallback-key', 'mimo-v2.6-pro', 'system', 'prompt', {
      endpoint: 'https://token-plan-sgp.xiaomimimo.com/v1/chat/completions',
    });
    expect(review).toBe('ok');
    expect(options).toMatchObject({
      hostname: 'token-plan-sgp.xiaomimimo.com',
      path: '/v1/chat/completions',
      method: 'POST',
    });
    expect(options.headers.Authorization).toBe('Bearer fallback-key');
  });

  test('labels fallback errors with the fallback prefix', async () => {
    https.request.mockImplementation((_requestOptions, onResponse) => {
      const request = new EventEmitter();
      request.setTimeout = jest.fn();
      request.write = jest.fn();
      request.destroy = jest.fn();
      request.end = () => {
        const response = new EventEmitter();
        response.statusCode = 503;
        response.headers = {};
        onResponse(response);
        response.emit('end');
      };
      return request;
    });

    await expect(callZaiApi('fallback-key', 'mimo-v2.6-pro', 'system', 'prompt', {
      endpoint: FALLBACK.apiUrl,
      errorPrefix: 'Fallback API: ',
    })).rejects.toMatchObject({ message: 'Fallback API: HTTP 503.', statusCode: 503 });
  });
});

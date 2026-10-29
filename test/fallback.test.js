const { EventEmitter } = require('events');

jest.mock('https', () => ({ request: jest.fn() }));
const https = require('https');

afterEach(() => {
  https.request.mockReset();
});

const {
  buildModelRoutingNotice,
  callZaiApi,
  parseFallbackProvider,
  parseFastProvider,
  reviewChunkWithFallbacks,
  nextPrimaryUnavailable,
  nextFastUnavailable,
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

// Fake reviewOneChunk: each model answers with the queued outcome. Results
// deliberately omit `model` — reviewChunkWithFallbacks must stamp it.
function fakeReviewer(outcomes) {
  const calls = [];
  const reviewChunk = jest.fn(async args => {
    calls.push({ model: args.model, apiKey: args.apiKey, endpoint: args.apiOptions.endpoint });
    const outcome = outcomes[args.model];
    if (outcome instanceof Error) {
      throw outcome;
    }
    return { index: args.chunkIndex, rawReview: outcome, success: true };
  });
  return { reviewChunk, calls };
}

function primary(overrides = {}) {
  return {
    apiKey: 'zai-key',
    apiOptions: { maxOutputTokens: 98304 },
    model: 'glm-5.3',
    tier: 'deep',
    provider: 'zai',
    degrade: {
      model: 'glm-5.3-flash',
      apiKey: 'zai-key',
      apiOptions: { maxOutputTokens: 98304 },
      provider: 'zai',
    },
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

const STEPFUN = {
  apiKey: 'stepfun-key',
  apiUrl: 'https://api.stepfun.ai/step_plan/v1/chat/completions',
  model: 'step-5-preview',
};

// A fast chunk served by the dedicated provider: its own key and endpoint,
// with the Z.ai fast model chained as the same-tier backstop.
function fastPrimary(overrides = {}) {
  return {
    apiKey: STEPFUN.apiKey,
    apiOptions: { maxOutputTokens: 98304, endpoint: STEPFUN.apiUrl, errorPrefix: 'Fast API: ' },
    model: 'step-5-preview',
    tier: 'fast',
    provider: 'fast',
    secondary: {
      model: 'glm-5.3-flash',
      apiKey: 'zai-key',
      apiOptions: { maxOutputTokens: 98304 },
      provider: 'zai',
    },
    ...overrides,
  };
}

describe('parseFastProvider', () => {
  test('is disabled without a key', () => {
    expect(parseFastProvider({ apiKey: '', apiUrl: STEPFUN.apiUrl, model: STEPFUN.model })).toBeNull();
    expect(parseFastProvider({ apiKey: '   ', apiUrl: STEPFUN.apiUrl, model: STEPFUN.model })).toBeNull();
  });

  test('rejects a URL with embedded credentials', () => {
    expect(parseFastProvider({
      apiKey: 'stepfun-key', apiUrl: 'https://user:pass@api.stepfun.ai/step_plan/v1/chat/completions', model: STEPFUN.model,
    })).toBeNull();
  });

  test('accepts a complete https provider', () => {
    expect(parseFastProvider({ apiKey: ' stepfun-key ', apiUrl: STEPFUN.apiUrl, model: ' step-5-preview ' }))
      .toEqual(STEPFUN);
  });

  test.each([
    ['a missing model', { apiUrl: STEPFUN.apiUrl, model: '' }],
    ['a missing URL', { apiUrl: '', model: STEPFUN.model }],
    ['a non-https URL', { apiUrl: 'http://api.stepfun.ai/step_plan/v1/chat/completions', model: STEPFUN.model }],
    ['an invalid URL', { apiUrl: 'not a url', model: STEPFUN.model }],
  ])('is disabled by %s', (_name, input) => {
    expect(parseFastProvider({ apiKey: 'stepfun-key', ...input })).toBeNull();
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
      chunk, primary: primary({ degrade: null }), skipPrimary: true, label: 'Chunk 1/1', reviewChunk,
    });
    expect(outcome.error).toBe('glm-5.3: Z.ai API: HTTP 500.');
    expect(calls.map(call => call.model)).toEqual(['glm-5.3']);
  });

  test('serves a fast chunk from its dedicated provider', async () => {
    const { reviewChunk, calls } = fakeReviewer({ 'step-5-preview': 'stepfun review' });
    const outcome = await reviewChunkWithFallbacks({ chunk, primary: fastPrimary(), fallback: FALLBACK, label: 'Chunk 1/1', reviewChunk });
    expect(outcome.result).toMatchObject({
      rawReview: 'stepfun review', tier: 'fast', provider: 'fast', model: 'step-5-preview',
    });
    expect(outcome.primaryRateLimited).toBe(false);
    expect(calls).toEqual([
      { model: 'step-5-preview', apiKey: 'stepfun-key', endpoint: STEPFUN.apiUrl },
    ]);
  });

  test('treats attempts without provider as Z.ai for rate-limit detection', async () => {
    // Callers using the pre-provider object shape keep the old semantics:
    // an unlabeled degrade attempt belongs to the Z.ai plan, so its 429 counts.
    const { reviewChunk } = fakeReviewer({
      'glm-5.3': httpError(429),
      'glm-5.3-flash': httpError(429),
    });
    const legacyPrimary = {
      model: 'glm-5.3',
      tier: 'deep',
      apiKey: 'zai-key',
      apiOptions: {},
      degrade: { model: 'glm-5.3-flash', apiKey: 'zai-key', apiOptions: {} },
    };
    const outcome = await reviewChunkWithFallbacks({ chunk, primary: legacyPrimary, fallback: null, label: 'Chunk 1/1', reviewChunk });
    expect(outcome.primaryRateLimited).toBe(true);
  });

  test('reports fastRateLimited when the fast provider 429s but a backstop answers', async () => {
    const { reviewChunk, calls } = fakeReviewer({
      'step-5-preview': httpError(429),
      'glm-5.3-flash': 'zai fast review',
    });
    const outcome = await reviewChunkWithFallbacks({ chunk, primary: fastPrimary(), fallback: FALLBACK, label: 'Chunk 1/1', reviewChunk });
    expect(outcome.result).toMatchObject({ rawReview: 'zai fast review', provider: 'zai', model: 'glm-5.3-flash' });
    expect(outcome.fastRateLimited).toBe(true);
    expect(outcome.primaryRateLimited).toBe(false);
    expect(calls.map(call => call.model)).toEqual(['step-5-preview', 'glm-5.3-flash']);
  });

  test('falls back to the Z.ai fast model when the fast provider fails', async () => {
    const { reviewChunk, calls } = fakeReviewer({
      'step-5-preview': httpError(503),
      'glm-5.3-flash': 'zai fast review',
    });
    const outcome = await reviewChunkWithFallbacks({ chunk, primary: fastPrimary(), fallback: FALLBACK, label: 'Chunk 1/1', reviewChunk });
    expect(outcome.result).toMatchObject({ rawReview: 'zai fast review', tier: 'fast', provider: 'zai', model: 'glm-5.3-flash' });
    expect(calls).toEqual([
      { model: 'step-5-preview', apiKey: 'stepfun-key', endpoint: STEPFUN.apiUrl },
      { model: 'glm-5.3-flash', apiKey: 'zai-key', endpoint: undefined },
    ]);
  });

  test('a non-429 fast-provider failure sets neither rate-limit flag', async () => {
    const { reviewChunk } = fakeReviewer({
      'step-5-preview': httpError(500),
      'glm-5.3-flash': 'zai fast review',
    });
    const outcome = await reviewChunkWithFallbacks({ chunk, primary: fastPrimary(), fallback: FALLBACK, label: 'Chunk 1/1', reviewChunk });
    expect(outcome.result.provider).toBe('zai');
    expect(outcome.primaryRateLimited).toBe(false);
    expect(outcome.fastRateLimited).toBe(false);
  });

  test('degrades a rate-limited deep chunk to the fast provider before the fallback', async () => {
    const { reviewChunk, calls } = fakeReviewer({
      'glm-5.3': httpError(429),
      'step-5-preview': 'stepfun review',
    });
    const outcome = await reviewChunkWithFallbacks({
      chunk,
      primary: primary({
        degrade: {
          model: 'step-5-preview',
          apiKey: STEPFUN.apiKey,
          apiOptions: { maxOutputTokens: 98304, endpoint: STEPFUN.apiUrl, errorPrefix: 'Fast API: ' },
          provider: 'fast',
        },
      }),
      fallback: FALLBACK,
      label: 'Chunk 1/1',
      reviewChunk,
    });
    expect(outcome.result).toMatchObject({ rawReview: 'stepfun review', tier: 'degraded', provider: 'fast', model: 'step-5-preview' });
    expect(outcome.primaryRateLimited).toBe(true);
    expect(calls).toEqual([
      { model: 'glm-5.3', apiKey: 'zai-key', endpoint: undefined },
      { model: 'step-5-preview', apiKey: 'stepfun-key', endpoint: STEPFUN.apiUrl },
    ]);
  });

  test('promotes a cross-provider degrade ahead of the fallback while Z.ai is rate-limited', async () => {
    const { reviewChunk, calls } = fakeReviewer({ 'step-5-preview': 'stepfun review' });
    const outcome = await reviewChunkWithFallbacks({
      chunk,
      primary: primary({
        degrade: {
          model: 'step-5-preview',
          apiKey: STEPFUN.apiKey,
          apiOptions: { maxOutputTokens: 98304, endpoint: STEPFUN.apiUrl, errorPrefix: 'Fast API: ' },
          provider: 'fast',
        },
      }),
      fallback: FALLBACK,
      skipPrimary: true,
      label: 'Chunk 2/2',
      reviewChunk,
    });
    expect(outcome.result).toMatchObject({ rawReview: 'stepfun review', tier: 'degraded', provider: 'fast', model: 'step-5-preview' });
    expect(calls).toEqual([
      { model: 'step-5-preview', apiKey: 'stepfun-key', endpoint: STEPFUN.apiUrl },
    ]);
  });

  test('does not promote a degrade that omits the provider field', async () => {
    // Legacy callers may build the degrade object without provider; it must
    // default to Z.ai and keep fallback-first order, never be promoted.
    const { reviewChunk, calls } = fakeReviewer({ 'mimo-v2.6-pro': 'mimo review' });
    const outcome = await reviewChunkWithFallbacks({
      chunk,
      primary: primary({
        degrade: { model: 'glm-5.3-flash', apiKey: 'zai-key', apiOptions: {} },
      }),
      fallback: FALLBACK, skipPrimary: true, label: 'Chunk 2/2', reviewChunk,
    });
    expect(outcome.result.tier).toBe('fallback');
    expect(calls.map(call => call.model)).toEqual(['mimo-v2.6-pro']);
  });

  test.each([
    ['no key and no endpoint', { model: 'step-5-preview', provider: 'fast' }],
    ['a key but no endpoint', { model: 'step-5-preview', provider: 'fast', apiKey: STEPFUN.apiKey }],
    ['an endpoint but no key', {
      model: 'step-5-preview',
      provider: 'fast',
      apiOptions: { maxOutputTokens: 98304, endpoint: STEPFUN.apiUrl, errorPrefix: 'Fast API: ' },
    }],
  ])('skips a foreign deputy with %s instead of sending the Z.ai key', async (_name, degrade) => {
    // A partially configured cross-provider degrade must be dropped, not
    // completed with the primary's credentials — those would leak to a
    // third-party API.
    const { reviewChunk, calls } = fakeReviewer({
      'mimo-v2.6-pro': 'mimo review',
      'glm-5.3': httpError(429),
    });
    const outcome = await reviewChunkWithFallbacks({
      chunk,
      primary: primary({ degrade }),
      fallback: FALLBACK, skipPrimary: true, label: 'Chunk 2/2', reviewChunk,
    });
    expect(outcome.result.tier).toBe('fallback');
    expect(calls.map(call => call.model)).toEqual(['mimo-v2.6-pro']);
  });

  test('skips a provider-less secondary behind a fast-provider primary instead of sending the fast key', async () => {
    // Mirror of the deputy guard: a Z.ai-flagged backstop that carries no
    // credentials must not inherit the fast provider's key and endpoint.
    const { reviewChunk, calls } = fakeReviewer({
      'step-5-preview': httpError(503),
      'mimo-v2.6-pro': 'mimo review',
    });
    const outcome = await reviewChunkWithFallbacks({
      chunk,
      primary: fastPrimary({ secondary: { model: 'glm-5.3-flash', provider: 'zai' } }),
      fallback: FALLBACK, label: 'Chunk 1/1', reviewChunk,
    });
    expect(outcome.result.tier).toBe('fallback');
    expect(calls.map(call => call.model)).toEqual(['step-5-preview', 'mimo-v2.6-pro']);
  });

  test('keeps the outage fallback first when the degrade is on the rate-limited plan', async () => {
    const { reviewChunk, calls } = fakeReviewer({ 'mimo-v2.6-pro': 'mimo review' });
    const outcome = await reviewChunkWithFallbacks({
      chunk, primary: primary(), fallback: FALLBACK, skipPrimary: true, label: 'Chunk 2/2', reviewChunk,
    });
    expect(outcome.result.tier).toBe('fallback');
    expect(calls.map(call => call.model)).toEqual(['mimo-v2.6-pro']);
  });
});

describe('nextPrimaryUnavailable', () => {
  const served = (tier, provider) => ({ result: { tier, provider }, primaryRateLimited: false });
  const limited = outcome => ({ ...outcome, primaryRateLimited: true });

  test('stays off without a configured fallback', () => {
    expect(nextPrimaryUnavailable({
      outcome: limited({ error: 'boom' }), fallback: null, wasUnavailable: false,
    })).toBe(false);
  });

  test('latches when the outage fallback serves after a Z.ai 429', () => {
    expect(nextPrimaryUnavailable({
      outcome: limited(served('fallback', 'fallback')), fallback: FALLBACK, wasUnavailable: false,
    })).toBe(true);
  });

  test('keeps the latch while the fallback keeps serving', () => {
    expect(nextPrimaryUnavailable({
      outcome: served('fallback', 'fallback'), fallback: FALLBACK, wasUnavailable: true,
    })).toBe(true);
  });

  test('clears on any Z.ai answer, including a backstop degrade', () => {
    expect(nextPrimaryUnavailable({
      outcome: served('degraded', 'zai'), fallback: FALLBACK, wasUnavailable: true,
    })).toBe(false);
  });

  test('clears when the deep model answers again', () => {
    expect(nextPrimaryUnavailable({
      outcome: served('deep', 'zai'), fallback: FALLBACK, wasUnavailable: true,
    })).toBe(false);
  });

  test('clears when a provider-less secondary backstop answers', () => {
    // Results stamped from an unlabeled attempt default to Z.ai, so a Z.ai
    // backstop answer still ends the rate-limit window.
    expect(nextPrimaryUnavailable({
      outcome: served('fast', undefined), fallback: FALLBACK, wasUnavailable: true,
    })).toBe(false);
  });

  test('a fast-provider answer releases the latch; its 429 never engages it', () => {
    // Any non-fallback answer off Z.ai releases the latch so the next deep
    // chunk re-probes Z.ai — same rule as a degraded deputy answer.
    expect(nextPrimaryUnavailable({
      outcome: served('fast', 'fast'), fallback: FALLBACK, wasUnavailable: true,
    })).toBe(false);
    expect(nextPrimaryUnavailable({
      outcome: { result: { tier: 'fast', provider: 'zai' }, primaryRateLimited: false, fastRateLimited: true },
      fallback: FALLBACK, wasUnavailable: false,
    })).toBe(false);
  });

  test('a fallback serve without a Z.ai 429 does not latch from cold', () => {
    expect(nextPrimaryUnavailable({
      outcome: served('fallback', 'fallback'), fallback: FALLBACK, wasUnavailable: false,
    })).toBe(false);
  });

  test('clears after a deputy-served degrade so Z.ai is re-probed next', () => {
    // A StepFun answer says nothing about Z.ai's health, but keeping the
    // latch would pin every later deep chunk on the deputy for the run.
    expect(nextPrimaryUnavailable({
      outcome: limited(served('degraded', 'fast')), fallback: FALLBACK, wasUnavailable: false,
    })).toBe(false);
    expect(nextPrimaryUnavailable({
      outcome: served('degraded', 'fast'), fallback: FALLBACK, wasUnavailable: true,
    })).toBe(false);
  });

  test('latches when every attempt fails and Z.ai rate-limited', () => {
    expect(nextPrimaryUnavailable({
      outcome: limited({ error: 'all failed' }), fallback: FALLBACK, wasUnavailable: false,
    })).toBe(true);
  });
});

describe('nextFastUnavailable', () => {
  const served = (tier, provider) => ({ result: { tier, provider }, primaryRateLimited: false, fastRateLimited: false });
  const limited = outcome => ({ ...outcome, fastRateLimited: true });

  test('latches when a backstop serves after the fast provider 429s', () => {
    expect(nextFastUnavailable({
      outcome: limited(served('fast', 'zai')), wasUnavailable: false,
    })).toBe(true);
  });

  test('clears when the fast provider answers again', () => {
    expect(nextFastUnavailable({
      outcome: served('fast', 'fast'), wasUnavailable: true,
    })).toBe(false);
  });

  test('keeps the latch while Z.ai or the fallback keep serving', () => {
    for (const provider of ['zai', 'fallback']) {
      expect(nextFastUnavailable({
        outcome: served('fast', provider), wasUnavailable: true,
      })).toBe(true);
    }
  });

  test('latches even when every attempt fails after the provider 429s', () => {
    expect(nextFastUnavailable({
      outcome: limited({ error: 'all failed' }), wasUnavailable: false,
    })).toBe(true);
  });
});

describe('buildModelRoutingNotice', () => {
  test('counts chunks the fallback reviewed', () => {
    const notice = buildModelRoutingNotice({
      deepModel: 'glm-5.3',
      fallbackModel: 'mimo-v2.6-pro',
      reviews: [
        { success: true, tier: 'deep' },
        { success: true, tier: 'fallback' },
        { success: true, tier: 'fallback' },
      ],
    });
    expect(notice).toBe(
      '> [!NOTE]\n> Model routing: 1 deep (glm-5.3), 2 reviewed by fallback mimo-v2.6-pro after the primary providers failed.'
    );
  });

  test('credits fast and degraded chunks to the model that answered', () => {
    const notice = buildModelRoutingNotice({
      deepModel: 'glm-5.3',
      fallbackModel: 'mimo-v2.6-pro',
      reviews: [
        { success: true, tier: 'deep', model: 'glm-5.3' },
        { success: true, tier: 'fast', model: 'step-5-preview' },
        { success: true, tier: 'fast', model: 'glm-5.3-flash' },
        { success: true, tier: 'degraded', model: 'step-5-preview' },
      ],
    });
    expect(notice).toBe(
      '> [!NOTE]\n> Model routing: 1 deep (glm-5.3), 1 fast (step-5-preview), '
        + '1 fast (glm-5.3-flash), 1 fell back to step-5-preview after rate limiting.'
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

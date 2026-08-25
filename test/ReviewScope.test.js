const {
  normalizeReviewMode,
  resolveReviewMode,
  parseReviewState,
  buildReviewStateMarker,
  selectRotatingAuditFiles,
} = require('../src/review/ReviewScope');
const {
  determineReviewScope,
  buildNextReviewState,
} = require('../src/index');

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

function previousState(overrides = {}) {
  return {
    version: 1,
    lastReviewedSha: SHA_A,
    lastFullReviewSha: SHA_A,
    auditCursor: 0,
    mode: 'full',
    ...overrides,
  };
}

describe('review mode selection and state', () => {
  test('defaults invalid configuration to full and accepts supported modes', () => {
    expect(normalizeReviewMode('HYBRID')).toBe('hybrid');
    expect(normalizeReviewMode('incremental')).toBe('incremental');
    expect(normalizeReviewMode('unknown')).toBe('full');
  });

  test('PR labels override configuration and conflicting labels choose the safest scope', () => {
    expect(resolveReviewMode('full', [{ name: 'zai-review:incremental' }]).mode)
      .toBe('incremental');
    expect(resolveReviewMode('incremental', [
      { name: 'zai-review:hybrid' },
      { name: 'zai-review:full' },
    ]).mode).toBe('full');
  });

  test('round-trips a validated hidden review state marker', () => {
    const state = previousState({ mode: 'hybrid', auditCursor: 3 });
    const marker = buildReviewStateMarker(state);

    expect(parseReviewState(`review\n${marker}\n<!-- zai-code-review -->`)).toEqual(state);
    expect(parseReviewState('<!-- zai-code-review-state:{"version":1} -->')).toBeNull();
  });
});

describe('hybrid scope', () => {
  const fullFiles = [
    { filename: 'delta.js', patch: 'd'.repeat(20), status: 'modified' },
    { filename: 'old-a.js', patch: 'a'.repeat(12), status: 'added' },
    { filename: 'old-b.js', patch: 'b'.repeat(12), status: 'added' },
  ];
  const deltaFiles = [
    { filename: 'delta.js', patch: 'new delta', status: 'modified' },
  ];

  test('rotates a bounded unchanged section and excludes delta paths', () => {
    const first = selectRotatingAuditFiles(fullFiles, deltaFiles, 12, 0);
    const second = selectRotatingAuditFiles(fullFiles, deltaFiles, 12, first.nextCursor);

    expect(first.files.map(file => file.filename)).toEqual(['old-a.js']);
    expect(second.files.map(file => file.filename)).toEqual(['old-b.js']);
    expect(first.files[0].reviewScope).toBe('audit');
  });

  test('bootstraps hybrid mode with a full review when no completed state exists', async () => {
    const scope = await determineReviewScope({
      octokit: {}, owner: 'o', repo: 'r', requestedMode: 'hybrid',
      previousState: null, headSha: SHA_B, fullFiles, auditChars: 12,
    });

    expect(scope.actualMode).toBe('full');
    expect(scope.files).toHaveLength(3);
    expect(scope.reason).toContain('bootstrapping');
  });

  test('reviews the commit delta plus a rotating unchanged section', async () => {
    const octokit = {
      rest: {
        repos: {
          compareCommitsWithBasehead: jest.fn().mockResolvedValue({
            data: { status: 'ahead', files: deltaFiles },
          }),
        },
      },
    };
    const scope = await determineReviewScope({
      octokit, owner: 'o', repo: 'r', requestedMode: 'hybrid',
      previousState: previousState(), headSha: SHA_B, fullFiles, auditChars: 12,
    });

    expect(octokit.rest.repos.compareCommitsWithBasehead).toHaveBeenCalledWith(
      expect.objectContaining({ basehead: `${SHA_A}...${SHA_B}` })
    );
    expect(scope.actualMode).toBe('hybrid');
    expect(scope.files.map(file => [file.filename, file.reviewScope])).toEqual([
      ['delta.js', 'delta'],
      ['old-a.js', 'audit'],
    ]);
    expect(buildNextReviewState(previousState(), scope, SHA_B)).toEqual(
      expect.objectContaining({
        lastReviewedSha: SHA_B,
        lastFullReviewSha: SHA_A,
        mode: 'hybrid',
      })
    );
  });

  test('falls back to full when the prior review is no longer an ancestor', async () => {
    const octokit = {
      rest: {
        repos: {
          compareCommitsWithBasehead: jest.fn().mockResolvedValue({
            data: { status: 'diverged', files: deltaFiles },
          }),
        },
      },
    };
    const scope = await determineReviewScope({
      octokit, owner: 'o', repo: 'r', requestedMode: 'incremental',
      previousState: previousState(), headSha: SHA_B, fullFiles, auditChars: 0,
    });

    expect(scope.actualMode).toBe('full');
    expect(scope.reason).toContain('diverged');
  });
});

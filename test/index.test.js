const {
  splitIntoChunks,
  buildChunkPrompt,
  buildCombinedReview,
  buildChunkFailureWarning,
  extractActionableSuggestions,
  formatApiRequestLabel,
  formatChunkMergeSummary,
  formatSecurityFindingsForReview,
  matchesPattern,
  filterFiles,
  limitFilesByDiffChars,
  buildCoverageWarning,
  buildCommentBody,
  isRetryableError,
  hashString,
  RETRY_CONFIG,
} = require('../src/index');

const ConversationalFeedback = require('../src/review/ConversationalFeedback');

describe('splitIntoChunks', () => {
  test('returns empty array for files without patches', () => {
    const files = [{ filename: 'a.txt' }, { filename: 'b.txt' }];
    expect(splitIntoChunks(files)).toEqual([]);
  });

  test('returns single chunk for small files', () => {
    const files = [{ filename: 'a.txt', patch: 'small diff', status: 'modified' }];
    const chunks = splitIntoChunks(files);
    expect(chunks.length).toBe(1);
    expect(chunks[0].length).toBe(1);
  });

  test('splits when adding file would exceed chunk size', () => {
    const smallPatch = 'x'.repeat(40000);
    const largePatch = 'x'.repeat(40000);
    const files = [
      { filename: 'small1.txt', patch: smallPatch, status: 'modified' },
      { filename: 'small2.txt', patch: largePatch, status: 'modified' },
    ];
    const chunks = splitIntoChunks(files);
    expect(chunks.length).toBe(2);
    expect(chunks[0].length).toBe(1);
    expect(chunks[1].length).toBe(1);
  });

  test('handles mixed file sizes', () => {
    const files = [
      { filename: 'small.txt', patch: 'diff', status: 'modified' },
      { filename: 'large.txt', patch: 'x'.repeat(60000), status: 'modified' },
    ];
    const chunks = splitIntoChunks(files);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
  });
});

describe('review scope controls', () => {
  test('supports basename, nested glob, and single-character patterns', () => {
    expect(matchesPattern('package-lock.json', '*.lock')).toBe(false);
    expect(matchesPattern('vendor/cache.lock', '*.lock')).toBe(true);
    expect(matchesPattern('dist/nested/index.js', 'dist/**')).toBe(true);
    expect(matchesPattern('src/a.js', 'src/?.js')).toBe(true);
    expect(matchesPattern('foo.js', '**/*.js')).toBe(true);
    expect(matchesPattern('dist/a.js', '**/dist/**')).toBe(true);
  });

  test('filters excluded files and enforces the total diff budget', () => {
    const files = [
      { filename: 'src/a.js', patch: '12345' },
      { filename: 'dist/a.js', patch: 'generated' },
      { filename: 'src/b.js', patch: '67890' },
    ];
    const filtered = filterFiles(files, ['dist/**']);
    const limited = limitFilesByDiffChars(filtered, 64);

    expect(filtered.map(file => file.filename)).toEqual(['src/a.js', 'src/b.js']);
    expect(limited.files.map(file => file.filename)).toEqual(['src/a.js']);
    expect(limited.skippedFiles).toEqual(['src/b.js']);
  });

  test('discloses incomplete review coverage', () => {
    const warning = buildCoverageWarning({
      excludedFiles: ['package-lock.json'],
      patchlessFiles: ['image.png'],
      skippedFiles: ['large.js'],
      truncatedFiles: ['huge.js'],
    });

    expect(warning).toContain('excluded by pattern');
    expect(warning).toContain('no patch returned by GitHub');
    expect(warning).toContain('over the diff budget');
    expect(warning).toContain('truncated to 50000 characters');
  });
});

describe('buildCommentBody', () => {
  test('keeps the marker and bounds oversized review comments', () => {
    const body = buildCommentBody('Reviewer', '<details>&'.repeat(7000));

    expect(body.length).toBeLessThanOrEqual(65000);
    expect(body).toContain('Review output was truncated');
    expect(body).toContain('<pre>');
    expect(body).toContain('</pre>');
    expect(body).toContain('&lt;details&gt;&amp;');
    expect(body.endsWith('<!-- zai-code-review -->')).toBe(true);
  });

  test('bounds an untrusted reviewer name', () => {
    const body = buildCommentBody('x'.repeat(70000), 'review');

    expect(body.length).toBeLessThanOrEqual(65000);
    expect(body).toContain('review');
  });
});

describe('buildChunkPrompt', () => {
  test('builds prompt for single file', () => {
    const files = [{ filename: 'test.js', patch: 'const x = 1;', status: 'modified' }];
    const prompt = buildChunkPrompt(files, 0, 1);
    expect(prompt).toContain('### test.js (modified)');
    expect(prompt).toContain('```diff');
    expect(prompt).toContain('const x = 1;');
  });

  test('includes chunk indicator for multi-chunk reviews', () => {
    const files = [{ filename: 'test.js', patch: 'diff', status: 'modified' }];
    const prompt = buildChunkPrompt(files, 0, 3);
    expect(prompt).toContain('part 1 of 3');
  });

  test('excludes files without patches', () => {
    const files = [
      { filename: 'a.txt', patch: 'diff', status: 'modified' },
      { filename: 'b.txt', status: 'deleted' },
    ];
    const prompt = buildChunkPrompt(files, 0, 1);
    expect(prompt).toContain('a.txt');
    expect(prompt).not.toContain('b.txt');
  });
});

describe('RETRY_CONFIG', () => {
  test('has sensible retry values', () => {
    expect(RETRY_CONFIG.maxRetries).toBeGreaterThan(0);
    expect(RETRY_CONFIG.baseDelayMs).toBeGreaterThan(0);
    expect(RETRY_CONFIG.maxDelayMs).toBeGreaterThanOrEqual(RETRY_CONFIG.baseDelayMs);
  });
});

describe('hashString', () => {
  test('produces consistent hash for same input', () => {
    const input = 'use const:const value = 1;';
    const hash1 = hashString(input);
    const hash2 = hashString(input);
    expect(hash1).toBe(hash2);
  });

  test('produces different hashes for different inputs', () => {
    const hash1 = hashString('use const:const value = 1;');
    const hash2 = hashString('use let:let value = 1;');
    expect(hash1).not.toBe(hash2);
  });

  test('handles empty string', () => {
    const hash = hashString('');
    expect(hash).toBeDefined();
    expect(typeof hash).toBe('string');
  });

  test('handles special characters', () => {
    const hash1 = hashString('const x = "hello";');
    const hash2 = hashString('const x = "hello";');
    expect(hash1).toBe(hash2);
  });

  test('is case-sensitive by default', () => {
    const hash1 = hashString('UPPERCASE');
    const hash2 = hashString('uppercase');
    expect(hash1).not.toBe(hash2);
  });
});

describe('extractActionableSuggestions', () => {
  test('extracts valid unique suggestion markers from raw reviews', () => {
    const reviews = [
      {
        rawReview: '[[suggestion:path:src/index.js:line:10:Use const:const value = 1;]]\n[[suggestion:path:src/index.js:line:10:Use const:const value = 1;]]',
      },
    ];

    expect(extractActionableSuggestions(reviews)).toEqual([
      {
        id: 'src/index.js:10:Use const',
        path: 'src/index.js',
        line: 10,
        side: 'RIGHT',
        body: 'Use const',
        suggestion: 'const value = 1;',
      },
    ]);
  });

  test('ignores malformed suggestions and invalid lines', () => {
    const reviews = [
      {
        rawReview: [
          '[[suggestion:path:src/index.js:line:not-a-number:Bad:const value = 1;]]',
          '[[suggestion:path::line:12:Missing path:const value = 2;]]',
          '[[suggestion:path:src/index.js:line:0:Bad line:const value = 3;]]',
        ].join('\n'),
      },
    ];

    expect(extractActionableSuggestions(reviews)).toEqual([]);
  });

  test('deduplicates by file:line:body combination', () => {
    const reviews = [
      {
        rawReview: '[[suggestion:path:src/file.js:line:5:Add semicolon:value;]]\n[[suggestion:path:src/file.js:line:5:Add semicolon:value;]]',
      },
    ];

    const suggestions = extractActionableSuggestions(reviews);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toEqual({
      id: 'src/file.js:5:Add semicolon',
      path: 'src/file.js',
      line: 5,
      side: 'RIGHT',
      body: 'Add semicolon',
      suggestion: 'value;',
    });
  });

  test('deduplicates across multiple review chunks', () => {
    const reviews = [
      {
        rawReview: '[[suggestion:path:src/file.js:line:5:Use const:const x = 1;]]',
      },
      {
        rawReview: '[[suggestion:path:src/file.js:line:5:Use const:const x = 1;]]',
      },
    ];

    const suggestions = extractActionableSuggestions(reviews);
    expect(suggestions).toHaveLength(1);
  });

  test('keeps the same fix at distinct locations', () => {
    const reviews = [
      {
        rawReview: '[[suggestion:path:src/file.js:line:5:Remove var:const x = 1;]]\n[[suggestion:path:src/file.js:line:10:Remove var:const x = 1;]]',
      },
    ];

    const suggestions = extractActionableSuggestions(reviews);
    expect(suggestions).toHaveLength(2);
    expect(suggestions[0].line).toBe(5);
  });

  test('keeps case variants at distinct locations', () => {
    const reviews = [
      {
        rawReview: '[[suggestion:path:src/file.js:line:5:Fix:Use CONST;]]\n[[suggestion:path:src/file.js:line:10:Fix:use const;]]',
      },
    ];

    const suggestions = extractActionableSuggestions(reviews);
    expect(suggestions).toHaveLength(2);
  });

  test('keeps suggestions with different body text on same file/line', () => {
    const reviews = [
      {
        rawReview: '[[suggestion:path:src/file.js:line:5:Add semicolon:value;]]\n[[suggestion:path:src/file.js:line:5:Remove spaces:value;]]',
      },
    ];

    const suggestions = extractActionableSuggestions(reviews);
    expect(suggestions).toHaveLength(2);
    expect(suggestions[0].body).toBe('Add semicolon');
    expect(suggestions[1].body).toBe('Remove spaces');
  });

  test('keeps the same content in different files', () => {
    const reviews = [
      {
        rawReview: '[[suggestion:path:src/a.js:line:5:Use const:const x = 1;]]\n[[suggestion:path:src/b.js:line:5:Use const:const x = 1;]]',
      },
    ];

    const suggestions = extractActionableSuggestions(reviews);
    expect(suggestions).toHaveLength(2);
    expect(suggestions[0].path).toBe('src/a.js');
  });

  test('handles suggestions with colons in suggestion part', () => {
    const reviews = [
      {
        rawReview: '[[suggestion:path:src/file.js:line:5:Add comment:// TODO: fix this later]]',
      },
    ];

    const suggestions = extractActionableSuggestions(reviews);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].suggestion).toBe('// TODO: fix this later');
  });

  test('handles mixed valid and invalid suggestions', () => {
    const reviews = [
      {
        rawReview: [
          '[[suggestion:path:src/valid.js:line:5:Fix:const x = 1;]]',
          '[[suggestion:invalid-format]]',
          '[[suggestion:path:src/valid.js:line:10:Improve:let y = 2;]]',
        ].join('\n'),
      },
    ];

    const suggestions = extractActionableSuggestions(reviews);
    expect(suggestions).toHaveLength(2);
  });

  test('deduplicates across mix of valid and invalid chunks', () => {
    const reviews = [
      {
        rawReview: '[[suggestion:path:src/file.js:line:5:Fix:use const;]]',
      },
      {
        rawReview: '[[invalid-suggestion]]',
      },
      {
        rawReview: '[[suggestion:path:src/file.js:line:10:Fix:use const;]]',
      },
    ];

    const suggestions = extractActionableSuggestions(reviews);
    expect(suggestions).toHaveLength(2);
  });
});

describe('formatSecurityFindingsForReview', () => {
  test('formats static security findings as severity-tagged review entries', () => {
    const securityReview = formatSecurityFindingsForReview([
      {
        path: 'src/auth.js',
        line: 14,
        severity: 'high',
        message: 'Possible hardcoded secret or API key.',
      },
      {
        path: 'src/auth.js',
        line: 21,
        severity: 'medium',
        message: 'Lint or security checks disabled in code.',
      },
    ]);

    expect(securityReview).toContain('## [CRITICAL] src/auth.js:14 - Possible hardcoded secret or API key.');
    expect(securityReview).toContain('## [MAJOR] src/auth.js:21 - Lint or security checks disabled in code.');

    const formatted = ConversationalFeedback.formatReview(securityReview);
    expect(formatted).toContain('🔴 Critical/BLOCKER findings (1)');
    expect(formatted).toContain('🟠 Major comments (1)');
  });
});

describe('buildChunkFailureWarning', () => {
  test('returns empty string when no chunks failed', () => {
    expect(buildChunkFailureWarning([], 3)).toBe('');
  });

  test('builds a visible warning banner for partial chunk failures', () => {
    const warning = buildChunkFailureWarning([
      { index: 1, error: 'Z.ai API: Request timed out.' },
      { index: 3, error: 'read ECONNRESET' },
    ], 5);

    expect(warning).toContain('> [!CAUTION]');
    expect(warning).toContain('Review incomplete');
    expect(warning).toContain('2 of 5 chunk(s) failed');
    expect(warning).toContain('Chunks 2, 4');
  });
});

describe('buildCombinedReview', () => {
  test('surfaces partial chunk failures in the final review body', () => {
    const combinedReview = buildCombinedReview([
      {
        index: 0,
        rawReview: '## [CRITICAL] src/a.js:10 - First issue\n**Problem:** Broken behavior',
        summaryReview: '## [CRITICAL] src/a.js:10 - First issue\n**Problem:** Broken behavior',
        success: true,
      },
      {
        index: 1,
        rawReview: '',
        summaryReview: '',
        review: '**Error reviewing this chunk:** read ECONNRESET',
        success: false,
      },
    ], 2, 0);

    expect(combinedReview).toContain('Review incomplete');
    expect(combinedReview).toContain('1 of 2 chunk(s) failed');
    expect(combinedReview).toContain('**src/a.js:10 - First issue**');
    expect(combinedReview).toContain('🔴 Critical/BLOCKER findings (1)');
  });

  test('omits warning banner when all chunks succeed', () => {
    const combinedReview = buildCombinedReview([
      {
        index: 0,
        rawReview: '## [MINOR] src/a.js:10 - Small issue\n**Problem:** Minor bug',
        summaryReview: '## [MINOR] src/a.js:10 - Small issue\n**Problem:** Minor bug',
        success: true,
      },
    ], 1, 0);

    expect(combinedReview).not.toContain('Review incomplete');
    expect(combinedReview).toContain('🟡 Minor comments (1)');
  });

  test('skips empty successful chunk text when combining reviews', () => {
    const combinedReview = buildCombinedReview([
      {
        index: 0,
        rawReview: '',
        summaryReview: '',
        success: true,
      },
      {
        index: 1,
        rawReview: '## [MINOR] src/b.js:20 - Follow-up issue\n**Problem:** Still valid',
        summaryReview: '## [MINOR] src/b.js:20 - Follow-up issue\n**Problem:** Still valid',
        success: true,
      },
    ], 2, 0);

    expect(combinedReview).toContain('**src/b.js:20 - Follow-up issue**');
    expect(combinedReview).not.toMatch(/\n{4,}/);
  });
});

describe('formatChunkMergeSummary', () => {
  test('reports successful and failed chunk counts explicitly', () => {
    expect(formatChunkMergeSummary(16, 19)).toBe(
      'Combined 16 successful review chunk(s) into single comment. 3 chunk(s) failed.'
    );
  });
});

describe('formatApiRequestLabel', () => {
  test('includes chunk position, file count, patch size, oversized count, and prompt size', () => {
    const label = formatApiRequestLabel({
      chunkIndex: 1,
      totalChunks: 4,
      fileCount: 3,
      truncatedFileCount: 1,
      patchChars: 8192,
      promptChars: 2048,
    });

    expect(label).toBe('chunk 2/4, 3 file(s), 1 truncated file(s), 8192 patch chars, 2048 prompt chars');
  });

  test('omits oversized count when no oversized files are present', () => {
    const label = formatApiRequestLabel({
      chunkIndex: 0,
      totalChunks: 2,
      fileCount: 5,
      truncatedFileCount: 0,
      patchChars: 4096,
      promptChars: 1024,
    });

    expect(label).toBe('chunk 1/2, 5 file(s), 4096 patch chars, 1024 prompt chars');
    expect(label).not.toContain('truncated');
  });
});

describe('splitIntoChunks edge cases', () => {
  test('truncates files exceeding MAX_CHUNK_SIZE', () => {
    const oversizedPatch = 'x'.repeat(60000);
    const files = [
      { filename: 'huge.js', patch: oversizedPatch, status: 'modified' },
    ];
    const chunks = splitIntoChunks(files);
    expect(chunks.length).toBe(1);
    expect(chunks[0].length).toBe(1);
    expect(chunks[0][0].filename).toBe('huge.js');
    expect(chunks[0][0].truncated).toBe(true);
    expect(chunks[0][0].patch).toHaveLength(50000);
    expect(chunks[0][0].originalPatchLength).toBe(60000);
  });

  test('splits oversized file from normal files into separate chunks', () => {
    const files = [
      { filename: 'small.js', patch: 'small', status: 'modified' },
      { filename: 'huge.js', patch: 'x'.repeat(60000), status: 'modified' },
      { filename: 'small2.js', patch: 'small2', status: 'modified' },
    ];
    const chunks = splitIntoChunks(files);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    const hugeChunk = chunks.find(c => c.some(f => f.filename === 'huge.js'));
    expect(hugeChunk).toBeDefined();
    expect(hugeChunk.find(f => f.filename === 'huge.js').truncated).toBe(true);
  });
});

describe('retry classification', () => {
  test.each([408, 429, 500, 529])('retries transient HTTP %s responses', statusCode => {
    expect(isRetryableError({ statusCode })).toBe(true);
  });

  test.each([400, 401, 403, 422])('does not retry permanent HTTP %s responses', statusCode => {
    expect(isRetryableError({ statusCode })).toBe(false);
  });
});

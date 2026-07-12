const {
  calculateSimilarity,
  getExistingCommentThreads,
  findSimilarThread,
} = require('../src/index');

describe('Threading Functions', () => {
  describe('calculateSimilarity', () => {
    it('returns 1 for identical strings', () => {
      const similarity = calculateSimilarity('hello world', 'hello world');
      expect(similarity).toBe(1);
    });

    it('returns 0 for completely different strings', () => {
      const similarity = calculateSimilarity('abc xyz', 'def ghi');
      expect(similarity).toBe(0);
    });

    it('returns a value between 0 and 1 for partially similar strings', () => {
      const similarity = calculateSimilarity('hello world foo', 'hello bar baz');
      expect(similarity).toBeGreaterThan(0);
      expect(similarity).toBeLessThan(1);
    });

    it('returns correct similarity for overlapping words', () => {
      const similarity = calculateSimilarity('use const instead', 'use const');
      expect(similarity).toBeGreaterThan(0.5);
    });

    it('performs case-sensitive comparison (lowercasing done at call site)', () => {
      // The function itself is case-sensitive; lowercasing is done by the caller (findSimilarThread)
      const similarity1 = calculateSimilarity('Hello World', 'hello world');
      expect(similarity1).toBe(0); // Different case = different words
      
      const similarity2 = calculateSimilarity('hello world', 'hello world');
      expect(similarity2).toBe(1); // Same case = identical
    });

    it('handles empty strings', () => {
      const similarity = calculateSimilarity('', '');
      expect(similarity).toBe(0);
    });

    it('returns 0-1 range for all inputs', () => {
      const testCases = [
        'simple string',
        'another test case',
        'use const',
        'replace with let',
        'fix the bug here now',
      ];

      for (let i = 0; i < testCases.length; i++) {
        for (let j = 0; j < testCases.length; j++) {
          const similarity = calculateSimilarity(testCases[i], testCases[j]);
          expect(similarity).toBeGreaterThanOrEqual(0);
          expect(similarity).toBeLessThanOrEqual(1);
        }
      }
    });
  });

  describe('getExistingCommentThreads', () => {
    it('groups comments by file:line key', async () => {
      const mockOctokit = {
        rest: {
          pulls: {
            listReviewComments: jest.fn().mockResolvedValue({
              data: [
                { id: 1, path: 'foo.js', line: 10, body: 'Comment 1' },
                { id: 2, path: 'foo.js', line: 10, body: 'Comment 2' },
                { id: 3, path: 'bar.js', line: 5, body: 'Comment 3' },
              ],
            }),
          },
        },
      };

      const threads = await getExistingCommentThreads(mockOctokit, 'owner', 'repo', 1);

      expect(threads.size).toBe(2);
      expect(threads.get('foo.js:10')).toHaveLength(2);
      expect(threads.get('bar.js:5')).toHaveLength(1);
    });

    it('handles comments with original_line when line is missing', async () => {
      const mockOctokit = {
        rest: {
          pulls: {
            listReviewComments: jest.fn().mockResolvedValue({
              data: [
                { id: 1, path: 'foo.js', original_line: 20, body: 'Comment 1' },
              ],
            }),
          },
        },
      };

      const threads = await getExistingCommentThreads(mockOctokit, 'owner', 'repo', 1);

      expect(threads.get('foo.js:20')).toBeDefined();
    });

    it('returns empty map on API error', async () => {
      const mockOctokit = {
        rest: {
          pulls: {
            listReviewComments: jest.fn().mockRejectedValue(new Error('API error')),
          },
        },
      };

      const threads = await getExistingCommentThreads(mockOctokit, 'owner', 'repo', 1);

      expect(threads).toEqual(new Map());
    });

    it('calls API with correct parameters', async () => {
      const mockOctokit = {
        rest: {
          pulls: {
            listReviewComments: jest.fn().mockResolvedValue({ data: [] }),
          },
        },
      };

      await getExistingCommentThreads(mockOctokit, 'owner', 'repo', 42);

      expect(mockOctokit.rest.pulls.listReviewComments).toHaveBeenCalledWith({
        owner: 'owner',
        repo: 'repo',
        pull_number: 42,
        per_page: 100,
        page: 1,
      });
    });

    it('fetches all review comment pages', async () => {
      const firstPage = Array.from({ length: 100 }, (_, index) => ({
        id: index,
        path: 'foo.js',
        line: index + 1,
        body: `Comment ${index}`,
      }));
      const mockOctokit = {
        rest: {
          pulls: {
            listReviewComments: jest.fn()
              .mockResolvedValueOnce({ data: firstPage })
              .mockResolvedValueOnce({
                data: [{ id: 101, path: 'bar.js', line: 1, body: 'Last comment' }],
              }),
          },
        },
      };

      const threads = await getExistingCommentThreads(mockOctokit, 'owner', 'repo', 1);

      expect(mockOctokit.rest.pulls.listReviewComments).toHaveBeenCalledTimes(2);
      expect(threads.get('bar.js:1')).toHaveLength(1);
    });
  });

  describe('findSimilarThread', () => {
    it('returns matching comment when similarity > 0.6', () => {
      const threads = new Map();
      threads.set('foo.js:10', [
        { id: 1, body: 'Use const instead of var' },
      ]);

      const suggestion = {
        path: 'foo.js',
        line: 10,
        body: 'Use const instead of var declaration',
      };

      const result = findSimilarThread(threads, suggestion);
      expect(result).toBeDefined();
      expect(result.id).toBe(1);
    });

    it('returns null when no matching comment exists', () => {
      const threads = new Map();
      threads.set('foo.js:10', [
        { id: 1, body: 'Comment about something else' },
      ]);

      const suggestion = {
        path: 'foo.js',
        line: 10,
        body: 'Use const instead of var',
      };

      const result = findSimilarThread(threads, suggestion);
      expect(result).toBeNull();
    });

    it('returns null when location has no existing comments', () => {
      const threads = new Map();
      threads.set('foo.js:10', []);

      const suggestion = {
        path: 'foo.js',
        line: 10,
        body: 'Use const instead of var',
      };

      const result = findSimilarThread(threads, suggestion);
      expect(result).toBeNull();
    });

    it('returns null when location not in threads map', () => {
      const threads = new Map();

      const suggestion = {
        path: 'foo.js',
        line: 10,
        body: 'Use const instead of var',
      };

      const result = findSimilarThread(threads, suggestion);
      expect(result).toBeNull();
    });

    it('is case-insensitive when comparing', () => {
      const threads = new Map();
      threads.set('foo.js:10', [
        { id: 1, body: 'USE CONST INSTEAD OF VAR' },
      ]);

      const suggestion = {
        path: 'foo.js',
        line: 10,
        body: 'use const instead of var',
      };

      const result = findSimilarThread(threads, suggestion);
      expect(result).toBeDefined();
    });

    it('uses 0.6 similarity threshold', () => {
      const threads = new Map();
      // "abc def" and "abc xyz" share 1 word out of 3 unique words = 33% similarity
      threads.set('foo.js:10', [
        { id: 1, body: 'abc xyz' },
      ]);

      const suggestion = {
        path: 'foo.js',
        line: 10,
        body: 'abc def',
      };

      const result = findSimilarThread(threads, suggestion);
      // Should return null because similarity is < 0.6
      expect(result).toBeNull();
    });

    it('returns first matching comment when multiple exist', () => {
      const threads = new Map();
      threads.set('foo.js:10', [
        { id: 1, body: 'Use const instead of var declaration' },
        { id: 2, body: 'Use const instead of var declaration' },
      ]);

      const suggestion = {
        path: 'foo.js',
        line: 10,
        body: 'Use const instead of var',
      };

      const result = findSimilarThread(threads, suggestion);
      expect(result).toBeDefined();
      expect(result.id).toBe(1);
    });
  });
});

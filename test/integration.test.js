const fs = require('fs');
const path = require('path');
const {
  loadCustomPatterns,
  parseYamlSecurityPatterns,
  categorizeSeverity,
} = require('../src/review/SecurityCheck');

const {
  calculateSimilarity,
  getExistingCommentThreads,
  findSimilarThread,
  extractActionableSuggestions,
  filterResolvedSuggestions,
} = require('../src/index');

describe('Integration Tests', () => {
  describe('Custom Security Patterns End-to-End', () => {
    const tempDir = path.join(__dirname, 'temp');
    const configPath = path.join(tempDir, '.zai-review.yaml');

    beforeAll(() => {
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }
    });

    afterAll(() => {
      if (fs.existsSync(configPath)) {
        fs.unlinkSync(configPath);
      }
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    test('loads custom patterns from config file', () => {
      const configContent = `
security_patterns:
  - pattern: 'console\\.log\\s*\\('
    message: 'Debug logging detected'
    severity: low
  - pattern: '\\bmd5\\s*\\('
    message: 'Weak crypto detected'
    severity: high
`.trim();

      fs.writeFileSync(configPath, configContent);
      const patterns = loadCustomPatterns(tempDir);

      expect(patterns).toHaveLength(2);
      expect(patterns[0].pattern).toBe('console\\.log\\s*\\(');
      expect(patterns[0].message).toBe('Debug logging detected');
      expect(patterns[0].severity).toBe('low');
      expect(patterns[1].severity).toBe('high');
    });

    test('returns empty array when config file does not exist', () => {
      const patterns = loadCustomPatterns('/nonexistent/path');
      expect(patterns).toEqual([]);
    });

    test('handles invalid YAML gracefully', () => {
      const invalidConfig = 'this is not valid yaml: : :';
      fs.writeFileSync(configPath, invalidConfig);
      const patterns = loadCustomPatterns(tempDir);
      // Should not throw, returns empty array
      expect(Array.isArray(patterns)).toBe(true);
    });

    test('categorizeSeverity maps various inputs correctly', () => {
      expect(categorizeSeverity('critical')).toBe('high');
      expect(categorizeSeverity('BLOCKER')).toBe('high');
      expect(categorizeSeverity('high')).toBe('high');
      expect(categorizeSeverity('ERROR')).toBe('high');
      
      expect(categorizeSeverity('major')).toBe('medium');
      expect(categorizeSeverity('WARNING')).toBe('medium');
      expect(categorizeSeverity('warn')).toBe('medium');
      
      expect(categorizeSeverity('minor')).toBe('low');
      expect(categorizeSeverity('INFO')).toBe('low');
      expect(categorizeSeverity('information')).toBe('low');
      
      expect(categorizeSeverity('unknown')).toBe('medium');
      expect(categorizeSeverity('')).toBe('medium');
      expect(categorizeSeverity(null)).toBe('medium');
    });

    test('parseYamlSecurityPatterns handles complex YAML', () => {
      const yamlContent = `
# Some comment
other_config: value

security_patterns:
  - pattern: 'pattern1'
    message: 'Message 1'
    severity: critical
  - pattern: 'pattern2'
    message: 'Message 2'
    severity: warning
  - pattern: 'pattern3'
    message: 'Message 3'
    severity: info

another_section: value
`.trim();

      const patterns = parseYamlSecurityPatterns(yamlContent);
      expect(patterns).toHaveLength(3);
      expect(patterns[0].severity).toBe('high'); // critical -> high
      expect(patterns[1].severity).toBe('medium'); // warning -> medium
      expect(patterns[2].severity).toBe('low'); // info -> low
    });
  });

  describe('Threading Integration', () => {
    test('calculateSimilarity works with real-world comment pairs', () => {
      // Very similar comments
      const sim1 = calculateSimilarity(
        'Use const instead of let for immutable variables',
        'Use const instead of let for variables that do not change'
      );
      expect(sim1).toBeGreaterThan(0.5);

      // Moderately similar
      const sim2 = calculateSimilarity(
        'Add error handling for this function',
        'Add try-catch block for error handling'
      );
      expect(sim2).toBeGreaterThan(0.3);

      // Different comments
      const sim3 = calculateSimilarity(
        'Use const instead of let',
        'This function needs better naming'
      );
      expect(sim3).toBeLessThan(0.5);
    });

    test('findSimilarThread integrates with calculateSimilarity', () => {
      const threads = new Map();
      threads.set('src/file.js:10', [
        { id: 1, body: 'Use const instead of let for immutable variables' },
        { id: 2, body: 'Add error handling here' },
      ]);

      // Should find similar thread
      const suggestion1 = {
        path: 'src/file.js',
        line: 10,
        body: 'Use const instead of let for variables that do not change',
      };
      const result1 = findSimilarThread(threads, suggestion1, 0.5);
      expect(result1).toBeDefined();
      expect(result1.id).toBe(1);

      // Should not find similar thread with high threshold
      const suggestion2 = {
        path: 'src/file.js',
        line: 10,
        body: 'Add try-catch for errors',
      };
      const result2 = findSimilarThread(threads, suggestion2, 0.8);
      expect(result2).toBeNull();

      // Should find with lower threshold - use body that shares more words with existing comment
      const suggestion3 = {
        path: 'src/file.js',
        line: 10,
        body: 'Add error handling here please',
      };
      const result3 = findSimilarThread(threads, suggestion3, 0.5);
      expect(result3).toBeDefined();
      expect(result3.id).toBe(2);
    });

    test('getExistingCommentThreads handles real API response structure', async () => {
      const mockOctokit = {
        rest: {
          pulls: {
            listReviewComments: jest.fn().mockResolvedValue({
              data: [
                {
                  id: 100,
                  path: 'src/index.js',
                  line: 25,
                  body: 'Consider using async/await here',
                  state: 'PENDING',
                },
                {
                  id: 101,
                  path: 'src/index.js',
                  line: 25,
                  body: 'Also add error handling',
                  state: 'RESOLVED',
                },
                {
                  id: 102,
                  path: 'src/utils.js',
                  original_line: 10,
                  body: 'This function is unused',
                  state: 'PENDING',
                },
              ],
            }),
          },
        },
      };

      const threads = await getExistingCommentThreads(mockOctokit, 'owner', 'repo', 42);

      expect(threads.size).toBe(2);
      expect(threads.get('src/index.js:25')).toHaveLength(2);
      expect(threads.get('src/utils.js:10')).toHaveLength(1);
    });
  });

  describe('Suggestion Deduplication Integration', () => {
    test('extractActionableSuggestions deduplicates across multiple chunks', () => {
      const reviews = [
        {
          rawReview: `
## [CRITICAL] src/auth.js:10 - Hardcoded secret
**Problem:** API key is hardcoded
[[suggestion:path:src/auth.js:line:10:Use env var:const key = process.env.API_KEY;]]
          `.trim(),
        },
        {
          rawReview: `
## [MAJOR] src/auth.js:10 - Security issue
**Problem:** Same issue in different chunk
[[suggestion:path:src/auth.js:line:10:Use env var:const key = process.env.API_KEY;]]
          `.trim(),
        },
      ];

      const suggestions = extractActionableSuggestions(reviews);
      expect(suggestions).toHaveLength(1);
      expect(suggestions[0].id).toBe('src/auth.js:10:Use env var');
    });

    test('handles mix of valid and invalid suggestions', () => {
      const reviews = [
        {
          rawReview: `
Valid suggestion:
[[suggestion:path:src/file.js:line:5:Fix:const x = 1;]]

Invalid suggestions:
[[suggestion:missing-fields]]
[[suggestion:path:src/file.js:line:abc:Fix:const x = 1;]]
[[suggestion:path:src/file.js:line:0:Fix:const x = 1;]]
          `.trim(),
        },
      ];

      const suggestions = extractActionableSuggestions(reviews);
      expect(suggestions).toHaveLength(1);
      expect(suggestions[0].path).toBe('src/file.js');
      expect(suggestions[0].line).toBe(5);
    });

    test('preserves suggestions with different bodies on same line', () => {
      const reviews = [
        {
          rawReview: `
[[suggestion:path:src/file.js:line:10:Add semicolon:const x = 1;]]
[[suggestion:path:src/file.js:line:10:Use single quotes:const x = 'value';]]
          `.trim(),
        },
      ];

      const suggestions = extractActionableSuggestions(reviews);
      expect(suggestions).toHaveLength(2);
      expect(suggestions[0].body).toBe('Add semicolon');
      expect(suggestions[1].body).toBe('Use single quotes');
    });
  });

  describe('Resolved Comment Filtering Integration', () => {
    test('uses GraphQL review thread resolution state', async () => {
      const mockOctokit = {
        graphql: jest.fn().mockResolvedValue({
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: [
                  {
                    isResolved: true,
                    comments: {
                      nodes: [{
                        path: 'src/file.js',
                        line: 10,
                        originalLine: 10,
                        body: 'Resolved',
                      }],
                    },
                  },
                  {
                    isResolved: false,
                    comments: {
                      nodes: [{
                        path: 'src/file.js',
                        line: 20,
                        originalLine: 20,
                        body: 'Open',
                      }],
                    },
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        }),
      };
      const suggestions = [
        { path: 'src/file.js', line: 10, body: 'Resolved' },
        { path: 'src/file.js', line: 20, body: 'Open' },
      ];

      const filtered = await filterResolvedSuggestions(
        mockOctokit, 'owner', 'repo', 42, suggestions
      );

      expect(filtered).toEqual([{ path: 'src/file.js', line: 20, body: 'Open' }]);
    });

    test('keeps a distinct suggestion at a previously resolved location', async () => {
      const mockOctokit = {
        graphql: jest.fn().mockResolvedValue({
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: [{
                  isResolved: true,
                  comments: {
                    nodes: [{
                      path: 'src/file.js',
                      line: 10,
                      originalLine: 10,
                      body: 'Use a constant for this value',
                    }],
                  },
                }],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        }),
      };
      const suggestion = { path: 'src/file.js', line: 10, body: 'Validate user input' };

      const filtered = await filterResolvedSuggestions(
        mockOctokit, 'owner', 'repo', 42, [suggestion]
      );

      expect(filtered).toEqual([suggestion]);
    });

    test('filterResolvedSuggestions excludes resolved comments', async () => {
      const mockOctokit = {
        rest: {
          pulls: {
            listReviewComments: jest.fn().mockResolvedValue({
              data: [
                {
                  path: 'src/file.js',
                  line: 10,
                  state: 'RESOLVED',
                  body: 'Fix this',
                },
                {
                  path: 'src/file.js',
                  line: 20,
                  state: 'PENDING',
                  body: 'Fix that',
                },
              ],
            }),
          },
        },
      };

      const suggestions = [
        { path: 'src/file.js', line: 10, body: 'Fix this' },
        { path: 'src/file.js', line: 20, body: 'Fix that' },
        { path: 'src/file.js', line: 30, body: 'Fix other' },
      ];

      const filtered = await filterResolvedSuggestions(
        mockOctokit,
        'owner',
        'repo',
        42,
        suggestions
      );

      expect(filtered).toHaveLength(2);
      expect(filtered[0].line).toBe(20);
      expect(filtered[1].line).toBe(30);
    });

    test('filterResolvedSuggestions handles API errors gracefully', async () => {
      const mockOctokit = {
        rest: {
          pulls: {
            listReviewComments: jest.fn().mockRejectedValue(new Error('API error')),
          },
        },
      };

      const suggestions = [
        { path: 'src/file.js', line: 10, body: 'Fix this' },
      ];

      const filtered = await filterResolvedSuggestions(
        mockOctokit,
        'owner',
        'repo',
        42,
        suggestions
      );

      // Should return all suggestions on error (fail-open)
      expect(filtered).toHaveLength(1);
    });
  });

  describe('SecurityCheck Integration with Custom Patterns', () => {
    const SecurityCheck = require('../src/review/SecurityCheck');

    test('checkSecurity combines built-in and custom patterns', () => {
      const customPatterns = [
        {
          pattern: 'console\\.log',
          message: 'Debug logging detected',
          severity: 'low',
        },
      ];

      const files = [
        {
          filename: 'src/file.js',
          patch: `@@ -1,3 +1,4 @@
+console.log('debug');
+eval('code');
`,
        },
      ];

      const findings = SecurityCheck.checkSecurity(files, customPatterns);

      // Should find both built-in (eval) and custom (console.log) patterns
      expect(findings.length).toBeGreaterThanOrEqual(2);
      
      const messages = findings.map(f => f.message);
      expect(messages).toContain('Debug logging detected');
      expect(messages.some(m => m.includes('eval'))).toBe(true);
    });

    test('checkSecurity handles invalid custom patterns gracefully', () => {
      const customPatterns = [
        {
          pattern: '[invalid(regex', // Invalid regex
          message: 'Should be skipped',
          severity: 'high',
        },
        {
          pattern: 'valid.pattern',
          message: 'Valid pattern',
          severity: 'medium',
        },
      ];

      const files = [
        {
          filename: 'src/file.js',
          patch: `@@ -1 +1,2 @@
+valid.pattern.here
+invalid(regex.here
`,
        },
      ];

      const findings = SecurityCheck.checkSecurity(files, customPatterns);
      
      // Should only find the valid pattern
      expect(findings).toHaveLength(1);
      expect(findings[0].message).toBe('Valid pattern');
    });

    test('checkSecurity works without custom patterns (backward compatibility)', () => {
      const files = [
        {
          filename: 'src/file.js',
          patch: `@@ -1 +1,2 @@
+eval('code');
+const apiKey = "secret1234567890123456";
`,
        },
      ];

      // Test with default (no custom patterns)
      const findings1 = SecurityCheck.checkSecurity(files);
      const findings2 = SecurityCheck.checkSecurity(files, []);

      // Both should find the same built-in patterns
      expect(findings1.length).toBeGreaterThan(0);
      expect(findings1.length).toBe(findings2.length);
    });
  });
});

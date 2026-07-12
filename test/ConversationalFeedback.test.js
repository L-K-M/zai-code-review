const ConversationalFeedback = require('../src/review/ConversationalFeedback');

describe('ConversationalFeedback', () => {
  describe('buildPrompt', () => {
    it('generates a prompt for a single file', () => {
      const files = [
        { filename: 'foo.js', patch: 'diff --git...', status: 'modified' }
      ];
      const prompt = ConversationalFeedback.buildPrompt(files, 0, 1);
      expect(prompt).toContain('### foo.js (modified)');
      expect(prompt).toContain('diff --git...');
      expect(prompt).toContain('developer-friendly feedback');
    });

    it('skips files without patches', () => {
      const files = [
        { filename: 'foo.js', status: 'modified' },
        { filename: 'bar.js', patch: 'diff', status: 'modified' }
      ];
      const prompt = ConversationalFeedback.buildPrompt(files, 0, 1);
      expect(prompt).toContain('bar.js');
      expect(prompt).not.toContain('foo.js');
    });

    it('includes chunk indicator for multi-chunk', () => {
      const files = [
        { filename: 'foo.js', patch: 'diff', status: 'modified' }
      ];
      const prompt = ConversationalFeedback.buildPrompt(files, 1, 3);
      expect(prompt).toContain('part 2 of 3');
    });

    it('asks for structured inline suggestion markers for actionable fixes', () => {
      const files = [
        { filename: 'foo.js', patch: '+let value = 1;', status: 'modified' }
      ];

      const prompt = ConversationalFeedback.buildPrompt(files, 0, 1);

      expect(prompt).toContain('[[suggestion:path:');
      expect(prompt).toContain('Only emit a suggestion marker');
    });

    it('includes format instructions for findings', () => {
      const files = [
        { filename: 'foo.js', patch: 'diff', status: 'modified' }
      ];
      const prompt = ConversationalFeedback.buildPrompt(files, 0, 1);
      expect(prompt).toContain('Format each finding as follows:');
      expect(prompt).toContain('[SEVERITY] File:Line - Brief Title');
      expect(prompt).toContain('**Problem:**');
      expect(prompt).toContain('**Impact:**');
      expect(prompt).toContain('Group findings by severity');
    });

    it('forbids conversational filler and standalone severity banners', () => {
      const files = [
        { filename: 'foo.js', patch: 'diff', status: 'modified' }
      ];

      const prompt = ConversationalFeedback.buildPrompt(files, 0, 1);

      expect(prompt).toContain('Do not include conversational introductions, praise, summaries, or sign-offs.');
      expect(prompt).toContain('Do not emit standalone severity banners such as "## CRITICAL" or "## Major".');
      expect(prompt).toContain('Do not mention chunk numbers, part numbers, or headings such as "Code Review: Part X/Y".');
      expect(prompt).toContain('If a finding cannot follow the required structure, omit it rather than writing free-form commentary.');
    });
  });

  describe('postProcess', () => {
    it('removes excessive apologies and generic phrases', () => {
      const feedback = 'I have reviewed the changes. Here are my feedback comments: This looks good.';
      const result = ConversationalFeedback.postProcess(feedback);
      expect(result).not.toContain('Here are my feedback');
      expect(result).toContain('This looks good.');
    });

    it('converts dashes to bullet points', () => {
      const feedback = '- First issue\n- Second issue';
      const result = ConversationalFeedback.postProcess(feedback);
      expect(result).toContain('• First issue');
      expect(result).toContain('• Second issue');
    });

    it('returns empty string for empty input', () => {
      expect(ConversationalFeedback.postProcess('')).toBe('');
      expect(ConversationalFeedback.postProcess(null)).toBe('');
    });
  });

  describe('parseFindings', () => {
    it('parses findings with severity headers', () => {
      const rawReview = `## [CRITICAL] Use const instead of let
**Problem:** Using let when const is appropriate
**Impact:** Reduces code clarity

## [MAJOR] Remove unused variable
**Problem:** Variable is declared but never used
**Impact:** Increases code complexity`;
      const findings = ConversationalFeedback.parseFindings(rawReview);
      expect(findings).toHaveLength(2);
      expect(findings[0].severity).toBe('critical');
      expect(findings[0].title).toBe('Use const instead of let');
      expect(findings[1].severity).toBe('major');
    });

    it('marks findings as outside diff when specified', () => {
      const rawReview = `## [CRITICAL] (outside diff) Security issue
**Problem:** Potential SQL injection`;
      const findings = ConversationalFeedback.parseFindings(rawReview);
      expect(findings).toHaveLength(1);
      expect(findings[0].isOutsideDiff).toBe(true);
      expect(findings[0].title).not.toContain('outside diff');
    });

    it('returns empty array for null or empty input', () => {
      expect(ConversationalFeedback.parseFindings(null)).toEqual([]);
      expect(ConversationalFeedback.parseFindings('')).toEqual([]);
      expect(ConversationalFeedback.parseFindings(undefined)).toEqual([]);
    });

    it('parses severity headers from combined chunk output with bullet-prefixed headings', () => {
      const rawReview = [
        '### Chunk 1/2',
        '',
        '• ## [CRITICAL] src/a.js:10 - First critical issue',
        '**Problem:** First problem',
        '',
        '---',
        '',
        '### Chunk 2/2',
        '',
        '• ## [MAJOR] src/b.js:20 - Second major issue',
        '**Problem:** Second problem',
      ].join('\n');

      const findings = ConversationalFeedback.parseFindings(rawReview);

      expect(findings).toHaveLength(2);
      expect(findings[0].severity).toBe('critical');
      expect(findings[0].title).toBe('First critical issue');
      expect(findings[1].severity).toBe('major');
      expect(findings[1].title).toBe('Second major issue');
    });

    it('does not leak chunk headers or separators into finding content', () => {
      const rawReview = [
        '### Chunk 1/3',
        '',
        '## [CRITICAL] src/a.js:10 - Null Reference Risk',
        '**Problem:** Missing null check',
        '**Impact:** Runtime crash',
        '**Suggested fix:**',
        '```diff',
        '- const best = entries[0];',
        '+ if (!best) return null;',
        '```',
        '',
        '---',
        '',
        '### Chunk 2/3',
        '',
        '## [MAJOR] src/b.js:20 - Unsafe Parsing',
        '**Problem:** Port not validated',
        '**Impact:** Invalid port accepted',
        '',
        '---',
        '',
        '### Chunk 3/3',
        '',
        '## [MINOR] src/c.js:5 - Typo in variable',
        '**Problem:** Variable name typo',
      ].join('\n');

      const findings = ConversationalFeedback.parseFindings(rawReview);

      expect(findings).toHaveLength(3);
      expect(findings[0].severity).toBe('critical');
      expect(findings[0].impact).not.toContain('Chunk 2');
      expect(findings[0].impact).not.toContain('---');
      expect(findings[0].fix).not.toContain('Chunk');
      expect(findings[1].severity).toBe('major');
      expect(findings[1].impact).not.toContain('Chunk 3');
      expect(findings[1].impact).not.toContain('---');
      expect(findings[2].severity).toBe('minor');
    });

    it('properly terminates findings at chunk boundaries with active sections', () => {
      const rawReview = [
        '## [CRITICAL] file.ts:10 - Security Issue',
        '**Problem:** XSS vulnerability',
        '**Impact:** Attackers can inject scripts',
        '**Prompt for AI Agents:**',
        '```',
        'Fix the XSS issue by sanitizing input.',
        '```',
        '',
        '### Chunk 2/5',
        '',
        '## [MAJOR] other.ts:30 - Config Error',
        '**Problem:** Wrong config key',
      ].join('\n');

      const findings = ConversationalFeedback.parseFindings(rawReview);

      expect(findings).toHaveLength(2);
      // The prompt section of the first finding should NOT contain chunk header
      expect(findings[0].prompt).not.toContain('Chunk 2');
      expect(findings[0].prompt).toContain('Fix the XSS issue');
      expect(findings[1].severity).toBe('major');
      expect(findings[1].problem).toBe('Wrong config key');
    });

    it('handles 20-chunk combined output without section corruption', () => {
      // Simulate what happens in production: 20 chunks each with findings
      const chunkReviews = [];
      for (let i = 1; i <= 20; i++) {
        const severity = i <= 5 ? 'CRITICAL' : (i <= 12 ? 'MAJOR' : 'MINOR');
        chunkReviews.push(
          `### Chunk ${i}/20`,
          '',
          `## [${severity}] file${i}.ts:${i * 10} - Issue ${i}`,
          `**Problem:** Problem in file ${i}`,
          `**Impact:** Impact of issue ${i}`,
          '',
          '---',
          '',
        );
      }
      const rawReview = chunkReviews.join('\n');

      const findings = ConversationalFeedback.parseFindings(rawReview);

      expect(findings).toHaveLength(20);
      // Verify no finding has chunk headers or separators in its content
      for (const finding of findings) {
        expect(finding.problem).not.toMatch(/Chunk \d+\/\d+/);
        expect(finding.impact).not.toMatch(/Chunk \d+\/\d+/);
        expect(finding.problem).not.toContain('---');
        expect(finding.impact).not.toContain('---');
      }
      // Verify severity counts
      const critical = findings.filter(f => f.severity === 'critical');
      const major = findings.filter(f => f.severity === 'major');
      const minor = findings.filter(f => f.severity === 'minor');
      expect(critical).toHaveLength(5);
      expect(major).toHaveLength(7);
      expect(minor).toHaveLength(8);
    });

    it('parses production-style combined syntax with plain severity banners', () => {
      const rawReview = [
        'Here is the review of the provided code.',
        '',
        '## BLOCKER',
        '',
        '### src/a2ui/renderer.ts:~1035 - Markdown XSS via javascript: Links',
        'Arbitrary JavaScript execution (XSS). This can lead to data exfiltration.',
        '**Suggested fix:**',
        'Use sanitizeUrl for href attributes.',
        '',
        '### Chunk 9/20',
        '',
        'Thanks for the opportunity to review this section of the codebase.',
        '',
        '## Minor',
        '',
        '### src/a2ui/webview.ts:268 - Redundant event listener causes double execution',
        'Remove the change event listener block to prevent duplicate reactivity calculations.',
      ].join('\n');

      const findings = ConversationalFeedback.parseFindings(rawReview);

      expect(findings).toHaveLength(2);
      expect(findings[0].severity).toBe('critical');
      expect(findings[0].title).toBe('Markdown XSS via javascript: Links');
      expect(findings[0].location).toBe('src/a2ui/renderer.ts:~1035');
      expect(findings[0].problem).toContain('Arbitrary JavaScript execution');
      expect(findings[0].problem).not.toContain('Thanks for the opportunity');
      expect(findings[1].severity).toBe('minor');
      expect(findings[1].title).toBe('Redundant event listener causes double execution');
      expect(findings[1].location).toBe('src/a2ui/webview.ts:268');
    });
  });

  describe('groupBySeverity', () => {
    it('groups findings by severity level', () => {
      const findings = [
        { severity: 'critical', title: 'Critical issue' },
        { severity: 'major', title: 'Major issue' },
        { severity: 'minor', title: 'Minor issue' },
        { severity: 'info', title: 'Info' },
        { severity: 'critical', title: 'Another critical' }
      ];
      const grouped = ConversationalFeedback.groupBySeverity(findings);
      expect(grouped.critical).toHaveLength(2);
      expect(grouped.major).toHaveLength(1);
      expect(grouped.minor).toHaveLength(1);
      expect(grouped.info).toHaveLength(1);
    });

    it('treats blocker as critical', () => {
      const findings = [
        { severity: 'blocker', title: 'Blocker issue' }
      ];
      const grouped = ConversationalFeedback.groupBySeverity(findings);
      expect(grouped.critical).toHaveLength(1);
    });
  });

  describe('formatFinding', () => {
    it('formats finding with all details', () => {
      const finding = {
        title: 'Use const instead of let',
        problem: 'Using let when const is appropriate',
        impact: 'Reduces code clarity',
        fix: '```diff\n- let x = 1\n+ const x = 1\n```',
        prompt: 'Verify const usage',
        isOutsideDiff: false
      };
      const formatted = ConversationalFeedback.formatFinding(finding);
      expect(formatted).toContain('**Use const instead of let**');
      expect(formatted).toContain('**Problem:** Using let');
      expect(formatted).toContain('**Impact:** Reduces code');
      expect(formatted).toContain('**Suggested fix:**');
      expect(formatted).toContain('**Prompt for AI Agents:**');
    });

    it('marks findings as outside diff', () => {
      const finding = {
        title: 'Security issue',
        problem: 'Potential vulnerability',
        impact: 'Data breach risk',
        fix: '',
        prompt: '',
        isOutsideDiff: true
      };
      const formatted = ConversationalFeedback.formatFinding(finding);
      expect(formatted).toContain('**(outside diff) Security issue**');
    });

    it('omits empty sections', () => {
      const finding = {
        title: 'Simple issue',
        problem: '',
        impact: '',
        fix: '',
        prompt: '',
        isOutsideDiff: false
      };
      const formatted = ConversationalFeedback.formatFinding(finding);
      expect(formatted).toBe('**Simple issue**');
    });
  });

  describe('formatReview', () => {
    it('returns header with actionable count', () => {
      const review = '';
      const formatted = ConversationalFeedback.formatReview(review, { actionableCount: 5 });
      expect(formatted).toContain('**Actionable suggestions identified: 5**');
    });

    it('includes NOTE box when actionableCount > 0', () => {
      const review = '';
      const formatted = ConversationalFeedback.formatReview(review, { actionableCount: 3 });
      expect(formatted).toContain('> [!NOTE]');
      expect(formatted).toContain('posted on a best-effort basis');
    });

    it('includes CAUTION box when hasCriticalOutsideDiff is true', () => {
      const review = '';
      const formatted = ConversationalFeedback.formatReview(review, { hasCriticalOutsideDiff: true });
      expect(formatted).toContain('> [!CAUTION]');
      expect(formatted).toContain('Some comments are outside the diff');
    });

    it('creates collapsible sections for each severity', () => {
      const rawReview = `## [CRITICAL] Critical issue
**Problem:** This is critical

## [MAJOR] Major issue
**Problem:** This is major

## [MINOR] Minor issue
**Problem:** This is minor`;
      const formatted = ConversationalFeedback.formatReview(rawReview, { actionableCount: 3 });
      expect(formatted).toContain('🔴 Critical/BLOCKER findings (1)');
      expect(formatted).toContain('🟠 Major comments (1)');
      expect(formatted).toContain('🟡 Minor comments (1)');
      expect(formatted).toContain('<details>');
      expect(formatted).toContain('</details>');
    });

    it('uses blockquote for sections', () => {
      const rawReview = `## [CRITICAL] Critical issue
**Problem:** This is critical`;
      const formatted = ConversationalFeedback.formatReview(rawReview);
      expect(formatted).toContain('<blockquote>');
      expect(formatted).toContain('</blockquote>');
    });

    it('omits sections with no findings', () => {
      const rawReview = `## [CRITICAL] Critical issue
**Problem:** This is critical`;
      const formatted = ConversationalFeedback.formatReview(rawReview);
      expect(formatted).toContain('🔴 Critical/BLOCKER');
      expect(formatted).not.toContain('🟠 Major');
      expect(formatted).not.toContain('🟡 Minor');
    });

    it('handles empty review gracefully', () => {
      const formatted = ConversationalFeedback.formatReview('', { actionableCount: 0 });
      expect(formatted).toContain('**Actionable suggestions identified: 0**');
    });

    it('combines all options correctly', () => {
      const rawReview = `## [CRITICAL] Critical issue
**Problem:** This is critical

## [CRITICAL] (outside diff) Outside issue
**Problem:** This is outside`;
      const formatted = ConversationalFeedback.formatReview(rawReview, {
        actionableCount: 5,
        hasCriticalOutsideDiff: true
      });
      expect(formatted).toContain('**Actionable suggestions identified: 5**');
      expect(formatted).toContain('> [!NOTE]');
      expect(formatted).toContain('> [!CAUTION]');
      expect(formatted).toContain('🔴 Critical/BLOCKER findings (2)');
    });

    it('does not duplicate outside-diff-only findings in severity sections', () => {
      const rawReview = `## [CRITICAL] (outside diff) Security issue
**Problem:** This is outside`;
      const separated = ConversationalFeedback.separateOutsideDiffComments(rawReview);

      const formatted = ConversationalFeedback.formatReview(rawReview, {
        hasCriticalOutsideDiff: true,
        outsideDiffComments: separated.outsideDiffComments,
      });

      expect(formatted).toContain('⚠️ Outside diff range comments (1)');
      expect(formatted).not.toContain('🔴 Critical/BLOCKER findings (1)');
    });

    it('correctly groups findings from multi-chunk combined input', () => {
      const rawReview = [
        '### Chunk 1/3',
        '',
        '## [CRITICAL] src/a.ts:10 - XSS Risk',
        '**Problem:** Unsanitized HTML',
        '**Impact:** Script injection',
        '',
        '---',
        '',
        '### Chunk 2/3',
        '',
        '## [CRITICAL] src/b.ts:20 - CSS Injection',
        '**Problem:** Style values not validated',
        '**Impact:** UI manipulation',
        '',
        '## [MAJOR] src/b.ts:50 - Missing Tests',
        '**Problem:** No test coverage',
        '',
        '---',
        '',
        '### Chunk 3/3',
        '',
        '## [MINOR] src/c.ts:5 - Typo',
        '**Problem:** Variable name typo',
      ].join('\n');

      const formatted = ConversationalFeedback.formatReview(rawReview, { actionableCount: 4 });

      // Verify correct counts in section headers
      expect(formatted).toContain('🔴 Critical/BLOCKER findings (2)');
      expect(formatted).toContain('🟠 Major comments (1)');
      expect(formatted).toContain('🟡 Minor comments (1)');
      // Verify no chunk headers leaked into the output
      expect(formatted).not.toContain('### Chunk');
      expect(formatted).not.toMatch(/Chunk \d+\/\d+/);
    });

    it('groups production-style combined syntax without leaking narrative filler', () => {
      const rawReview = [
        'Here is the review of the provided code.',
        '',
        '## BLOCKER',
        '',
        '### src/a2ui/renderer.ts:~1035 - Markdown XSS via javascript: Links',
        'Arbitrary JavaScript execution (XSS). This can lead to data exfiltration.',
        '**Suggested fix:**',
        'Use sanitizeUrl for href attributes.',
        '',
        '### Chunk 9/20',
        '',
        'Thanks for the opportunity to review this section of the codebase.',
        '',
        '## MINOR',
        '',
        '### src/a2ui/webview.ts:268 - Redundant event listener causes double execution',
        'Remove the change event listener block to prevent duplicate reactivity calculations.',
      ].join('\n');

      const formatted = ConversationalFeedback.formatReview(rawReview, { actionableCount: 2 });

      expect(formatted).toContain('🔴 Critical/BLOCKER findings (1)');
      expect(formatted).toContain('🟡 Minor comments (1)');
      expect(formatted).toContain('**src/a2ui/renderer.ts:~1035 - Markdown XSS via javascript: Links**');
      expect(formatted).toContain('**src/a2ui/webview.ts:268 - Redundant event listener causes double execution**');
      expect(formatted).not.toContain('Here is the review of the provided code.');
      expect(formatted).not.toContain('Thanks for the opportunity to review this section of the codebase.');
      expect(formatted).not.toMatch(/Chunk \d+\/\d+/);
    });

    it('groups outside-diff comments by file from plain file headings', () => {
      const rawReview = [
        '## [CRITICAL] (outside diff) src/a.js:10 - Security issue',
        '**Problem:** First outside-diff issue',
        '',
        '## [MINOR] (outside diff) src/b.js:20 - Typo',
        '**Problem:** Second outside-diff issue',
      ].join('\n');
      const separated = ConversationalFeedback.separateOutsideDiffComments(rawReview);

      const formatted = ConversationalFeedback.formatReview(rawReview, {
        hasCriticalOutsideDiff: true,
        outsideDiffComments: separated.outsideDiffComments,
      });

      expect(formatted).toContain('<summary>src/a.js (1)</summary>');
      expect(formatted).toContain('<summary>src/b.js (1)</summary>');
      expect(formatted).not.toContain('<summary>General (2)</summary>');
    });

    it('returns to inline findings after an outside-diff finding', () => {
      const rawReview = [
        '## [MAJOR] (outside diff) src/a.js:10 - Outside issue',
        '**Problem:** Outside the changed lines',
        '',
        '## [MINOR] src/b.js:20 - In-diff issue',
        '**Problem:** Inside the changed lines',
      ].join('\n');

      const separated = ConversationalFeedback.separateOutsideDiffComments(rawReview);

      expect(separated.outsideDiffComments).toHaveLength(1);
      expect(separated.inlineComments).toContain('src/b.js:20 - In-diff issue');
      expect(separated.outsideDiffComments[0].content.join('\n')).not.toContain('In-diff issue');
    });
  });
});

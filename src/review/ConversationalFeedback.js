// Handles conversational feedback logic for code review
class ConversationalFeedback {
  /**
   * Parses raw review text and extracts findings with severity and details
   * @param {string} rawReview - Raw review text
   * @returns {Array} Array of finding objects with severity, title, problem, impact, fix, prompt
   * @private
   */
  static parseFindings(rawReview) {
    if (!rawReview || typeof rawReview !== 'string') {
      return [];
    }

    const findings = [];
    const lines = rawReview.split('\n');
    let current = null;
    let currentSection = null;
    let activeSeverity = null;

    const flushCurrent = () => {
      if (!current || (!current.title && !current.location)) {
        current = null;
        currentSection = null;
        return;
      }

      findings.push({
        ...current,
        problem: current.problem.trim(),
        impact: current.impact.trim(),
        fix: current.fix.trim(),
        prompt: current.prompt.trim()
      });
      current = null;
      currentSection = null;
    };

    for (const line of lines) {
      const trimmed = line.trim();

      if (!trimmed) {
        continue;
      }

      // Skip chunk boundary markers (structural separators between combined chunks)
      if (trimmed.match(/^#{2,}\s+Chunk\s+\d+\/\d+/) || trimmed === '---' || trimmed === '• --') {
        flushCurrent();
        activeSeverity = null;
        continue;
      }

      // Match severity patterns: [SEVERITY] File:Line - Title or (outside diff) prefix
      const bracketedFinding = parseBracketedFindingHeading(trimmed);
      if (bracketedFinding) {
        flushCurrent();
        activeSeverity = bracketedFinding.severity;
        current = bracketedFinding;
        continue;
      }

      const severityBanner = parseSeverityBanner(trimmed);
      if (severityBanner) {
        flushCurrent();
        activeSeverity = severityBanner;
        continue;
      }

      if (isNarrativeFiller(trimmed)) {
        flushCurrent();
        continue;
      }

      const contextualFinding = activeSeverity
        ? parseContextualFindingHeading(trimmed, activeSeverity)
        : null;
      if (contextualFinding) {
        flushCurrent();
        current = contextualFinding;
        continue;
      }

      if (!current) continue;

      // Match section headers within a finding and capture inline content
      const problemMatch = trimmed.match(/^\*{2}Problem:\*{2}\s*(.*)/i);
      if (problemMatch) {
        currentSection = 'problem';
        if (problemMatch[1]) current.problem = problemMatch[1];
        continue;
      }
      const impactMatch = trimmed.match(/^\*{2}Impact:\*{2}\s*(.*)/i);
      if (impactMatch) {
        currentSection = 'impact';
        if (impactMatch[1]) current.impact = impactMatch[1];
        continue;
      }
      const fixMatch = trimmed.match(/^\*{2}Suggested fix:\*{2}\s*(.*)/i);
      if (fixMatch) {
        currentSection = 'fix';
        if (fixMatch[1]) current.fix = fixMatch[1];
        continue;
      }
      const promptMatch = trimmed.match(/^\*{2}Prompt for AI Agents:\*{2}\s*(.*)/i);
      if (promptMatch) {
        currentSection = 'prompt';
        if (promptMatch[1]) current.prompt = promptMatch[1];
        continue;
      }

      // Append to current section
      if (currentSection) {
        if (current[currentSection]) {
          current[currentSection] += '\n' + line;
        } else {
          current[currentSection] = line;
        }
      } else if (current.problem) {
        current.problem += '\n' + line;
      } else {
        current.problem = line;
      }
    }

    flushCurrent();

    return findings;
  }

  /**
   * Groups findings by severity level
   * @param {Array} findings - Array of finding objects
   * @returns {Object} Object with critical, major, minor arrays
   * @private
   */
  static groupBySeverity(findings) {
    const grouped = {
      critical: [],
      major: [],
      minor: [],
      info: []
    };

    for (const finding of findings) {
      switch (finding.severity) {
      case 'critical':
      case 'blocker':
        grouped.critical.push(finding);
        break;
      case 'major':
        grouped.major.push(finding);
        break;
      case 'minor':
        grouped.minor.push(finding);
        break;
      case 'info':
      default:
        grouped.info.push(finding);
      }
    }

    return grouped;
  }

  /**
   * Formats a single finding with all its details
   * @param {Object} finding - Finding object with severity, title, problem, impact, fix, prompt
   * @returns {string} Formatted finding in markdown
   * @private
   */
  static formatFinding(finding) {
    const heading = finding.location && finding.location !== finding.title
      ? `${finding.location} - ${finding.title}`
      : finding.title;
    let output = `**${heading}**`;

    if (finding.isOutsideDiff) {
      output = `**(outside diff) ${heading}**`;
    }

    if (finding.problem) {
      output += `\n**Problem:** ${finding.problem}`;
    }

    if (finding.impact) {
      output += `\n**Impact:** ${finding.impact}`;
    }

    if (finding.fix) {
      output += `\n**Suggested fix:**\n${finding.fix}`;
    }

    if (finding.prompt) {
      output += `\n**Prompt for AI Agents:**\n${finding.prompt}`;
    }

    return output;
  }

  /**
   * Builds a context-aware, developer-friendly review prompt for Z.ai
   * @param {Array} files - PR files (with patch, filename, status)
   * @param {number} chunkIndex - Index of this chunk
   * @param {number} totalChunks - Total number of chunks
   * @returns {string} Prompt for Z.ai
   */
  static buildPrompt(files, chunkIndex, totalChunks) {
    const diffs = files
      .filter(f => f.patch)
      .map(f => `### ${f.filename} (${f.status})\n\u0060\u0060\u0060diff\n${f.patch}\n\u0060\u0060\u0060`)
      .join('\n\n');

    let prompt = [
      'You are a friendly, expert code reviewer. Review the following pull request changes and provide clear, actionable, and developer-friendly feedback.',
      'Focus on bugs, logic errors, security issues, and meaningful improvements. Skip trivial style comments.',
      'Write in a conversational, encouraging tone. Use bullet points for clarity. Suggest concrete next steps where possible.',
      'Only emit a suggestion marker when you have a high-confidence, line-specific replacement for code shown in the diff.',
      'Use this exact format for each actionable inline fix: [[suggestion:path:<file path>:line:<new file line>:<short summary>:<replacement code>]].',
      'Do not emit suggestion markers for uncertain advice, general feedback, or code that is not visible in the diff.',
      '',
    ].join(' ');

    // Add format instructions
    const formatInstructions = `
Format each finding as follows:

## [SEVERITY] File:Line - Brief Title
**Problem:** Description of the issue
**Impact:** Why this matters
**Suggested fix:**
\`\`\`diff
- bad code
+ good code
\`\`\`
**Prompt for AI Agents:**
\`\`\`
Specific instructions for AI verification and fix.
\`\`\`

Group findings by severity: BLOCKER > CRITICAL > Major > Minor > Info.
Mark findings outside the diff with "(outside diff)" before the title.
Do not include conversational introductions, praise, summaries, or sign-offs.
Do not emit standalone severity banners such as "## CRITICAL" or "## Major".
Do not mention chunk numbers, part numbers, or headings such as "Code Review: Part X/Y".
If a finding cannot follow the required structure, omit it rather than writing free-form commentary.
`.trim();

    prompt += '\n\n' + formatInstructions;

    if (totalChunks > 1) {
      prompt += `\n\n[This is part ${chunkIndex + 1} of ${totalChunks} in a large code review. Focus only on this section.]\n`;
    }

    prompt += '\n\n' + diffs;
    return prompt;
  }

  /**
   * Post-processes Z.ai feedback for clarity and developer-friendliness
   * @param {string} feedback - Raw Z.ai response
   * @returns {string} Cleaned, actionable feedback
   */
  static postProcess(feedback) {
    if (!feedback) return '';
    // Remove excessive apologies, generic phrases, and ensure bullet points
    let result = feedback
      .replace(/(?:(?:I\s+)?(?:have|has) reviewed(?: the)? changes?\.?|Here(?: are| is) (?:my|the)? feedback:?|Below (?:are|is) (?:my|the)? (?:feedback|comments):?)/gi, '')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/^-\s*/gm, '• ')
      .trim();
    // Ensure at least one actionable suggestion
    if (!/• /.test(result)) {
      result = '• ' + result;
    }
    return result;
  }

  /**
   * Separates outside-diff comments from inline comments based on "(outside diff)" markers
   * @param {string} rawReview - Raw review text from the AI
   * @returns {Object} Object with inlineComments and outsideDiffComments
   */
  static separateOutsideDiffComments(rawReview) {
    if (!rawReview || typeof rawReview !== 'string') {
      return { inlineComments: '', outsideDiffComments: [] };
    }

    const inlineComments = [];
    const outsideDiffComments = [];

    const lines = rawReview.split('\n');
    let currentFinding = null;
    let currentOutside = false;

    const flushCurrent = () => {
      if (!currentFinding) {
        return;
      }
      if (currentOutside) {
        outsideDiffComments.push(currentFinding);
      } else {
        inlineComments.push(...currentFinding.content);
      }
      currentFinding = null;
      currentOutside = false;
    };

    for (const line of lines) {
      const isOutsideMarker = /\(outside (?:the )?diff\)/i.test(line);
      const isFindingHeading = /^(?:[•*-]\s*)?#{1,3}\s+\[/.test(line);

      if (isFindingHeading) {
        flushCurrent();
        currentFinding = { line, content: [line] };
        currentOutside = isOutsideMarker;
      } else if (!currentFinding) {
        inlineComments.push(line);
      } else if (currentFinding) {
        currentFinding.content.push(line);
      }
    }

    flushCurrent();

    return { inlineComments: inlineComments.join('\n'), outsideDiffComments };
  }

  /**
   * Formats outside-diff comments into a collapsible section grouped by file
   * @param {Array} outsideDiffComments - Array of outside-diff comment objects
   * @returns {string} Formatted markdown section or empty string if no comments
   */
  static formatOutsideDiffSection(outsideDiffComments) {
    if (!outsideDiffComments || outsideDiffComments.length === 0) {
      return '';
    }

    let output = `\n<details>\n<summary>⚠️ Outside diff range comments (${outsideDiffComments.length})</summary><blockquote>\n\n`;

    const byFile = {};
    for (const comment of outsideDiffComments) {
      const content = comment.content.join('\n');
      const parsedFinding = ConversationalFeedback.parseFindings(content)[0];
      const fileMatch = content.match(/`([^`]+)`/);
      let file = parsedFinding?.location || (fileMatch ? fileMatch[1] : 'General');
      // Extract just the filename without line number (e.g., "src/foo.js:5" -> "src/foo.js")
      file = file.split(':')[0];
      if (!byFile[file]) byFile[file] = [];
      byFile[file].push(comment);
    }

    for (const [file, comments] of Object.entries(byFile)) {
      output += `<details>\n<summary>${file} (${comments.length})</summary><blockquote>\n\n`;
      for (const comment of comments) {
        output += comment.content.join('\n') + '\n\n';
      }
      output += '</blockquote></details>\n\n';
    }

    output += '</blockquote></details>\n';
    return output;
  }

  /**
   * Formats raw review text into a structured markdown output with collapsible sections
   * @param {string} rawReview - Raw review text from the AI
   * @param {Object} options - Formatting options
   * @param {number} options.actionableCount - Number of actionable comments posted inline
   * @param {boolean} options.hasCriticalOutsideDiff - Whether critical comments exist outside diff
   * @param {Array} options.outsideDiffComments - Array of outside-diff comment objects
   * @returns {string} Formatted review with collapsible sections grouped by severity
   */
  static formatReview(rawReview, options = {}) {
    const {
      actionableCount = 0,
      hasCriticalOutsideDiff = false,
      outsideDiffComments = []
    } = options;

    let output = `**Actionable suggestions identified: ${actionableCount}**\n\n`;

    if (actionableCount > 0) {
      output += '> [!NOTE]\n> Inline suggestions are posted on a best-effort basis; GitHub may reject invalid or outdated diff anchors.\n\n';
    }

    if (hasCriticalOutsideDiff) {
      output += '> [!CAUTION]\n> Some comments are outside the diff and can\'t be posted inline due to platform limitations.\n\n';
    }

    // Parse and group findings by severity
    const findings = ConversationalFeedback.parseFindings(rawReview)
      .filter(finding => outsideDiffComments.length === 0 || !finding.isOutsideDiff);
    const grouped = ConversationalFeedback.groupBySeverity(findings);

    // Add critical section
    if (grouped.critical.length > 0) {
      output += `<details>\n<summary>🔴 Critical/BLOCKER findings (${grouped.critical.length})</summary><blockquote>\n\n`;
      output += grouped.critical.map(f => ConversationalFeedback.formatFinding(f)).join('\n\n');
      output += '\n\n</blockquote></details>\n\n';
    }

    // Add major section
    if (grouped.major.length > 0) {
      output += `<details>\n<summary>🟠 Major comments (${grouped.major.length})</summary><blockquote>\n\n`;
      output += grouped.major.map(f => ConversationalFeedback.formatFinding(f)).join('\n\n');
      output += '\n\n</blockquote></details>\n\n';
    }

    // Add minor section
    if (grouped.minor.length > 0) {
      output += `<details>\n<summary>🟡 Minor comments (${grouped.minor.length})</summary><blockquote>\n\n`;
      output += grouped.minor.map(f => ConversationalFeedback.formatFinding(f)).join('\n\n');
      output += '\n\n</blockquote></details>\n\n';
    }

    // Add info section
    if (grouped.info.length > 0) {
      output += `<details>\n<summary>ℹ️ Info comments (${grouped.info.length})</summary><blockquote>\n\n`;
      output += grouped.info.map(f => ConversationalFeedback.formatFinding(f)).join('\n\n');
      output += '\n\n</blockquote></details>\n\n';
    }

    // Add outside-diff section
    const outsideDiffSection = ConversationalFeedback.formatOutsideDiffSection(outsideDiffComments);
    if (outsideDiffSection) {
      output += outsideDiffSection;
    }

    return output.trim();
  }
}

function createFinding(severity, location, title) {
  const cleanLocation = location.replace(/\s*\(outside diff\)\s*/gi, '').trim();
  const cleanTitle = title.replace(/\s*\(outside diff\)\s*/gi, '').trim();

  return {
    severity,
    location: cleanLocation,
    title: cleanTitle || cleanLocation,
    isOutsideDiff: location.includes('(outside diff)') || title.includes('(outside diff)'),
    problem: '',
    impact: '',
    fix: '',
    prompt: ''
  };
}

function parseBracketedFindingHeading(line) {
  const severityMatch = line.match(/^(?:[•*-]\s*)?#+\s*\[(BLOCKER|CRITICAL|Major|Minor|Info)\]\s+(.+?)(?:\s+-\s+(.+))?$/i);
  if (!severityMatch) {
    return null;
  }

  const severity = normalizeSeverity(severityMatch[1]);
  const location = severityMatch[2];
  const title = severityMatch[3] || location;
  return createFinding(severity, location, title);
}

function parseSeverityBanner(line) {
  const match = line.match(/^#{1,6}\s+(BLOCKER|CRITICAL|MAJOR|MINOR|INFO)\s*$/i);
  return match ? normalizeSeverity(match[1]) : null;
}

function parseContextualFindingHeading(line, severity) {
  const boldTitleMatch = line.match(/^\*{2}(?!Problem:|Impact:|Suggested fix:|Prompt for AI Agents:)(.+?)\*{2}$/i);
  if (boldTitleMatch) {
    return createFinding(severity, '', boldTitleMatch[1]);
  }

  const headingMatch = line.match(/^#{1,6}\s+(.+)$/);
  if (!headingMatch) {
    return null;
  }

  let content = headingMatch[1].trim();
  if (!content || /^Chunk\s+\d+\/\d+$/i.test(content) || content.startsWith('[')) {
    return null;
  }

  content = content.replace(/^(BLOCKER|CRITICAL|MAJOR|MINOR|INFO):\s+/i, '');
  const dividerIndex = content.indexOf(' - ');
  if (dividerIndex === -1) {
    return createFinding(severity, '', content);
  }

  const location = content.slice(0, dividerIndex).trim();
  const title = content.slice(dividerIndex + 3).trim();
  return createFinding(severity, location, title);
}

function isNarrativeFiller(line) {
  return /^(?:Here is the review|Here is my review|Here are my findings|Thanks for the opportunity|Overall,|Great work on this PR|Keep up the good work|Next steps:?)/i.test(line);
}

// Normalizes severity labels to a standard format
function normalizeSeverity(severity) {
  const normalized = severity.toUpperCase();
  if (normalized === 'BLOCKER') return 'critical';
  if (normalized === 'CRITICAL') return 'critical';
  if (normalized === 'MAJOR') return 'major';
  if (normalized === 'MINOR') return 'minor';
  if (normalized === 'INFO') return 'info';
  return 'info';
}

module.exports = ConversationalFeedback;

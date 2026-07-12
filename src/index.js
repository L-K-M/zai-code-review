const https = require('https');

const ConversationalFeedback = require('./review/ConversationalFeedback');
const InlineSuggestion = require('./review/InlineSuggestion');
const FeedbackLearning = require('./review/FeedbackLearning');
const SecurityCheck = require('./review/SecurityCheck');
const { calculateSimilarity, findSimilarThread } = require('./review/ThreadSimilarity');

let core;
let github;

async function loadActionsToolkit() {
  if (!core || !github) {
    [core, github] = await Promise.all([
      import('@actions/core'),
      import('@actions/github'),
    ]);
  }
}

const ZAI_API_URL = 'https://api.z.ai/api/coding/paas/v4/chat/completions';
const COMMENT_MARKER = '<!-- zai-code-review -->';
const ERR_PREFIX = 'Z.ai API: ';
const MAX_RESPONSE_SIZE = 1024 * 1024;
const MAX_COMMENT_SIZE = 65000;
const REQUEST_TIMEOUT_MS = 300_000;
const PER_PAGE = 100;
const MAX_CHUNK_SIZE = 50000;
const MAX_LISTED_FILES = 20;
const RETRY_CONFIG = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 8000,
};

function matchesPattern(filename, pattern) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '\x00')
    .replace(/\*\*/g, '\x01')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\x00/g, '(?:.*/)?')
    .replace(/\x01/g, '.*');
  const regex = new RegExp(`^${escaped}$`);
  const basename = filename.split('/').pop();
  return regex.test(filename) || regex.test(basename);
}

function filterFiles(files, excludePatterns) {
  if (!excludePatterns || excludePatterns.length === 0) {
    return files;
  }
  return files.filter(file => !excludePatterns.some(pattern => {
    return matchesPattern(file.filename, pattern);
  }));
}

function limitFilesByDiffChars(files, maxDiffChars) {
  if (!Number.isInteger(maxDiffChars) || maxDiffChars <= 0) {
    return { files, skippedFiles: [] };
  }

  const includedFiles = [];
  const skippedFiles = [];
  let totalChars = 0;

  for (const file of files) {
    if (!file.patch) {
      continue;
    }
    const entrySize = file.patch.length + file.filename.length + 50;
    if (totalChars + entrySize > maxDiffChars) {
      skippedFiles.push(file.filename);
      continue;
    }
    includedFiles.push(file);
    totalChars += entrySize;
  }

  return { files: includedFiles, skippedFiles };
}

function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return hash.toString(36);
}

async function getChangedFiles(octokit, owner, repo, pullNumber) {
  const files = [];
  let page = 1;
  while (true) {
    const { data } = await octokit.rest.pulls.listFiles({
      owner,
      repo,
      pull_number: pullNumber,
      per_page: PER_PAGE,
      page,
    });
    files.push(...data);
    if (data.length < PER_PAGE) break;
    page++;
  }
  return files;
}

function splitIntoChunks(files) {
  const filesWithPatches = files.filter(f => f.patch);

  if (filesWithPatches.length === 0) return [];

  const chunks = [];
  let currentChunk = [];
  let currentSize = 0;

  for (const file of filesWithPatches) {
    const fileSize = file.patch.length;

    // Keep each request bounded even when GitHub returns an unusually large patch.
    if (fileSize > MAX_CHUNK_SIZE) {
      if (currentChunk.length > 0) {
        chunks.push(currentChunk);
        currentChunk = [];
        currentSize = 0;
      }
      chunks.push([{
        ...file,
        patch: file.patch.slice(0, MAX_CHUNK_SIZE),
        truncated: true,
        originalPatchLength: fileSize,
      }]);
      continue;
    }

    if (currentSize + fileSize > MAX_CHUNK_SIZE && currentChunk.length > 0) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentSize = 0;
    }

    currentChunk.push(file);
    currentSize += fileSize;
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
}

function formatFileList(files) {
  const visibleFiles = files.slice(0, MAX_LISTED_FILES);
  const remaining = files.length - visibleFiles.length;
  const list = visibleFiles.map(file => `\`${file}\``).join(', ');
  return remaining > 0 ? `${list}, and ${remaining} more` : list;
}

function buildCoverageWarning({ excludedFiles = [], patchlessFiles = [], skippedFiles = [], truncatedFiles = [] }) {
  const details = [];
  if (excludedFiles.length > 0) {
    details.push(`excluded by pattern: ${formatFileList(excludedFiles)}`);
  }
  if (patchlessFiles.length > 0) {
    details.push(`no patch returned by GitHub: ${formatFileList(patchlessFiles)}`);
  }
  if (skippedFiles.length > 0) {
    details.push(`over the diff budget: ${formatFileList(skippedFiles)}`);
  }
  if (truncatedFiles.length > 0) {
    details.push(`truncated to ${MAX_CHUNK_SIZE} characters: ${formatFileList(truncatedFiles)}`);
  }
  if (details.length === 0) {
    return '';
  }
  return [
    '> [!NOTE]',
    '> Review coverage was limited for some files:',
    ...details.map(detail => `> - ${detail}`),
  ].join('\n');
}

function buildCommentBody(reviewerName, review) {
  const safeReviewerName = String(reviewerName || 'Z.ai Code Review').slice(0, 200);
  const prefix = `## ${safeReviewerName}\n\n`;
  const suffix = `\n\n${COMMENT_MARKER}`;
  const body = `${prefix}${review}${suffix}`;
  if (body.length <= MAX_COMMENT_SIZE) {
    return body;
  }

  const truncationNotice = [
    '> [!WARNING]',
    '> Review output was truncated and shown as plain text to fit GitHub\'s comment size limit.',
  ].join('\n');
  const prePrefix = '\n\n<pre>';
  const preSuffix = '</pre>';
  const fixedSize = prefix.length + truncationNotice.length + prePrefix.length
    + preSuffix.length + suffix.length;
  let low = 0;
  let high = Math.min(review.length, MAX_COMMENT_SIZE - fixedSize);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const escapedLength = escapeHtml(review.slice(0, middle)).length;
    if (fixedSize + escapedLength <= MAX_COMMENT_SIZE) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  const escapedReview = escapeHtml(review.slice(0, low));

  return `${prefix}${truncationNotice}${prePrefix}${escapedReview}${preSuffix}${suffix}`;
}

function escapeHtml(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function buildChunkPrompt(files, chunkIndex, totalChunks) {
  const diffs = files
    .filter(f => f.patch)
    .map(f => `### ${f.filename} (${f.status})\n\`\`\`diff\n${f.patch}\n\`\`\``)
    .join('\n\n');

  let prompt = 'Please review the following pull request changes and provide concise, constructive feedback. Focus on bugs, logic errors, security issues, and meaningful improvements. Skip trivial style comments.\n\n';

  if (totalChunks > 1) {
    prompt += `[This is part ${chunkIndex + 1} of ${totalChunks} in a large code review. Focus on the changes in this section only.]\n\n`;
  }

  prompt += diffs;

  return prompt;
}

function formatApiRequestLabel({ chunkIndex, totalChunks, fileCount, truncatedFileCount, patchChars, promptChars }) {
  const parts = [
    `chunk ${chunkIndex + 1}/${totalChunks}`,
    `${fileCount} file(s)`,
  ];

  if (truncatedFileCount > 0) {
    parts.push(`${truncatedFileCount} truncated file(s)`);
  }

  parts.push(`${patchChars} patch chars`);
  parts.push(`${promptChars} prompt chars`);

  return parts.join(', ');
}

function buildChunkFailureWarning(failedChunks, totalChunks) {
  if (!Array.isArray(failedChunks) || failedChunks.length === 0) {
    return '';
  }

  const chunkList = failedChunks.map(chunk => chunk.index + 1).join(', ');
  return [
    '> [!CAUTION]',
    `> Review incomplete: ${failedChunks.length} of ${totalChunks} chunk(s) failed during AI review.`,
    `> Chunks ${chunkList} failed and were omitted from the merged results. See the workflow logs for details.`,
  ].join('\n');
}

function formatChunkMergeSummary(successfulChunks, totalChunks) {
  const failedChunks = Math.max(totalChunks - successfulChunks, 0);
  if (failedChunks === 0) {
    return `Combined ${successfulChunks} successful review chunk(s) into single comment.`;
  }

  return `Combined ${successfulChunks} successful review chunk(s) into single comment. ${failedChunks} chunk(s) failed.`;
}

function buildCombinedReview(reviews, totalChunks, actionableCount, coverageWarning = '') {
  const failedChunks = reviews
    .filter(review => !review.success)
    .map(review => ({ index: review.index, error: review.error || review.review || 'Unknown error' }));
  let allOutsideDiffComments = [];
  let rawCombinedReview = '';

  if (totalChunks > 1) {
    for (const review of reviews) {
      if (!review.success) {
        continue;
      }

      const separated = ConversationalFeedback.separateOutsideDiffComments(review.rawReview);
      allOutsideDiffComments.push(...separated.outsideDiffComments);
      rawCombinedReview += (review.summaryReview || review.rawReview || '') + '\n\n';
    }
  } else if (reviews[0]?.success) {
    const separated = ConversationalFeedback.separateOutsideDiffComments(reviews[0].rawReview);
    allOutsideDiffComments.push(...separated.outsideDiffComments);
    rawCombinedReview = reviews[0].summaryReview || reviews[0].rawReview || '';
  } else {
    rawCombinedReview = reviews[0]?.review || '';
  }

  const hasCriticalOutsideDiff = allOutsideDiffComments.some(comment => {
    const content = comment.content?.join('\n') || '';
    return /\b(critical|blocker)\b/i.test(content);
  });
  const formattedReview = ConversationalFeedback.formatReview(rawCombinedReview, {
    actionableCount,
    hasCriticalOutsideDiff,
    outsideDiffComments: allOutsideDiffComments,
  });
  const failureWarning = buildChunkFailureWarning(failedChunks, totalChunks);

  return [coverageWarning, failureWarning, formattedReview].filter(Boolean).join('\n\n').trim();
}

function extractActionableSuggestions(reviews) {
  const suggestions = [];
  const seen = new Set();

  for (const review of reviews) {
    const content = review.rawReview || '';
    const matches = Array.from(content.matchAll(/\[\[suggestion:(.+?)\]\]/gs));

    for (const match of matches) {
      const parts = match[1].split(':');
      if (parts.length < 6 || parts[0] !== 'path' || parts[2] !== 'line') {
        continue;
      }

      const line = Number(parts[3]);
      const body = parts[4]?.trim();
      const suggestion = parts.slice(5).join(':').trim();
      const path = parts[1]?.trim();

      if (!path || !Number.isInteger(line) || line < 1 || !body || !suggestion) {
        continue;
      }

      // Deduplicate by file:line:body combination
      const id = `${path}:${line}:${body}`;

      if (seen.has(id)) {
        continue;
      }

      seen.add(id);
      suggestions.push({
        id,
        path,
        line,
        side: 'RIGHT',
        body,
        suggestion,
      });
    }
  }

  return suggestions;
}

function formatSecurityFindingsForReview(findings) {
  if (!Array.isArray(findings) || findings.length === 0) {
    return '';
  }

  return findings.map(finding => {
    const severity = mapSecuritySeverityToReviewSeverity(finding.severity);
    const location = `${finding.path}:${finding.line}`;
    return [
      `## [${severity}] ${location} - ${finding.message}`,
      `**Problem:** ${finding.message}`,
      '**Impact:** Security-sensitive code was added in this diff and should be reviewed carefully.',
    ].join('\n');
  }).join('\n\n');
}

function mapSecuritySeverityToReviewSeverity(severity) {
  switch ((severity || '').toLowerCase()) {
  case 'high':
    return 'CRITICAL';
  case 'medium':
    return 'MAJOR';
  case 'low':
    return 'MINOR';
  default:
    return 'INFO';
  }
}

function callZaiApi(apiKey, model, systemPrompt, prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model,
      messages: [
        {
          role: 'system',
          content: systemPrompt,
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
    });

    const url = new URL(ZAI_API_URL);
    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => {
        data += chunk;
        if (data.length > MAX_RESPONSE_SIZE) {
          req.destroy(new Error(`${ERR_PREFIX}Response exceeded size limit.`));
        }
      });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          let parsed;
          try {
            parsed = JSON.parse(data);
          } catch (err) {
            reject(new Error(`${ERR_PREFIX}Invalid JSON response.`));
            return;
          }
          const content = parsed.choices?.[0]?.message?.content;
          if (!content) {
            reject(new Error(`${ERR_PREFIX}Empty response body.`));
          } else {
            resolve(content);
          }
        } else {
          const error = new Error(`${ERR_PREFIX}HTTP ${res.statusCode}.`);
          error.statusCode = res.statusCode;
          error.retryAfterMs = parseRetryAfter(res.headers['retry-after']);
          reject(error);
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`${ERR_PREFIX}Request timed out.`));
    });
    req.write(body);
    req.end();
  });
}

function parseRetryAfter(value) {
  if (!value) {
    return 0;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? 0 : Math.max(0, timestamp - Date.now());
}

function isRetryableError(error) {
  if (!error?.statusCode) {
    return true;
  }
  return error.statusCode === 408
    || error.statusCode === 429
    || error.statusCode === 529
    || error.statusCode >= 500;
}

async function callZaiApiWithRetry(apiKey, model, systemPrompt, prompt, requestLabel = 'request') {
  let lastError;

  for (let attempt = 0; attempt < RETRY_CONFIG.maxRetries; attempt++) {
    const attemptStartedAt = Date.now();
    try {
      return await callZaiApi(apiKey, model, systemPrompt, prompt);
    } catch (err) {
      lastError = err;
      const elapsedMs = Date.now() - attemptStartedAt;
      core?.info(
        `API call failed for ${requestLabel} (attempt ${attempt + 1}/${RETRY_CONFIG.maxRetries}) after ${elapsedMs}ms: ${err.message}`
      );

      if (!isRetryableError(err)) {
        throw err;
      }

      if (attempt < RETRY_CONFIG.maxRetries - 1) {
        const delayMs = Math.min(
          Math.max(RETRY_CONFIG.baseDelayMs * Math.pow(2, attempt), err.retryAfterMs || 0),
          RETRY_CONFIG.maxDelayMs
        );
        core?.info(`Retrying ${requestLabel} in ${delayMs}ms...`);
        await new Promise(r => setTimeout(r, delayMs));
      }
    }
  }

  throw lastError;
}

async function filterResolvedSuggestions(octokit, owner, repo, pullNumber, suggestions) {
  try {
    if (typeof octokit.graphql === 'function') {
      const resolvedThreads = new Map();
      let cursor = null;
      do {
        const data = await octokit.graphql(`
          query($owner: String!, $repo: String!, $pullNumber: Int!, $cursor: String) {
            repository(owner: $owner, name: $repo) {
              pullRequest(number: $pullNumber) {
                reviewThreads(first: 100, after: $cursor) {
                  nodes {
                    isResolved
                    comments(first: 100) {
                      nodes { path line originalLine body }
                    }
                  }
                  pageInfo { hasNextPage endCursor }
                }
              }
            }
          }
        `, { owner, repo, pullNumber, cursor });
        const threads = data.repository.pullRequest.reviewThreads;
        for (const thread of threads.nodes) {
          if (!thread.isResolved) {
            continue;
          }
          for (const comment of thread.comments.nodes) {
            const key = `${comment.path}:${comment.line || comment.originalLine}`;
            if (!resolvedThreads.has(key)) {
              resolvedThreads.set(key, []);
            }
            resolvedThreads.get(key).push(comment);
          }
        }
        cursor = threads.pageInfo.hasNextPage ? threads.pageInfo.endCursor : null;
      } while (cursor);
      return suggestions.filter(suggestion => !findSimilarThread(resolvedThreads, suggestion));
    }

    // Retain support for Octokit-compatible clients that do expose resolution state.
    const comments = [];
    let page = 1;
    while (true) {
      const { data } = await octokit.rest.pulls.listReviewComments({
        owner,
        repo,
        pull_number: pullNumber,
        per_page: PER_PAGE,
        page,
      });
      comments.push(...data);
      if (data.length < PER_PAGE) break;
      page++;
    }

    const resolvedThreads = new Map();
    for (const comment of comments) {
      if (comment.state === 'RESOLVED' || comment.resolved) {
        const key = `${comment.path}:${comment.line || comment.original_line}`;
        if (!resolvedThreads.has(key)) {
          resolvedThreads.set(key, []);
        }
        resolvedThreads.get(key).push(comment);
      }
    }

    return suggestions.filter(suggestion => !findSimilarThread(resolvedThreads, suggestion));
  } catch (err) {
    core?.warning(`Could not filter resolved suggestions: ${err.message}`);
    return suggestions;
  }
}

async function getExistingCommentThreads(octokit, owner, repo, pullNumber) {
  try {
    const comments = [];
    let page = 1;
    while (true) {
      const { data } = await octokit.rest.pulls.listReviewComments({
        owner,
        repo,
        pull_number: pullNumber,
        per_page: PER_PAGE,
        page,
      });
      comments.push(...data);
      if (data.length < PER_PAGE) break;
      page++;
    }

    const threads = new Map();
    for (const comment of comments) {
      const key = `${comment.path}:${comment.line || comment.original_line || 'noline'}`;
      if (!threads.has(key)) {
        threads.set(key, []);
      }
      threads.get(key).push(comment);
    }
    return threads;
  } catch (err) {
    core?.warning(`Failed to fetch existing threads: ${err.message}`);
    return new Map();
  }
}

async function getIssueComments(octokit, owner, repo, pullNumber) {
  const comments = [];
  let page = 1;
  while (true) {
    const { data } = await octokit.rest.issues.listComments({
      owner,
      repo,
      issue_number: pullNumber,
      per_page: PER_PAGE,
      page,
    });
    comments.push(...data);
    if (data.length < PER_PAGE) break;
    page++;
  }
  return comments;
}

async function upsertReviewComment(octokit, owner, repo, pullNumber, body) {
  const comments = await getIssueComments(octokit, owner, repo, pullNumber);
  const existing = comments.find(comment => comment.body?.includes(COMMENT_MARKER));

  if (existing) {
    await octokit.rest.issues.updateComment({
      owner,
      repo,
      comment_id: existing.id,
      body,
    });
    core?.info('Review comment updated.');
  } else {
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: pullNumber,
      body,
    });
    core?.info('Review comment posted.');
  }
}

async function run() {
  await loadActionsToolkit();
  const apiKey = core.getInput('ZAI_API_KEY', { required: true });
  core.setSecret(apiKey);
  const model = core.getInput('ZAI_MODEL') || 'glm-4.7';
  const systemPrompt = core.getInput('ZAI_SYSTEM_PROMPT');
  const reviewerName = core.getInput('ZAI_REVIEWER_NAME');
  const excludePatterns = core.getInput('EXCLUDE_PATTERNS')
    .split(',')
    .map(pattern => pattern.trim())
    .filter(Boolean);
  const parsedMaxDiffChars = Number.parseInt(core.getInput('MAX_DIFF_CHARS'), 10);
  const maxDiffChars = Number.isInteger(parsedMaxDiffChars) && parsedMaxDiffChars >= 0
    ? parsedMaxDiffChars
    : 0;
  const token = core.getInput('GITHUB_TOKEN');
  core.setSecret(token);
  let threadSimilarityThreshold = parseFloat(core.getInput('ZAI_THREAD_SIMILARITY_THRESHOLD'));
  if (isNaN(threadSimilarityThreshold) || threadSimilarityThreshold < 0 || threadSimilarityThreshold > 1) {
    threadSimilarityThreshold = 0.6;
  }
  const { context } = github;
  const { owner, repo } = context.repo;
  const pullNumber = context.payload.pull_request?.number;

  if (!pullNumber) {
    core.setFailed('This action only runs on pull_request events.');
    return;
  }

  const headSha = context.payload.pull_request?.head?.sha;
  if (!headSha) {
    core.warning('Missing pull request head SHA. Inline suggestions may not work correctly.');
  }

  const octokit = github.getOctokit(token);

  // FeedbackLearning repoId: owner/repo
  const repoId = `${owner}/${repo}`;

  core.info(`Fetching changed files for PR #${pullNumber}...`);

  const files = await getChangedFiles(octokit, owner, repo, pullNumber);
  const filteredFiles = filterFiles(files, excludePatterns);
  const excludedFiles = files
    .filter(file => !filteredFiles.includes(file))
    .map(file => file.filename);
  const patchlessFiles = filteredFiles.filter(file => !file.patch).map(file => file.filename);
  const limited = limitFilesByDiffChars(filteredFiles, maxDiffChars);
  const reviewFiles = limited.files;
  const scopeCoverageWarning = buildCoverageWarning({
    excludedFiles,
    patchlessFiles,
    skippedFiles: limited.skippedFiles,
  });

  if (excludedFiles.length > 0) {
    core.info(`Excluded ${excludedFiles.length} file(s) matching EXCLUDE_PATTERNS.`);
  }
  if (limited.skippedFiles.length > 0) {
    core.warning(`Skipped ${limited.skippedFiles.length} file(s) over MAX_DIFF_CHARS.`);
  }

  if (!reviewFiles.some(f => f.patch)) {
    const emptyReview = ConversationalFeedback.formatReview('');
    const body = buildCommentBody(
      reviewerName,
      [scopeCoverageWarning, emptyReview].filter(Boolean).join('\n\n')
    );
    await upsertReviewComment(octokit, owner, repo, pullNumber, body);
    core.info('No patchable changes found within the configured review scope.');
    return;
  }

  // --- SecurityCheck integration ---
  // Load custom patterns from .zai-review.yaml
  const workspaceRoot = process.env.GITHUB_WORKSPACE || process.cwd();
  const customPatterns = SecurityCheck.loadCustomPatterns(workspaceRoot);
  if (customPatterns.length > 0) {
    core.info(`Loaded ${customPatterns.length} custom security pattern(s) from .zai-review.yaml`);
  }

  const securityFindings = SecurityCheck.checkSecurity(reviewFiles, customPatterns);
  if (securityFindings.length > 0) {
    core.warning(`Security findings detected: ${securityFindings.length}`);
    for (const finding of securityFindings) {
      core.warning(`[${finding.severity}] ${finding.path}:${finding.line} - ${finding.message}`);
    }
  }

  const chunks = splitIntoChunks(reviewFiles);
  const truncatedFiles = chunks
    .flat()
    .filter(file => file.truncated)
    .map(file => file.filename);
  const coverageWarning = buildCoverageWarning({
    excludedFiles,
    patchlessFiles,
    skippedFiles: limited.skippedFiles,
    truncatedFiles,
  });
  core.info(`Processing ${reviewFiles.length} file(s) in ${chunks.length} chunk(s)...`);

  const reviews = [];
  const failedChunks = [];

  for (let i = 0; i < chunks.length; i++) {
    try {
      const truncatedChunkFiles = chunks[i].filter(f => f.truncated);
      if (truncatedChunkFiles.length > 0) {
        for (const file of truncatedChunkFiles) {
          core.warning(
            `File ${file.filename} was truncated from ${file.originalPatchLength} to ${MAX_CHUNK_SIZE} characters.`
          );
        }
      }
      core.info(`Processing chunk ${i + 1}/${chunks.length} (${chunks[i].length} file(s))...`);
      const prompt = ConversationalFeedback.buildPrompt(chunks[i], i, chunks.length);
      const requestLabel = formatApiRequestLabel({
        chunkIndex: i,
        totalChunks: chunks.length,
        fileCount: chunks[i].length,
        truncatedFileCount: truncatedChunkFiles.length,
        patchChars: chunks[i].reduce((total, file) => total + (file.patch?.length || 0), 0),
        promptChars: prompt.length,
      });
      const rawReview = await callZaiApiWithRetry(apiKey, model, systemPrompt, prompt, requestLabel);
      const review = ConversationalFeedback.postProcess(rawReview);
      // Prepend actionable security findings for this chunk
      const chunkFindings = SecurityCheck.checkSecurity(chunks[i], customPatterns);
      const securityReview = formatSecurityFindingsForReview(chunkFindings);
      const summaryReview = securityReview ? `${securityReview}\n\n${rawReview}` : rawReview;
      let reviewWithSecurity = review;
      if (chunkFindings.length > 0) {
        const secHeader = '#### Security Findings (static analysis)\n';
        const secList = chunkFindings.map(f => `- [${f.severity}] ${f.path}:${f.line} - ${f.message}`).join('\n');
        reviewWithSecurity = `${secHeader}${secList}\n\n${review}`;
      }
      reviews.push({ index: i, rawReview, summaryReview, review: reviewWithSecurity, success: true });
    } catch (err) {
      core.warning(`Chunk ${i + 1}/${chunks.length} failed: ${err.message}`);
      failedChunks.push({ index: i, error: err.message });
      reviews.push({ index: i, rawReview: '', review: `**Error reviewing this chunk:** ${err.message}`, error: err.message, success: false });
    }
  }

  if (failedChunks.length > 0) {
    core.warning(`${failedChunks.length} chunk(s) failed out of ${chunks.length}`);
    if (failedChunks.length === chunks.length) {
      core.setFailed('All review chunks failed. No review could be generated.');
      return;
    }
  }

  if (chunks.length > 1) {
    const successfulChunks = reviews.filter(review => review.success).length;
    core.info(formatChunkMergeSummary(successfulChunks, chunks.length));
  }

  // Extract actionable suggestions count for formatting
  let actionableSuggestions = extractActionableSuggestions(reviews);

  // Adapt and filter suggestions before posting
  actionableSuggestions = FeedbackLearning.adapt(repoId, actionableSuggestions);

  // Filter out already-resolved suggestions
  if (actionableSuggestions.length > 0) {
    actionableSuggestions = await filterResolvedSuggestions(
      octokit, owner, repo, pullNumber, actionableSuggestions
    );
  }

  const combinedReview = buildCombinedReview(
    reviews,
    chunks.length,
    actionableSuggestions.length,
    coverageWarning
  );

  const body = buildCommentBody(reviewerName, combinedReview);

  await upsertReviewComment(octokit, owner, repo, pullNumber, body);

  // Inline suggestion integration
  if (actionableSuggestions.length > 0) {
    try {
      // Fetch existing comment threads for threading support
      let existingThreads = null;
      try {
        existingThreads = await getExistingCommentThreads(octokit, owner, repo, pullNumber);
      } catch (err) {
        core.warning(`Could not fetch existing threads: ${err.message}`);
        existingThreads = new Map();
      }

      const postedSuggestions = await InlineSuggestion.postSuggestions(octokit, {
        owner,
        repo,
        pullNumber,
        suggestions: actionableSuggestions,
        existingThreads,
        headSha: context.payload.pull_request?.head?.sha,
        threadSimilarityThreshold,
      });

      if (postedSuggestions > 0) {
        core.info(`Posted ${postedSuggestions} inline suggestion(s).`);
      }
    } catch (err) {
      core.warning(`Inline suggestions skipped: ${err.message}`);
    }
  }

}

if (require.main === module) {
  run().catch(async err => {
    await loadActionsToolkit();
    core.setFailed(err.message);
  });
}

module.exports = {
  splitIntoChunks,
  matchesPattern,
  filterFiles,
  limitFilesByDiffChars,
  buildChunkPrompt,
  buildCombinedReview,
  buildChunkFailureWarning,
  buildCoverageWarning,
  buildCommentBody,
  extractActionableSuggestions,
  formatApiRequestLabel,
  formatChunkMergeSummary,
  formatSecurityFindingsForReview,
  filterResolvedSuggestions,
  calculateSimilarity,
  getExistingCommentThreads,
  findSimilarThread,
  callZaiApi,
  callZaiApiWithRetry,
  parseRetryAfter,
  isRetryableError,
  hashString,
  RETRY_CONFIG,
};

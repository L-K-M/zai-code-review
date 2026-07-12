/******/ (() => { // webpackBootstrap
/******/ 	var __webpack_modules__ = ({

/***/ 5105:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {

/* module decorator */ module = __nccwpck_require__.nmd(module);
const https = __nccwpck_require__(5692);

const ConversationalFeedback = __nccwpck_require__(9565);
const InlineSuggestion = __nccwpck_require__(9829);
const FeedbackLearning = __nccwpck_require__(9161);
const SecurityCheck = __nccwpck_require__(7432);
const { calculateSimilarity, findSimilarThread } = __nccwpck_require__(8943);

let core;
let github;

async function loadActionsToolkit() {
  if (!core || !github) {
    [core, github] = await Promise.all([
      Promise.all(/* import() */[__nccwpck_require__.e(119), __nccwpck_require__.e(421)]).then(__nccwpck_require__.bind(__nccwpck_require__, 6421)),
      Promise.all(/* import() */[__nccwpck_require__.e(119), __nccwpck_require__.e(157)]).then(__nccwpck_require__.bind(__nccwpck_require__, 157)),
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

if (__nccwpck_require__.c[__nccwpck_require__.s] === module) {
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


/***/ }),

/***/ 9565:
/***/ ((module) => {

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


/***/ }),

/***/ 9161:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {


const fs = __nccwpck_require__(9896);
const path = __nccwpck_require__(6928);

// FeedbackLearning: Tracks user responses to suggestions and adapts future reviews
// Stores preferences per repo/team in .zai-feedback.json in project root
class FeedbackLearning {
  constructor(repoId) {
    this.repoId = repoId;
    this.dataFile = path.resolve(process.cwd(), '.zai-feedback.json');
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.dataFile)) {
        const raw = fs.readFileSync(this.dataFile, 'utf8');
        this.data = JSON.parse(raw);
      } else {
        this.data = {};
      }
    } catch (e) {
      this.data = {};
    }
    if (!this.data[this.repoId]) this.data[this.repoId] = { accepted: {}, rejected: {} };
  }

  _save() {
    fs.writeFileSync(this.dataFile, JSON.stringify(this.data, null, 2));
  }

  recordFeedback(suggestionId, accepted) {
    if (!suggestionId) return;
    const pref = this.data[this.repoId];
    if (accepted) {
      pref.accepted[suggestionId] = (pref.accepted[suggestionId] || 0) + 1;
      delete pref.rejected[suggestionId];
    } else {
      pref.rejected[suggestionId] = (pref.rejected[suggestionId] || 0) + 1;
      delete pref.accepted[suggestionId];
    }
    this._save();
  }

  getPreference(suggestionId) {
    const pref = this.data[this.repoId];
    if (pref.accepted[suggestionId]) return 'accepted';
    if (pref.rejected[suggestionId]) return 'rejected';
    return null;
  }

  // Optionally: adapt suggestions based on feedback
  adaptSuggestions(suggestions) {
    return suggestions.filter(s => this.getPreference(s.id) !== 'rejected');
  }

  static learnFromFeedback(repoId, suggestionId, accepted) {
    const learner = new FeedbackLearning(repoId);
    learner.recordFeedback(suggestionId, accepted);
  }

  static adapt(repoId, suggestions) {
    const learner = new FeedbackLearning(repoId);
    return learner.adaptSuggestions(suggestions);
  }
}

module.exports = FeedbackLearning;


/***/ }),

/***/ 9829:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {

// Handles inline suggestion logic for code review

const { findSimilarThread } = __nccwpck_require__(8943);

class InlineSuggestion {
  static buildComments(suggestions) {
    return (suggestions || [])
      .filter(s => s.suggestion && Number.isInteger(s.line) && s.line > 0)
      .map(s => ({
        path: s.path,
        body: `${s.body}\n\`\`\`suggestion\n${s.suggestion}\n\`\`\``,
        line: s.line,
        side: s.side || 'RIGHT',
      }));
  }

  static isValidationError(err) {
    return err?.status === 422 || /validation/i.test(err?.message || '');
  }

  /**
   * Posts actionable, line-specific suggestions as a GitHub review
   * @param {object} octokit - Authenticated Octokit instance
   * @param {object} params
   *   owner: repo owner
   *   repo: repo name
   *   pullNumber: PR number
   *   suggestions: Array<{ path, body, line, side, suggestion }>
   *   existingThreads: optional Map of existing comment threads for threading support
   *   headSha: optional commit SHA for new comments
   *   threadSimilarityThreshold: optional similarity threshold for thread matching (default: 0.6)
   */
  static async postSuggestions(octokit, { owner, repo, pullNumber, suggestions, existingThreads = null, headSha = null, threadSimilarityThreshold = 0.6 }) {
    const comments = InlineSuggestion.buildComments(suggestions);

    if (comments.length === 0) {
      return 0;
    }

    // If existingThreads provided, skip bulk post and go straight to individual with threading
    if (existingThreads && existingThreads.size > 0) {
      // Post individually with threading support
      let postedCount = 0;
      const repliedCommentIds = new Set();
      for (const comment of comments) {
        try {
          const key = `${comment.path}:${comment.line}`;
          const existing = existingThreads.get(key);
          let existingComment = null;

          if (existing && existing.length > 0) {
            // Use similarity matching to find the best thread
            const suggestionObj = {
              path: comment.path,
              line: comment.line,
              body: comment.body.replace(/\n```suggestion[\s\S]*$/, ''),
            };
            existingComment = findSimilarThread(existingThreads, suggestionObj, threadSimilarityThreshold);
            if (existingComment && repliedCommentIds.has(existingComment.id)) {
              existingComment = null;
            }
          }

          if (existingComment && headSha) {
            // Reply to existing thread
            try {
              await octokit.rest.pulls.createReplyForReviewComment({
                owner,
                repo,
                pull_number: pullNumber,
                comment_id: existingComment.id,
                body: `Additional context: ${comment.body}`,
              });
              repliedCommentIds.add(existingComment.id);
              postedCount++;
            } catch (replyErr) {
              // Fall back to new comment if reply fails
              await octokit.rest.pulls.createReview({
                owner,
                repo,
                pull_number: pullNumber,
                event: 'COMMENT',
                comments: [comment],
              });
              postedCount++;
            }
          } else {
            // Post as new comment
            await octokit.rest.pulls.createReview({
              owner,
              repo,
              pull_number: pullNumber,
              event: 'COMMENT',
              comments: [comment],
            });
            postedCount++;
          }
        } catch (err) {
          if (!InlineSuggestion.isValidationError(err)) {
            throw err;
          }
        }
      }
      return postedCount;
    }

    // Try bulk post first (for performance when no threading)
    try {
      await octokit.rest.pulls.createReview({
        owner,
        repo,
        pull_number: pullNumber,
        event: 'COMMENT',
        comments,
      });
      return comments.length;
    } catch (err) {
      if (comments.length === 1 || !InlineSuggestion.isValidationError(err)) {
        throw err;
      }
    }

    // Fall back to individual posting
    let postedCount = 0;
    for (const comment of comments) {
      try {
        await octokit.rest.pulls.createReview({
          owner,
          repo,
          pull_number: pullNumber,
          event: 'COMMENT',
          comments: [comment],
        });
        postedCount++;
      } catch (err) {
        if (!InlineSuggestion.isValidationError(err)) {
          throw err;
        }
      }
    }

    return postedCount;
  }
}

module.exports = InlineSuggestion;


/***/ }),

/***/ 7432:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {

const fs = __nccwpck_require__(9896);
const path = __nccwpck_require__(6928);

// Handles security check logic for code review
class SecurityCheck {
  /**
   * Loads custom security patterns from .zai-review.yaml configuration file
   * @param {string} workspaceRoot - Root directory to search for config file
   * @returns {Array} Array of custom pattern objects: { pattern, message, severity }
   */
  static loadCustomPatterns(workspaceRoot) {
    const configPath = path.join(workspaceRoot, '.zai-review.yaml');
    
    if (!fs.existsSync(configPath)) {
      return [];
    }

    try {
      const configContent = fs.readFileSync(configPath, 'utf8');
      const patterns = SecurityCheck.parseYamlSecurityPatterns(configContent);
      return patterns || [];
    } catch (err) {
      // Fail silently if config file cannot be read or parsed
      // This ensures the action continues with built-in patterns only
      return [];
    }
  }

  /**
   * Simple YAML parser for security_patterns section
   * @param {string} yamlContent - Raw YAML content
   * @returns {Array|null} Parsed patterns array or null if not found
   * @private
   */
  static parseYamlSecurityPatterns(yamlContent) {
    if (!yamlContent || typeof yamlContent !== 'string') {
      return null;
    }

    const lines = yamlContent.split('\n');
    const patterns = [];
    let inSecurityPatterns = false;
    let currentItem = null;

    for (const line of lines) {
      // Check for security_patterns section
      if (/^security_patterns:\s*$/.test(line.trim())) {
        inSecurityPatterns = true;
        continue;
      }

      if (!inSecurityPatterns) continue;

      // Check for end of section (new top-level key)
      if (/^[a-z_]+:\s*$/.test(line.trim()) && !line.startsWith(' ')) {
        if (currentItem) {
          patterns.push(currentItem);
          currentItem = null;
        }
        inSecurityPatterns = false;
        continue;
      }

      // Parse list item start (- pattern: ...)
      const patternMatch = line.match(/^\s*-\s*pattern:\s*(.+?)\s*$/);
      if (patternMatch) {
        if (currentItem) {
          patterns.push(currentItem);
        }
        currentItem = {
          pattern: patternMatch[1].replace(/^['"]|['"]$/g, ''),
          message: '',
          severity: 'medium',
        };
        continue;
      }

      // Parse message field
      const messageMatch = line.match(/^\s*message:\s*(.+?)\s*$/);
      if (messageMatch && currentItem) {
        currentItem.message = messageMatch[1].replace(/^['"]|['"]$/g, '');
        continue;
      }

      // Parse severity field
      const severityMatch = line.match(/^\s*severity:\s*(.+?)\s*$/);
      if (severityMatch && currentItem) {
        currentItem.severity = SecurityCheck.categorizeSeverity(severityMatch[1]);
        continue;
      }
    }

    // Don't forget the last item
    if (currentItem) {
      patterns.push(currentItem);
    }

    return patterns.length > 0 ? patterns : null;
  }

  /**
   * Maps severity labels to standard severity levels
   * @param {string} severity - Raw severity string from config
   * @returns {string} Normalized severity: 'high', 'medium', or 'low'
   * @private
   */
  static categorizeSeverity(severity) {
    if (!severity) return 'medium';
    
    const normalized = severity.toLowerCase().trim();
    
    // Map various severity labels to standard levels
    if (['critical', 'blocker', 'high', 'error'].includes(normalized)) {
      return 'high';
    }
    if (['major', 'medium', 'warning', 'warn'].includes(normalized)) {
      return 'medium';
    }
    if (['minor', 'low', 'info', 'information'].includes(normalized)) {
      return 'low';
    }
    
    return 'medium';
  }

  /**
   * Runs static analysis and best-practice checks on diffs
   * @param {Array} files - PR files (with patch, filename, status)
   * @param {Array} customPatterns - Optional array of custom pattern objects
   * @returns {Array} Array of security findings: { path, line, message, severity }
   */
  static checkSecurity(files, customPatterns = []) {
    const findings = [];
    if (!Array.isArray(files)) return findings;

    // Combine built-in and custom patterns
    const allPatterns = [...SecurityCheck.getBuiltInPatterns(), ...customPatterns];

    for (const file of files) {
      if (!file.patch || !file.filename) continue;
      const lines = file.patch.split('\n');
      let lineNum = 0;
      for (const line of lines) {
        // Parse diff hunk headers to get actual file line numbers
        const hunkMatch = line.match(/^@@\s+-\d+(?:,\d+)?\s+\+(\d+)/);
        if (hunkMatch) {
          lineNum = parseInt(hunkMatch[1], 10) - 1;
          continue;
        }

        // Track line numbers for context and added lines (not removed)
        if (!line.startsWith('-')) {
          lineNum++;
        }

        // Only analyze added lines
        if (!line.startsWith('+') || line.startsWith('+++')) continue;
        const code = line.slice(1);

        // Check against all patterns
        for (const patternConfig of allPatterns) {
          try {
            const regex = new RegExp(patternConfig.pattern, 'i');
            if (regex.test(code)) {
              findings.push({
                path: file.filename,
                line: lineNum,
                message: patternConfig.message,
                severity: patternConfig.severity,
              });
              // Only report first matching pattern per line
              break;
            }
          } catch (regexErr) {
            // Skip invalid regex patterns silently
          }
        }
      }
    }
    return findings;
  }

  /**
   * Returns built-in security patterns
   * @returns {Array} Array of built-in pattern objects
   * @private
   */
  static getBuiltInPatterns() {
    return [
      {
        pattern: '([\'"]?api[_-]?key[\'"]?\\s*[:=]\\s*[\'"][A-Za-z0-9\\-_]{16,}[\'"]|[\'"]?secret[\'"]?\\s*[:=]\\s*[\'"][A-Za-z0-9\\-_]{8,}[\'"])',
        message: 'Possible hardcoded secret or API key.',
        severity: 'high',
      },
      {
        pattern: '\\beval\\s*\\(',
        message: 'Use of eval() detected. This is unsafe and should be avoided.',
        severity: 'high',
      },
      {
        pattern: 'password\\s*[:=]\\s*[\'"][^\'"]{0,7}[\'"]',
        message: 'Possible weak or hardcoded password.',
        severity: 'high',
      },
      {
        pattern: 'eslint-disable|tslint:disable|security-disable',
        message: 'Lint or security checks disabled in code.',
        severity: 'medium',
      },
      {
        pattern: '\\b(require\\([\'"]child_process[\'"]\\)|exec\\s*\\(|new Function\\s*\\()',
        message: 'Dangerous function usage (exec, Function constructor, child_process).',
        severity: 'high',
      },
    ];
  }
}

module.exports = SecurityCheck;
module.exports.loadCustomPatterns = SecurityCheck.loadCustomPatterns;
module.exports.parseYamlSecurityPatterns = SecurityCheck.parseYamlSecurityPatterns;
module.exports.categorizeSeverity = SecurityCheck.categorizeSeverity;


/***/ }),

/***/ 8943:
/***/ ((module) => {

function calculateSimilarity(str1, str2) {
  const words1 = new Set(str1.split(/\s+/).filter(w => w.length > 0));
  const words2 = new Set(str2.split(/\s+/).filter(w => w.length > 0));
  const intersection = [...words1].filter(w => words2.has(w));
  const union = new Set([...words1, ...words2]);
  return union.size === 0 ? 0 : intersection.length / union.size;
}

function findSimilarThread(threads, suggestion, threshold = 0.6) {
  const key = `${suggestion.path}:${suggestion.line}`;
  const existing = threads.get(key);

  if (!existing || existing.length === 0) {
    return null;
  }

  for (const comment of existing) {
    const commentBody = (comment.body || '').replace(/\n```suggestion[\s\S]*$/, '');
    const similarity = calculateSimilarity(
      suggestion.body.toLowerCase(),
      commentBody.toLowerCase()
    );
    if (similarity > threshold) {
      return comment;
    }
  }
  return null;
}

module.exports = {
  calculateSimilarity,
  findSimilarThread,
};


/***/ }),

/***/ 2613:
/***/ ((module) => {

"use strict";
module.exports = require("assert");

/***/ }),

/***/ 5317:
/***/ ((module) => {

"use strict";
module.exports = require("child_process");

/***/ }),

/***/ 6982:
/***/ ((module) => {

"use strict";
module.exports = require("crypto");

/***/ }),

/***/ 4434:
/***/ ((module) => {

"use strict";
module.exports = require("events");

/***/ }),

/***/ 9896:
/***/ ((module) => {

"use strict";
module.exports = require("fs");

/***/ }),

/***/ 8611:
/***/ ((module) => {

"use strict";
module.exports = require("http");

/***/ }),

/***/ 5692:
/***/ ((module) => {

"use strict";
module.exports = require("https");

/***/ }),

/***/ 9278:
/***/ ((module) => {

"use strict";
module.exports = require("net");

/***/ }),

/***/ 4589:
/***/ ((module) => {

"use strict";
module.exports = require("node:assert");

/***/ }),

/***/ 6698:
/***/ ((module) => {

"use strict";
module.exports = require("node:async_hooks");

/***/ }),

/***/ 4573:
/***/ ((module) => {

"use strict";
module.exports = require("node:buffer");

/***/ }),

/***/ 7540:
/***/ ((module) => {

"use strict";
module.exports = require("node:console");

/***/ }),

/***/ 7598:
/***/ ((module) => {

"use strict";
module.exports = require("node:crypto");

/***/ }),

/***/ 3053:
/***/ ((module) => {

"use strict";
module.exports = require("node:diagnostics_channel");

/***/ }),

/***/ 610:
/***/ ((module) => {

"use strict";
module.exports = require("node:dns");

/***/ }),

/***/ 8474:
/***/ ((module) => {

"use strict";
module.exports = require("node:events");

/***/ }),

/***/ 7067:
/***/ ((module) => {

"use strict";
module.exports = require("node:http");

/***/ }),

/***/ 2467:
/***/ ((module) => {

"use strict";
module.exports = require("node:http2");

/***/ }),

/***/ 7030:
/***/ ((module) => {

"use strict";
module.exports = require("node:net");

/***/ }),

/***/ 643:
/***/ ((module) => {

"use strict";
module.exports = require("node:perf_hooks");

/***/ }),

/***/ 1792:
/***/ ((module) => {

"use strict";
module.exports = require("node:querystring");

/***/ }),

/***/ 7075:
/***/ ((module) => {

"use strict";
module.exports = require("node:stream");

/***/ }),

/***/ 1692:
/***/ ((module) => {

"use strict";
module.exports = require("node:tls");

/***/ }),

/***/ 3136:
/***/ ((module) => {

"use strict";
module.exports = require("node:url");

/***/ }),

/***/ 7975:
/***/ ((module) => {

"use strict";
module.exports = require("node:util");

/***/ }),

/***/ 3429:
/***/ ((module) => {

"use strict";
module.exports = require("node:util/types");

/***/ }),

/***/ 5919:
/***/ ((module) => {

"use strict";
module.exports = require("node:worker_threads");

/***/ }),

/***/ 8522:
/***/ ((module) => {

"use strict";
module.exports = require("node:zlib");

/***/ }),

/***/ 857:
/***/ ((module) => {

"use strict";
module.exports = require("os");

/***/ }),

/***/ 6928:
/***/ ((module) => {

"use strict";
module.exports = require("path");

/***/ }),

/***/ 3193:
/***/ ((module) => {

"use strict";
module.exports = require("string_decoder");

/***/ }),

/***/ 3557:
/***/ ((module) => {

"use strict";
module.exports = require("timers");

/***/ }),

/***/ 4756:
/***/ ((module) => {

"use strict";
module.exports = require("tls");

/***/ }),

/***/ 9023:
/***/ ((module) => {

"use strict";
module.exports = require("util");

/***/ })

/******/ 	});
/************************************************************************/
/******/ 	// The module cache
/******/ 	var __webpack_module_cache__ = {};
/******/ 	
/******/ 	// The require function
/******/ 	function __nccwpck_require__(moduleId) {
/******/ 		// Check if module is in cache
/******/ 		var cachedModule = __webpack_module_cache__[moduleId];
/******/ 		if (cachedModule !== undefined) {
/******/ 			return cachedModule.exports;
/******/ 		}
/******/ 		// Create a new module (and put it into the cache)
/******/ 		var module = __webpack_module_cache__[moduleId] = {
/******/ 			id: moduleId,
/******/ 			loaded: false,
/******/ 			exports: {}
/******/ 		};
/******/ 	
/******/ 		// Execute the module function
/******/ 		var threw = true;
/******/ 		try {
/******/ 			__webpack_modules__[moduleId].call(module.exports, module, module.exports, __nccwpck_require__);
/******/ 			threw = false;
/******/ 		} finally {
/******/ 			if(threw) delete __webpack_module_cache__[moduleId];
/******/ 		}
/******/ 	
/******/ 		// Flag the module as loaded
/******/ 		module.loaded = true;
/******/ 	
/******/ 		// Return the exports of the module
/******/ 		return module.exports;
/******/ 	}
/******/ 	
/******/ 	// expose the modules object (__webpack_modules__)
/******/ 	__nccwpck_require__.m = __webpack_modules__;
/******/ 	
/******/ 	// expose the module cache
/******/ 	__nccwpck_require__.c = __webpack_module_cache__;
/******/ 	
/************************************************************************/
/******/ 	/* webpack/runtime/create fake namespace object */
/******/ 	(() => {
/******/ 		var getProto = Object.getPrototypeOf ? (obj) => (Object.getPrototypeOf(obj)) : (obj) => (obj.__proto__);
/******/ 		var leafPrototypes;
/******/ 		// create a fake namespace object
/******/ 		// mode & 1: value is a module id, require it
/******/ 		// mode & 2: merge all properties of value into the ns
/******/ 		// mode & 4: return value when already ns object
/******/ 		// mode & 16: return value when it's Promise-like
/******/ 		// mode & 8|1: behave like require
/******/ 		__nccwpck_require__.t = function(value, mode) {
/******/ 			if(mode & 1) value = this(value);
/******/ 			if(mode & 8) return value;
/******/ 			if(typeof value === 'object' && value) {
/******/ 				if((mode & 4) && value.__esModule) return value;
/******/ 				if((mode & 16) && typeof value.then === 'function') return value;
/******/ 			}
/******/ 			var ns = Object.create(null);
/******/ 			__nccwpck_require__.r(ns);
/******/ 			var def = {};
/******/ 			leafPrototypes = leafPrototypes || [null, getProto({}), getProto([]), getProto(getProto)];
/******/ 			for(var current = mode & 2 && value; typeof current == 'object' && !~leafPrototypes.indexOf(current); current = getProto(current)) {
/******/ 				Object.getOwnPropertyNames(current).forEach((key) => (def[key] = () => (value[key])));
/******/ 			}
/******/ 			def['default'] = () => (value);
/******/ 			__nccwpck_require__.d(ns, def);
/******/ 			return ns;
/******/ 		};
/******/ 	})();
/******/ 	
/******/ 	/* webpack/runtime/define property getters */
/******/ 	(() => {
/******/ 		// define getter functions for harmony exports
/******/ 		__nccwpck_require__.d = (exports, definition) => {
/******/ 			for(var key in definition) {
/******/ 				if(__nccwpck_require__.o(definition, key) && !__nccwpck_require__.o(exports, key)) {
/******/ 					Object.defineProperty(exports, key, { enumerable: true, get: definition[key] });
/******/ 				}
/******/ 			}
/******/ 		};
/******/ 	})();
/******/ 	
/******/ 	/* webpack/runtime/ensure chunk */
/******/ 	(() => {
/******/ 		__nccwpck_require__.f = {};
/******/ 		// This file contains only the entry chunk.
/******/ 		// The chunk loading function for additional chunks
/******/ 		__nccwpck_require__.e = (chunkId) => {
/******/ 			return Promise.all(Object.keys(__nccwpck_require__.f).reduce((promises, key) => {
/******/ 				__nccwpck_require__.f[key](chunkId, promises);
/******/ 				return promises;
/******/ 			}, []));
/******/ 		};
/******/ 	})();
/******/ 	
/******/ 	/* webpack/runtime/get javascript chunk filename */
/******/ 	(() => {
/******/ 		// This function allow to reference async chunks
/******/ 		__nccwpck_require__.u = (chunkId) => {
/******/ 			// return url for filenames based on template
/******/ 			return "" + chunkId + ".index.js";
/******/ 		};
/******/ 	})();
/******/ 	
/******/ 	/* webpack/runtime/hasOwnProperty shorthand */
/******/ 	(() => {
/******/ 		__nccwpck_require__.o = (obj, prop) => (Object.prototype.hasOwnProperty.call(obj, prop))
/******/ 	})();
/******/ 	
/******/ 	/* webpack/runtime/make namespace object */
/******/ 	(() => {
/******/ 		// define __esModule on exports
/******/ 		__nccwpck_require__.r = (exports) => {
/******/ 			if(typeof Symbol !== 'undefined' && Symbol.toStringTag) {
/******/ 				Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
/******/ 			}
/******/ 			Object.defineProperty(exports, '__esModule', { value: true });
/******/ 		};
/******/ 	})();
/******/ 	
/******/ 	/* webpack/runtime/node module decorator */
/******/ 	(() => {
/******/ 		__nccwpck_require__.nmd = (module) => {
/******/ 			module.paths = [];
/******/ 			if (!module.children) module.children = [];
/******/ 			return module;
/******/ 		};
/******/ 	})();
/******/ 	
/******/ 	/* webpack/runtime/compat */
/******/ 	
/******/ 	if (typeof __nccwpck_require__ !== 'undefined') __nccwpck_require__.ab = __dirname + "/";
/******/ 	
/******/ 	/* webpack/runtime/require chunk loading */
/******/ 	(() => {
/******/ 		// no baseURI
/******/ 		
/******/ 		// object to store loaded chunks
/******/ 		// "1" means "loaded", otherwise not loaded yet
/******/ 		var installedChunks = {
/******/ 			792: 1
/******/ 		};
/******/ 		
/******/ 		// no on chunks loaded
/******/ 		
/******/ 		var installChunk = (chunk) => {
/******/ 			var moreModules = chunk.modules, chunkIds = chunk.ids, runtime = chunk.runtime;
/******/ 			for(var moduleId in moreModules) {
/******/ 				if(__nccwpck_require__.o(moreModules, moduleId)) {
/******/ 					__nccwpck_require__.m[moduleId] = moreModules[moduleId];
/******/ 				}
/******/ 			}
/******/ 			if(runtime) runtime(__nccwpck_require__);
/******/ 			for(var i = 0; i < chunkIds.length; i++)
/******/ 				installedChunks[chunkIds[i]] = 1;
/******/ 		
/******/ 		};
/******/ 		
/******/ 		// require() chunk loading for javascript
/******/ 		__nccwpck_require__.f.require = (chunkId, promises) => {
/******/ 			// "1" is the signal for "already loaded"
/******/ 			if(!installedChunks[chunkId]) {
/******/ 				if(true) { // all chunks have JS
/******/ 					installChunk(require("./" + __nccwpck_require__.u(chunkId)));
/******/ 				} else installedChunks[chunkId] = 1;
/******/ 			}
/******/ 		};
/******/ 		
/******/ 		// no external install chunk
/******/ 		
/******/ 		// no HMR
/******/ 		
/******/ 		// no HMR manifest
/******/ 	})();
/******/ 	
/************************************************************************/
/******/ 	
/******/ 	// module cache are used so entry inlining is disabled
/******/ 	// startup
/******/ 	// Load entry module and return exports
/******/ 	var __webpack_exports__ = __nccwpck_require__(__nccwpck_require__.s = 5105);
/******/ 	module.exports = __webpack_exports__;
/******/ 	
/******/ })()
;
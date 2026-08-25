const https = require('https');

const ConversationalFeedback = require('./review/ConversationalFeedback');
const InlineSuggestion = require('./review/InlineSuggestion');
const FeedbackLearning = require('./review/FeedbackLearning');
const SecurityCheck = require('./review/SecurityCheck');
const { calculateSimilarity, findSimilarThread } = require('./review/ThreadSimilarity');
const {
  normalizeReviewMode,
  resolveReviewMode,
  parseReviewState,
  buildReviewStateMarker,
  selectRotatingAuditFiles,
  buildScopeNotice,
} = require('./review/ReviewScope');

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
const DEFAULT_REQUEST_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_MAX_OUTPUT_TOKENS = 32768;
const DEFAULT_REASONING_EFFORT = 'high';
const PER_PAGE = 100;
const DEFAULT_MAX_CHUNK_SIZE = 25000;
const MIN_FALLBACK_CHUNK_SIZE = 4000;
const DEFAULT_UNCHANGED_AUDIT_CHARS = 25000;
const MAX_COMPARE_FILES = 300;
const MAX_LISTED_FILES = 20;
const RETRY_CONFIG = {
  maxRetries: 3,
  baseDelayMs: 15000,
  maxDelayMs: 60000,
  jitterRatio: 0.2,
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
    const { data, headers } = await octokit.rest.pulls.listFiles({
      owner,
      repo,
      pull_number: pullNumber,
      per_page: PER_PAGE,
      limit: PER_PAGE,
      page,
    });
    files.push(...data);
    const hasNextPage = /<[^>]+>;\s*rel="?next"?/i.test(headers?.link || '');
    if (!hasNextPage && data.length < PER_PAGE) break;
    page++;
  }

  if (files.length === 0 || files.some(file => Object.hasOwn(file, 'patch'))) {
    return files;
  }

  try {
    const { data } = await octokit.request(
      'GET /repos/{owner}/{repo}/pulls/{pull_number}.diff',
      { owner, repo, pull_number: pullNumber }
    );
    return hydratePatchesFromUnifiedDiff(files, data);
  } catch (err) {
    core.warning(`Could not fetch the pull request diff: ${err.message}`);
    return files;
  }
}

async function getIncrementalFiles(octokit, owner, repo, baseSha, headSha) {
  try {
    const { data } = await octokit.rest.repos.compareCommitsWithBasehead({
      owner,
      repo,
      basehead: `${baseSha}...${headSha}`,
      per_page: PER_PAGE,
    });
    if (!['ahead', 'identical'].includes(data.status)) {
      return {
        safe: false,
        files: [],
        reason: `the previous reviewed commit is ${data.status || 'not an ancestor'}`,
      };
    }
    if ((data.files || []).length >= MAX_COMPARE_FILES) {
      return {
        safe: false,
        files: [],
        reason: `the incremental comparison reached GitHub's ${MAX_COMPARE_FILES}-file limit`,
      };
    }
    return { safe: true, files: data.files || [], reason: '' };
  } catch (err) {
    core?.warning(`Could not compare the previous reviewed commit: ${err.message}`);
    return { safe: false, files: [], reason: 'the incremental comparison failed' };
  }
}

function hydratePatchesFromUnifiedDiff(files, diff) {
  if (typeof diff !== 'string' || !diff.startsWith('diff --git ')) {
    return files;
  }

  const sections = diff
    .split(/^diff --git /m)
    .slice(1)
    .map(section => `diff --git ${section}`);

  // File metadata and diff sections use the same git-diff order. Refuse to
  // associate them when the provider returns an unexpected representation.
  if (sections.length !== files.length) {
    return files;
  }

  return files.map((file, index) => {
    const hunk = sections[index].match(/^@@[^\n]*(?:\n|$)/m);
    return hunk ? { ...file, patch: sections[index].slice(hunk.index).trimEnd() } : file;
  });
}

function splitPatchAtLineBoundary(patch, maxChunkSize) {
  const parts = [];
  let offset = 0;

  while (offset < patch.length) {
    let end = Math.min(offset + maxChunkSize, patch.length);
    if (end < patch.length) {
      const newline = patch.lastIndexOf('\n', end);
      if (newline > offset + Math.floor(maxChunkSize / 2)) {
        end = newline + 1;
      }
    }
    parts.push(patch.slice(offset, end));
    offset = end;
  }

  return parts;
}

function expandOversizedFiles(files, maxChunkSize) {
  return files.flatMap(file => {
    if (!file.patch || file.patch.length <= maxChunkSize) {
      return [file];
    }

    const parts = splitPatchAtLineBoundary(file.patch, maxChunkSize);
    return parts.map((patch, index) => ({
      ...file,
      patch,
      splitPart: index + 1,
      splitTotal: parts.length,
      originalPatchLength: file.patch.length,
    }));
  });
}

function splitIntoChunks(files, maxChunkSize = DEFAULT_MAX_CHUNK_SIZE) {
  const boundedChunkSize = Number.isInteger(maxChunkSize) && maxChunkSize > 0
    ? maxChunkSize
    : DEFAULT_MAX_CHUNK_SIZE;
  const filesWithPatches = expandOversizedFiles(
    files.filter(f => f.patch),
    boundedChunkSize
  );

  if (filesWithPatches.length === 0) return [];

  const chunks = [];
  let currentChunk = [];
  let currentSize = 0;

  for (const file of filesWithPatches) {
    const fileSize = file.patch.length;

    if (currentSize + fileSize > boundedChunkSize && currentChunk.length > 0) {
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
    details.push(`truncated to the configured per-request limit: ${formatFileList(truncatedFiles)}`);
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

function buildCommentBody(reviewerName, review, reviewState = null) {
  const safeReviewerName = String(reviewerName || 'Z.ai Code Review').slice(0, 200);
  const prefix = `## ${safeReviewerName}\n\n`;
  const stateMarker = buildReviewStateMarker(reviewState);
  const suffix = `\n\n${stateMarker ? `${stateMarker}\n` : ''}${COMMENT_MARKER}`;
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

function supportsReasoningEffort(model) {
  return /^glm-5\.(?:2|3)(?:$|-)/i.test(model || '');
}

function buildZaiRequestBody(model, systemPrompt, prompt, apiOptions = {}) {
  const reasoningEffort = apiOptions.reasoningEffort || DEFAULT_REASONING_EFFORT;
  const maxOutputTokens = apiOptions.maxOutputTokens || DEFAULT_MAX_OUTPUT_TOKENS;
  const body = {
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
    stream: true,
    max_tokens: maxOutputTokens,
  };

  if (supportsReasoningEffort(model)) {
    body.reasoning_effort = reasoningEffort;
  }

  return body;
}

function parseSseEventData(event) {
  const payload = event
    .split(/\r?\n/)
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trimStart())
    .join('\n');

  if (!payload) {
    return { content: '', reasoningContent: '', finishReason: '', done: false };
  }
  if (payload.trim() === '[DONE]') {
    return { content: '', reasoningContent: '', finishReason: '', done: true };
  }

  let parsed;
  try {
    parsed = JSON.parse(payload);
  } catch (err) {
    throw new Error(`${ERR_PREFIX}Invalid streaming response.`);
  }

  if (parsed.error) {
    throw new Error(`${ERR_PREFIX}Streaming request failed.`);
  }

  const choice = parsed.choices?.[0];
  return {
    content: choice?.delta?.content || '',
    reasoningContent: choice?.delta?.reasoning_content || '',
    finishReason: choice?.finish_reason || '',
    usage: parsed.usage,
    done: false,
  };
}

function getStreamCompletionError({ sawDone, finishReason, content, completionSummary }) {
  if (!sawDone) {
    const error = new Error(`${ERR_PREFIX}Streaming response ended before completion.`);
    error.code = 'ZAI_STREAM_INCOMPLETE';
    return error;
  }
  if (finishReason === 'length') {
    const error = new Error(
      `${ERR_PREFIX}Output token limit reached before the review completed (${completionSummary}).`
    );
    error.code = 'ZAI_OUTPUT_LIMIT';
    return error;
  }
  if (!content) {
    return new Error(`${ERR_PREFIX}Empty response body (${completionSummary}).`);
  }
  return null;
}

function callZaiApi(apiKey, model, systemPrompt, prompt, apiOptions = {}) {
  return new Promise((resolve, reject) => {
    const requestStartedAt = Date.now();
    const requestTimeoutMs = apiOptions.requestTimeoutMs || DEFAULT_REQUEST_TIMEOUT_MS;
    const body = JSON.stringify(buildZaiRequestBody(model, systemPrompt, prompt, apiOptions));
    const url = new URL(ZAI_API_URL);
    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Accept': 'text/event-stream',
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, res => {
      const successful = res.statusCode >= 200 && res.statusCode < 300;
      const streaming = successful && /text\/event-stream/i.test(res.headers['content-type'] || '');
      let data = '';
      let streamedContent = '';
      let sawDone = false;
      let finishReason = '';
      let usage;
      let reasoningChars = 0;
      let firstTokenAt;
      const requestId = res.headers['x-request-id'] || res.headers['x-zai-request-id'] || '';

      res.on('data', chunk => {
        data += chunk.toString('utf8');
        if (data.length > MAX_RESPONSE_SIZE) {
          req.destroy(new Error(`${ERR_PREFIX}Response exceeded size limit.`));
          return;
        }

        if (!streaming) {
          return;
        }

        let boundary;
        while ((boundary = data.search(/\r?\n\r?\n/)) !== -1) {
          const event = data.slice(0, boundary);
          const separator = data.slice(boundary).match(/^\r?\n\r?\n/)[0];
          data = data.slice(boundary + separator.length);
          let parsed;
          try {
            parsed = parseSseEventData(event);
          } catch (err) {
            req.destroy(err);
            return;
          }
          streamedContent += parsed.content;
          reasoningChars += (parsed.reasoningContent || '').length;
          sawDone ||= parsed.done;
          finishReason = parsed.finishReason || finishReason;
          usage = parsed.usage || usage;
          if (!firstTokenAt && (parsed.content || parsed.reasoningContent)) {
            firstTokenAt = Date.now();
          }
          if (streamedContent.length > MAX_RESPONSE_SIZE) {
            req.destroy(new Error(`${ERR_PREFIX}Response exceeded size limit.`));
            return;
          }
        }
      });

      res.on('end', () => {
        if (!successful) {
          const error = new Error(`${ERR_PREFIX}HTTP ${res.statusCode}.`);
          error.statusCode = res.statusCode;
          error.retryAfterMs = parseRetryAfter(res.headers['retry-after']);
          reject(error);
          return;
        }

        if (streaming) {
          const requestIdLabel = requestId ? `, request ${requestId}` : '';
          const firstTokenLabel = firstTokenAt
            ? `, first token in ${firstTokenAt - requestStartedAt}ms`
            : '';
          const usageLabel = usage?.total_tokens ? `, ${usage.total_tokens} total tokens` : '';
          const finishLabel = finishReason ? `, finish ${finishReason}` : ', finish unknown';
          const completionSummary = `in ${Date.now() - requestStartedAt}ms${firstTokenLabel}, ${reasoningChars} reasoning chars, ${streamedContent.length} review chars${finishLabel}${usageLabel}${requestIdLabel}`;
          const completionError = getStreamCompletionError({
            sawDone,
            finishReason,
            content: streamedContent,
            completionSummary,
          });
          if (completionError) {
            reject(completionError);
            return;
          }
          core?.info(`Z.ai stream completed ${completionSummary}.`);
          resolve(streamedContent);
          return;
        }

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
      });
      res.on('aborted', () => {
        const error = new Error(`${ERR_PREFIX}Streaming response was aborted.`);
        error.code = 'ZAI_STREAM_INCOMPLETE';
        reject(error);
      });
      res.on('error', reject);
    });

    req.on('error', reject);
    req.setTimeout(requestTimeoutMs, () => {
      const error = new Error(`${ERR_PREFIX}Request timed out after ${Math.round(requestTimeoutMs / 1000)} seconds of inactivity.`);
      error.code = 'ZAI_REQUEST_TIMEOUT';
      req.destroy(error);
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

function isRequestTimeoutError(error) {
  return error?.code === 'ZAI_REQUEST_TIMEOUT';
}

function isOutputLimitError(error) {
  return error?.code === 'ZAI_OUTPUT_LIMIT';
}

function calculateRetryDelay(error, attempt, random = Math.random) {
  const exponentialDelay = RETRY_CONFIG.baseDelayMs * Math.pow(3, attempt);
  const requestedDelay = Math.max(exponentialDelay, error?.retryAfterMs || 0);
  const jitter = requestedDelay * RETRY_CONFIG.jitterRatio * random();
  return Math.min(Math.round(requestedDelay + jitter), RETRY_CONFIG.maxDelayMs);
}

async function callZaiApiWithRetry(
  apiKey,
  model,
  systemPrompt,
  prompt,
  requestLabel = 'request',
  apiOptions = {},
  retryOptions = {}
) {
  let lastError;
  const maxAttempts = retryOptions.maxAttempts || RETRY_CONFIG.maxRetries;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const attemptStartedAt = Date.now();
    try {
      return await callZaiApi(apiKey, model, systemPrompt, prompt, apiOptions);
    } catch (err) {
      lastError = err;
      const elapsedMs = Date.now() - attemptStartedAt;
      core?.info(
        `API call failed for ${requestLabel} (attempt ${attempt + 1}/${maxAttempts}) after ${elapsedMs}ms: ${err.message}`
      );

      if (!isRetryableError(err)) {
        throw err;
      }

      if (attempt < maxAttempts - 1) {
        const delayMs = calculateRetryDelay(err, attempt);
        core?.info(`Retrying ${requestLabel} in ${delayMs}ms...`);
        await new Promise(r => setTimeout(r, delayMs));
      }
    }
  }

  throw lastError;
}

async function retryAfterInitialFailure({
  initialError,
  apiKey,
  model,
  systemPrompt,
  prompt,
  requestLabel,
  apiOptions,
}) {
  let lastError = initialError;

  for (let attempt = 1; attempt < RETRY_CONFIG.maxRetries; attempt++) {
    const delayMs = calculateRetryDelay(lastError, attempt - 1);
    core?.info(`Retrying ${requestLabel} in ${delayMs}ms...`);
    await new Promise(r => setTimeout(r, delayMs));
    const attemptStartedAt = Date.now();
    try {
      return await callZaiApi(apiKey, model, systemPrompt, prompt, apiOptions);
    } catch (err) {
      lastError = err;
      const elapsedMs = Date.now() - attemptStartedAt;
      core?.info(
        `API call failed for ${requestLabel} (attempt ${attempt + 1}/${RETRY_CONFIG.maxRetries}) after ${elapsedMs}ms: ${err.message}`
      );
      if (!isRetryableError(err)) {
        throw err;
      }
    }
  }

  throw lastError;
}

function buildRequestLabel(files, chunkIndex, totalChunks) {
  return formatApiRequestLabel({
    chunkIndex,
    totalChunks,
    fileCount: files.length,
    truncatedFileCount: 0,
    patchChars: files.reduce((total, file) => total + (file.patch?.length || 0), 0),
    promptChars: ConversationalFeedback.buildPrompt(files, chunkIndex, totalChunks).length,
  });
}

async function reviewChunkWithAdaptiveSplit({
  apiKey,
  model,
  systemPrompt,
  files,
  chunkIndex,
  totalChunks,
  maxChunkSize,
  apiOptions,
  fallbackPath = '',
}) {
  const prompt = ConversationalFeedback.buildPrompt(files, chunkIndex, totalChunks);
  const baseRequestLabel = buildRequestLabel(files, chunkIndex, totalChunks);
  const requestLabel = fallbackPath
    ? `${baseRequestLabel}, fallback ${fallbackPath}`
    : baseRequestLabel;

  try {
    return await callZaiApiWithRetry(
      apiKey,
      model,
      systemPrompt,
      prompt,
      requestLabel,
      apiOptions,
      { maxAttempts: 1 }
    );
  } catch (err) {
    if (isRequestTimeoutError(err) || isOutputLimitError(err)) {
      const fallbackSize = Math.max(
        MIN_FALLBACK_CHUNK_SIZE,
        Math.floor(maxChunkSize / 2)
      );
      const fallbackChunks = splitIntoChunks(files, fallbackSize);

      if (fallbackChunks.length > 1) {
        const reason = isOutputLimitError(err) ? 'reached the output token limit' : 'timed out';
        core?.warning(
          `${requestLabel} ${reason}; retrying as ${fallbackChunks.length} smaller section(s) of at most ${fallbackSize} patch characters.`
        );
        const fallbackReviews = [];
        for (let index = 0; index < fallbackChunks.length; index++) {
          const childPath = fallbackPath
            ? `${fallbackPath}.${index + 1}/${fallbackChunks.length}`
            : `${index + 1}/${fallbackChunks.length}`;
          fallbackReviews.push(await reviewChunkWithAdaptiveSplit({
            apiKey,
            model,
            systemPrompt,
            files: fallbackChunks[index],
            chunkIndex,
            totalChunks,
            maxChunkSize: fallbackSize,
            apiOptions,
            fallbackPath: childPath,
          }));
        }
        return fallbackReviews.join('\n\n');
      }
    }

    if (!isRetryableError(err)) {
      throw err;
    }

    return retryAfterInitialFailure({
      initialError: err,
      apiKey,
      model,
      systemPrompt,
      prompt,
      requestLabel,
      apiOptions,
    });
  }
}

function parseBoundedInteger(value, fallback, minimum, maximum, inputName) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum) {
    return parsed;
  }
  if (value) {
    core?.warning(`${inputName} must be between ${minimum} and ${maximum}; using ${fallback}.`);
  }
  return fallback;
}

function normalizeReasoningEffort(value) {
  const normalized = (value || DEFAULT_REASONING_EFFORT).toLowerCase();
  if (['low', 'high', 'max'].includes(normalized)) {
    return normalized;
  }
  core?.warning(`ZAI_REASONING_EFFORT must be low, high, or max; using ${DEFAULT_REASONING_EFFORT}.`);
  return DEFAULT_REASONING_EFFORT;
}

async function determineReviewScope({
  octokit,
  owner,
  repo,
  requestedMode,
  previousState,
  headSha,
  fullFiles,
  auditChars,
}) {
  const fullScope = reason => ({
    files: fullFiles.map(file => ({ ...file, reviewScope: 'full' })),
    actualMode: 'full',
    requestedMode,
    reason,
    previousSha: previousState?.lastReviewedSha || '',
    headSha,
    deltaFileCount: fullFiles.length,
    auditFileCount: 0,
    nextAuditCursor: previousState?.auditCursor || 0,
  });

  if (requestedMode === 'full') return fullScope('');
  if (!previousState?.lastReviewedSha) {
    return fullScope(` ${requestedMode} mode is bootstrapping without prior completed state.`);
  }
  if (!headSha) {
    return fullScope(' The pull request head SHA is unavailable.');
  }

  const comparison = await getIncrementalFiles(
    octokit,
    owner,
    repo,
    previousState.lastReviewedSha,
    headSha
  );
  if (!comparison.safe) {
    return fullScope(` Full review fallback: ${comparison.reason}.`);
  }

  const fullMetadata = new Map(fullFiles.map(file => [file.filename, file]));
  const deltaFiles = comparison.files.map(file => ({
    ...(fullMetadata.get(file.filename) || {}),
    ...file,
    reviewScope: 'delta',
  }));
  if (requestedMode === 'incremental') {
    return {
      files: deltaFiles,
      actualMode: 'incremental',
      requestedMode,
      reason: '',
      previousSha: previousState.lastReviewedSha,
      headSha,
      deltaFileCount: deltaFiles.length,
      auditFileCount: 0,
      nextAuditCursor: previousState.auditCursor,
    };
  }

  const audit = selectRotatingAuditFiles(
    fullFiles,
    deltaFiles,
    auditChars,
    previousState.auditCursor
  );
  return {
    files: [...deltaFiles, ...audit.files],
    actualMode: 'hybrid',
    requestedMode,
    reason: '',
    previousSha: previousState.lastReviewedSha,
    headSha,
    deltaFileCount: deltaFiles.length,
    auditFileCount: audit.files.length,
    nextAuditCursor: audit.nextCursor,
  };
}

function buildNextReviewState(previousState, scope, headSha) {
  return {
    version: 1,
    lastReviewedSha: headSha,
    lastFullReviewSha: scope.actualMode === 'full'
      ? headSha
      : previousState?.lastFullReviewSha || '',
    auditCursor: scope.nextAuditCursor || 0,
    mode: scope.actualMode,
  };
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

async function upsertReviewComment(octokit, owner, repo, pullNumber, body, knownComments = null) {
  const comments = knownComments || await getIssueComments(octokit, owner, repo, pullNumber);
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
  const reasoningEffort = normalizeReasoningEffort(core.getInput('ZAI_REASONING_EFFORT'));
  const maxOutputTokens = parseBoundedInteger(
    core.getInput('ZAI_MAX_OUTPUT_TOKENS'),
    DEFAULT_MAX_OUTPUT_TOKENS,
    1024,
    131072,
    'ZAI_MAX_OUTPUT_TOKENS'
  );
  const requestTimeoutSeconds = parseBoundedInteger(
    core.getInput('ZAI_REQUEST_TIMEOUT_SECONDS'),
    DEFAULT_REQUEST_TIMEOUT_MS / 1000,
    60,
    3600,
    'ZAI_REQUEST_TIMEOUT_SECONDS'
  );
  const maxChunkSize = parseBoundedInteger(
    core.getInput('MAX_CHUNK_CHARS'),
    DEFAULT_MAX_CHUNK_SIZE,
    MIN_FALLBACK_CHUNK_SIZE,
    50000,
    'MAX_CHUNK_CHARS'
  );
  const configuredReviewMode = normalizeReviewMode(core.getInput('ZAI_REVIEW_MODE'));
  const rawAuditChars = Number.parseInt(core.getInput('ZAI_UNCHANGED_AUDIT_CHARS'), 10);
  const unchangedAuditChars = Number.isInteger(rawAuditChars)
    && rawAuditChars >= 0
    && rawAuditChars <= 50000
    ? rawAuditChars
    : DEFAULT_UNCHANGED_AUDIT_CHARS;
  if (core.getInput('ZAI_UNCHANGED_AUDIT_CHARS') && rawAuditChars !== unchangedAuditChars) {
    core.warning(
      `ZAI_UNCHANGED_AUDIT_CHARS must be between 0 and 50000; using ${DEFAULT_UNCHANGED_AUDIT_CHARS}.`
    );
  }
  const apiOptions = {
    reasoningEffort,
    maxOutputTokens,
    requestTimeoutMs: requestTimeoutSeconds * 1000,
  };
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
  const labels = context.payload.pull_request?.labels || [];
  const modeResolution = resolveReviewMode(configuredReviewMode, labels);
  if (modeResolution.labelModes.length > 1) {
    core.warning(
      `Conflicting Z.ai review mode labels (${modeResolution.labelModes.join(', ')}); using ${modeResolution.mode}.`
    );
  } else if (modeResolution.labelModes.length === 1) {
    core.info(`Review mode overridden by label: ${modeResolution.mode}.`);
  }

  // FeedbackLearning repoId: owner/repo
  const repoId = `${owner}/${repo}`;

  core.info(`Fetching changed files for PR #${pullNumber}...`);

  const issueComments = await getIssueComments(octokit, owner, repo, pullNumber);
  const existingReviewComment = issueComments.find(comment => comment.body?.includes(COMMENT_MARKER));
  const previousState = parseReviewState(existingReviewComment?.body);
  const files = await getChangedFiles(octokit, owner, repo, pullNumber);
  const filteredFullFiles = filterFiles(files, excludePatterns);
  const excludedFiles = files
    .filter(file => !filteredFullFiles.includes(file))
    .map(file => file.filename);
  const scope = await determineReviewScope({
    octokit,
    owner,
    repo,
    requestedMode: modeResolution.mode,
    previousState,
    headSha,
    fullFiles: filteredFullFiles,
    auditChars: unchangedAuditChars,
  });
  const scopedFiles = filterFiles(scope.files, excludePatterns);
  const patchlessFiles = scopedFiles.filter(file => !file.patch).map(file => file.filename);
  const limited = limitFilesByDiffChars(scopedFiles, maxDiffChars);
  const reviewFiles = limited.files;
  const scopeNotice = buildScopeNotice(scope);
  const scopeCoverageWarning = buildCoverageWarning({
    excludedFiles,
    patchlessFiles,
    skippedFiles: limited.skippedFiles,
  });
  const successfulState = /^[0-9a-f]{40}$/i.test(headSha || '')
    ? buildNextReviewState(previousState, scope, headSha)
    : previousState;

  core.info(
    `Selected ${scope.actualMode} review scope: ${scope.deltaFileCount} delta/full file(s), `
      + `${scope.auditFileCount} rotating audit section(s).`
  );
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
      [scopeNotice, scopeCoverageWarning, emptyReview].filter(Boolean).join('\n\n'),
      successfulState
    );
    await upsertReviewComment(octokit, owner, repo, pullNumber, body, issueComments);
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

  const securityReviewFiles = scope.actualMode === 'full'
    ? reviewFiles
    : reviewFiles.filter(file => file.reviewScope === 'delta');
  const securityFindings = SecurityCheck.checkSecurity(securityReviewFiles, customPatterns);
  if (securityFindings.length > 0) {
    core.warning(`Security findings detected: ${securityFindings.length}`);
    for (const finding of securityFindings) {
      core.warning(`[${finding.severity}] ${finding.path}:${finding.line} - ${finding.message}`);
    }
  }

  const chunks = splitIntoChunks(reviewFiles, maxChunkSize);
  const splitFiles = new Set(
    chunks.flat().filter(file => file.splitTotal > 1).map(file => file.filename)
  );
  const coverageWarning = [
    scopeNotice,
    buildCoverageWarning({
      excludedFiles,
      patchlessFiles,
      skippedFiles: limited.skippedFiles,
    }),
  ].filter(Boolean).join('\n\n');
  core.info(
    `Processing ${reviewFiles.length} file(s) in ${chunks.length} chunk(s) with `
      + `${reasoningEffort} reasoning, ${maxOutputTokens} max output tokens, `
      + `${maxChunkSize} max patch characters, streaming enabled, and a `
      + `${requestTimeoutSeconds}s inactivity timeout.`
  );
  if (splitFiles.size > 0) {
    core.info(`Split ${splitFiles.size} oversized file patch(es) across bounded request sections without omitting content.`);
  }

  const reviews = [];
  const failedChunks = [];

  for (let i = 0; i < chunks.length; i++) {
    try {
      core.info(`Processing chunk ${i + 1}/${chunks.length} (${chunks[i].length} file section(s))...`);
      const rawReview = await reviewChunkWithAdaptiveSplit({
        apiKey,
        model,
        systemPrompt,
        files: chunks[i],
        chunkIndex: i,
        totalChunks: chunks.length,
        maxChunkSize,
        apiOptions,
      });
      const review = ConversationalFeedback.postProcess(rawReview);
      // Prepend actionable security findings for this chunk
      const chunkSecurityFiles = scope.actualMode === 'full'
        ? chunks[i]
        : chunks[i].filter(file => file.reviewScope === 'delta');
      const chunkFindings = SecurityCheck.checkSecurity(chunkSecurityFiles, customPatterns);
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

  // Only advance the delta baseline after every selected chunk completed.
  const persistedState = failedChunks.length === 0 ? successfulState : previousState;
  const body = buildCommentBody(reviewerName, combinedReview, persistedState);

  await upsertReviewComment(octokit, owner, repo, pullNumber, body, issueComments);

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
  getChangedFiles,
  getIncrementalFiles,
  hydratePatchesFromUnifiedDiff,
  splitIntoChunks,
  splitPatchAtLineBoundary,
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
  buildZaiRequestBody,
  parseSseEventData,
  getStreamCompletionError,
  parseRetryAfter,
  isRetryableError,
  isRequestTimeoutError,
  isOutputLimitError,
  calculateRetryDelay,
  normalizeReasoningEffort,
  normalizeReviewMode,
  resolveReviewMode,
  parseReviewState,
  buildReviewStateMarker,
  selectRotatingAuditFiles,
  buildScopeNotice,
  determineReviewScope,
  buildNextReviewState,
  hashString,
  RETRY_CONFIG,
};

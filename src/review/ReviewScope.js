const REVIEW_MODES = new Set(['full', 'incremental', 'hybrid']);
const REVIEW_STATE_PREFIX = '<!-- zai-code-review-state:';
const REVIEW_STATE_PATTERN = /<!-- zai-code-review-state:(\{[^\n]*\}) -->/;
const MODE_LABEL_PREFIX = 'zai-review:';

function normalizeReviewMode(value, fallback = 'full') {
  const normalized = String(value || fallback).trim().toLowerCase();
  return REVIEW_MODES.has(normalized) ? normalized : fallback;
}

function resolveReviewMode(configuredMode, labels = []) {
  const configured = normalizeReviewMode(configuredMode);
  const labelModes = new Set(
    labels
      .map(label => typeof label === 'string' ? label : label?.name)
      .filter(Boolean)
      .map(label => label.trim().toLowerCase())
      .filter(label => label.startsWith(MODE_LABEL_PREFIX))
      .map(label => label.slice(MODE_LABEL_PREFIX.length))
      .filter(mode => REVIEW_MODES.has(mode))
  );

  if (labelModes.size === 0) {
    return { mode: configured, configured, labelModes: [] };
  }

  // Prefer the safest/widest scope when conflicting labels are present.
  const mode = ['full', 'hybrid', 'incremental'].find(candidate => labelModes.has(candidate));
  return { mode, configured, labelModes: [...labelModes] };
}

function parseReviewState(body) {
  if (typeof body !== 'string') return null;
  const match = body.match(REVIEW_STATE_PATTERN);
  if (!match) return null;

  try {
    const state = JSON.parse(match[1]);
    if (
      state?.version !== 1
      || !/^[0-9a-f]{40}$/i.test(state.lastReviewedSha || '')
      || !Number.isInteger(state.auditCursor)
      || state.auditCursor < 0
    ) {
      return null;
    }
    if (state.lastFullReviewSha && !/^[0-9a-f]{40}$/i.test(state.lastFullReviewSha)) {
      return null;
    }
    return {
      version: 1,
      lastReviewedSha: state.lastReviewedSha.toLowerCase(),
      lastFullReviewSha: state.lastFullReviewSha?.toLowerCase() || '',
      auditCursor: state.auditCursor,
      mode: normalizeReviewMode(state.mode),
    };
  } catch {
    return null;
  }
}

function buildReviewStateMarker(state) {
  if (!state) return '';
  const normalized = {
    version: 1,
    lastReviewedSha: state.lastReviewedSha,
    lastFullReviewSha: state.lastFullReviewSha || '',
    auditCursor: state.auditCursor || 0,
    mode: normalizeReviewMode(state.mode),
  };
  return `${REVIEW_STATE_PREFIX}${JSON.stringify(normalized)} -->`;
}

function splitPatch(patch, maxChars) {
  const parts = [];
  let offset = 0;
  while (offset < patch.length) {
    let end = Math.min(offset + maxChars, patch.length);
    if (end < patch.length) {
      const newline = patch.lastIndexOf('\n', end);
      if (newline > offset + Math.floor(maxChars / 2)) end = newline + 1;
    }
    parts.push(patch.slice(offset, end));
    offset = end;
  }
  return parts;
}

function buildAuditSections(fullFiles, deltaFiles, maxChars) {
  if (!Number.isInteger(maxChars) || maxChars <= 0) return [];
  const deltaPaths = new Set(deltaFiles.map(file => file.filename));
  return fullFiles
    .filter(file => file.patch && !deltaPaths.has(file.filename))
    .flatMap(file => {
      const parts = splitPatch(file.patch, maxChars);
      return parts.map((patch, index) => ({
        ...file,
        patch,
        reviewScope: 'audit',
        splitPart: parts.length > 1 ? index + 1 : file.splitPart,
        splitTotal: parts.length > 1 ? parts.length : file.splitTotal,
        originalPatchLength: parts.length > 1 ? file.patch.length : file.originalPatchLength,
      }));
    });
}

function selectRotatingAuditFiles(fullFiles, deltaFiles, maxChars, cursor = 0) {
  const sections = buildAuditSections(fullFiles, deltaFiles, maxChars);
  if (sections.length === 0) {
    return { files: [], nextCursor: 0, totalSections: 0, startCursor: 0 };
  }

  const startCursor = cursor % sections.length;
  const files = [];
  let usedChars = 0;
  let consumed = 0;
  for (let index = startCursor; index < sections.length; index++) {
    const section = sections[index];
    const chars = section.patch.length;
    if (files.length > 0 && usedChars + chars > maxChars) break;
    files.push(section);
    usedChars += chars;
    consumed++;
  }

  return {
    files,
    nextCursor: (startCursor + consumed) % sections.length,
    totalSections: sections.length,
    startCursor,
  };
}

function buildScopeNotice(scope) {
  const head = scope.headSha?.slice(0, 7) || 'unknown';
  if (scope.actualMode === 'full') {
    const reason = scope.reason ? ` ${scope.reason}` : '';
    return `> [!NOTE]\n> Review scope: **full PR** at \`${head}\`.${reason}`;
  }

  const previous = scope.previousSha?.slice(0, 7) || 'unknown';
  if (scope.actualMode === 'incremental') {
    return `> [!NOTE]\n> Review scope: **incremental**, changes from \`${previous}\` to \`${head}\` (${scope.deltaFileCount} file(s)).`;
  }

  return [
    '> [!NOTE]',
    `> Review scope: **hybrid**, changes from \`${previous}\` to \`${head}\` (${scope.deltaFileCount} file(s))`,
    `> plus ${scope.auditFileCount} rotating unchanged PR section(s).`,
  ].join('\n');
}

module.exports = {
  normalizeReviewMode,
  resolveReviewMode,
  parseReviewState,
  buildReviewStateMarker,
  selectRotatingAuditFiles,
  buildScopeNotice,
};

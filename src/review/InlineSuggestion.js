// Handles inline suggestion logic for code review

const { findSimilarThread } = require('./ThreadSimilarity');

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

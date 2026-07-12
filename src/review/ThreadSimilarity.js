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

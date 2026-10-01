'use strict';

// Fold the retired article-specific minimum gap into the one shared post rate.
// The old scheduler required BOTH limits, so the effective maximum rate was the
// lower of postsPerHour and 60 / gapMinutes. Keeping that lower rate preserves
// or slows an existing article bot; it can never make one post more often.
function migrateLegacyArticleGap(profile, legacySource = profile) {
  const target = profile && typeof profile === 'object' ? profile : {};
  const legacy = legacySource && typeof legacySource === 'object' ? legacySource : {};
  const sharesLinks = target.canShareLinks === true || legacy.canShareLinks === true || legacy.botType === 'news';
  const gapMinutes = Number(legacy.newsMinGapMinutes);
  const postRate = Math.max(0, Number(target.postsPerHour) || 0);
  if (sharesLinks && Number.isFinite(gapMinutes) && gapMinutes > 0 && postRate > 0) {
    target.postsPerHour = Math.min(postRate, 60 / gapMinutes);
  }
  delete target.newsMinGapMinutes;
  return target;
}

module.exports = { migrateLegacyArticleGap };

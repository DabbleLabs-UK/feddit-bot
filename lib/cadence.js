'use strict';

function cleanRate(value) {
  const rate = Number(value);
  return Number.isFinite(rate) && rate > 0 ? rate : 0;
}

function preserveLinkOnlyDueTime(target, legacy) {
  const startsDiscussions = target.canStartDiscussions === true || legacy.canStartDiscussions === true ||
    (legacy.botType !== 'news' && (legacy.mode === 'post' || legacy.mode === 'both'));
  const sharesLinks = target.canShareLinks === true || legacy.canShareLinks === true || legacy.botType === 'news';
  if (!sharesLinks || startsDiscussions) return;

  const moveTimer = (targetSched, legacySched) => {
    if (!targetSched || typeof targetSched !== 'object') return;
    if (targetSched.nextArticleAt == null && legacySched && legacySched.nextPostAt != null) {
      targetSched.nextArticleAt = legacySched.nextPostAt;
      targetSched.nextPostAt = null;
    }
  };
  moveTimer(target.sched, legacy.sched);
  moveTimer(
    target.simulationState && target.simulationState.sched,
    legacy.simulationState && legacy.simulationState.sched,
  );
}

// Schema 20 restores separate text-post and article-link opportunity rates.
// Schema 19 has only one combined post rate, so a mixed bot is split evenly:
// the two new rates add back to the old rate and can never increase aggregate
// posting activity. Link-only bots keep the whole rate as article activity.
//
// Records old enough to retain newsMinGapMinutes contain one additional piece
// of reliable evidence: their article ceiling. Preserve that ceiling and give
// any remaining part of the former shared post rate to text discussions. This
// recovers what can be known without pretending the old personality-led choice
// recorded a precise historical text/article ratio.
function migrateArticleCadence(profile, legacySource = profile, previousSchemaVersion = 20) {
  const target = profile && typeof profile === 'object' ? profile : {};
  const legacy = legacySource && typeof legacySource === 'object' ? legacySource : {};
  const sharesLinks = target.canShareLinks === true || legacy.canShareLinks === true || legacy.botType === 'news';
  const startsDiscussions = target.canStartDiscussions === true || legacy.canStartDiscussions === true ||
    (legacy.botType !== 'news' && (legacy.mode === 'post' || legacy.mode === 'both'));
  const combinedRate = cleanRate(target.postsPerHour);
  const hasExplicitArticleRate = Object.prototype.hasOwnProperty.call(legacy, 'articlePostsPerHour');

  if (!sharesLinks) {
    target.articlePostsPerHour = 0;
  } else if (hasExplicitArticleRate) {
    target.articlePostsPerHour = cleanRate(legacy.articlePostsPerHour);
  } else if (Number(previousSchemaVersion) < 19) {
    const hasLegacyGap = Object.prototype.hasOwnProperty.call(legacy, 'newsMinGapMinutes');
    const gapMinutes = hasLegacyGap ? cleanRate(legacy.newsMinGapMinutes) : 30;
    const recoverableArticleRate = gapMinutes > 0
      ? Math.min(combinedRate, 60 / gapMinutes)
      : combinedRate;
    target.articlePostsPerHour = recoverableArticleRate;
    target.postsPerHour = startsDiscussions
      ? Math.max(0, combinedRate - recoverableArticleRate)
      : 0;
  } else if (!startsDiscussions) {
    target.articlePostsPerHour = combinedRate;
    target.postsPerHour = 0;
  } else {
    target.articlePostsPerHour = combinedRate / 2;
    target.postsPerHour = combinedRate - target.articlePostsPerHour;
  }

  preserveLinkOnlyDueTime(target, legacy);
  delete target.newsMinGapMinutes;
  return target;
}

module.exports = { migrateArticleCadence };

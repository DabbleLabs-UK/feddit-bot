(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FedditEditorState = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  function snapshotsEqual(left, right) {
    return Boolean(left && right &&
      left.profile === right.profile &&
      left.biography === right.biography);
  }

  function resolveConfirmedSave(savedSnapshot, currentSnapshot, revisionAtStart, revisionNow) {
    const dirty = !snapshotsEqual(savedSnapshot, currentSnapshot) || revisionAtStart !== revisionNow;
    return {
      dirty,
      phase: dirty ? 'dirty' : 'saved',
      message: dirty ? 'Newer changes are still unsaved' : 'Saved',
    };
  }

  function isSaveCurrent(token, sequence, profileId) {
    return Boolean(token && token.sequence === sequence && token.profileId === profileId);
  }

  function shouldWarnBeforeUnload(dirty, saving) {
    return Boolean(dirty || saving);
  }

  function dirtyControlVisible(dirty, phase) {
    return Boolean(dirty || phase === 'saving' || phase === 'saved' || phase === 'error');
  }

  function resolveFailedSave(message) {
    return {
      dirty: true,
      phase: 'error',
      message: 'Save failed' + (message ? ' - ' + message : ''),
    };
  }

  return {
    snapshotsEqual,
    resolveConfirmedSave,
    resolveFailedSave,
    dirtyControlVisible,
    isSaveCurrent,
    shouldWarnBeforeUnload,
  };
});

'use strict';

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FedditUiActivity = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function rateVisibility(abilities = {}) {
    return {
      text: abilities.canStartDiscussions === true,
      article: abilities.canShareLinks === true,
      replies: abilities.canReply === true,
    };
  }

  return { rateVisibility };
});

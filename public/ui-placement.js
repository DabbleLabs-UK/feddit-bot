(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FedditUiPlacement = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const COMMON_EDITOR_FEATURES = Object.freeze([
    'run-status',
    'collapsible-cards',
    'dirty-save',
    'floating-save',
    'save-feedback',
    'developer-tools-gating',
    'activity-layout',
  ]);

  function editorVariant(placement, profile) {
    const hosted = placement === 'hosted';
    const systemPopulation = Boolean(profile && profile.botOrigin === 'system');
    return {
      placement: hosted ? 'hosted' : (placement === 'advanced' ? 'advanced' : 'desktop'),
      commonFeatures: COMMON_EDITOR_FEATURES,
      providerLocked: hosted,
      showProviderSelector: !hosted,
      showHostedAllocation: hosted,
      showCadenceRates: !hosted || systemPopulation,
      showPopulationCadenceNote: hosted && systemPopulation,
      showLocalModelControls: !hosted,
      showHostedWorkerControls: hosted,
    };
  }

  return { COMMON_EDITOR_FEATURES, editorVariant };
});

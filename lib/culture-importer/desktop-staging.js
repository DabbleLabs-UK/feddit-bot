'use strict';

const {
  CultureStagingError,
  createExternalSeedHttpStager,
} = require('./staging');

function isLoopback(hostname) {
  return ['127.0.0.1', 'localhost', '::1'].includes(String(hostname || '').toLowerCase());
}

function parseHostedManagementLink(value) {
  let url;
  try { url = new URL(String(value || '').trim()); }
  catch (cause) {
    throw new CultureStagingError(
      'Paste the complete private management link from the hosted Feddit Bots workspace.',
      'INVALID_MANAGEMENT_LINK',
      { statusCode: 422, cause },
    );
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname))) {
    throw new CultureStagingError(
      'The hosted management link must use HTTPS.',
      'INVALID_MANAGEMENT_LINK',
      { statusCode: 422 },
    );
  }
  if (url.hostname.toLowerCase() !== 'feddit-bots.dabblelabs.uk' && !isLoopback(url.hostname)) {
    throw new CultureStagingError(
      'The private management link must be for the hosted Feddit Bots workspace.',
      'INVALID_MANAGEMENT_LINK',
      { statusCode: 422 },
    );
  }
  const match = String(url.hash || '').match(/^#manage=(.+)$/);
  let ownerToken = '';
  if (match) {
    try { ownerToken = decodeURIComponent(match[1]).trim(); } catch { ownerToken = ''; }
  }
  if (!ownerToken) {
    throw new CultureStagingError(
      'That link does not contain a private workspace management capability.',
      'INVALID_MANAGEMENT_LINK',
      { statusCode: 422 },
    );
  }
  return {
    serverUrl: url.origin,
    ownerToken,
  };
}

function createDesktopCultureStager(managementLink, options = {}) {
  const destination = parseHostedManagementLink(managementLink);
  return createExternalSeedHttpStager({
    ...destination,
    fetch: options.fetch,
  });
}

function desktopStagingDestination(input = {}) {
  const requested = String(input.destination || '').trim().toLowerCase();
  if (requested === 'local' || requested === 'hosted') return requested;
  if (requested) {
    throw new CultureStagingError(
      'Choose either this desktop app or the hosted Feddit Bots workspace as the staging destination.',
      'INVALID_STAGING_DESTINATION',
      { statusCode: 422 },
    );
  }
  // Preserve requests from the released pre-selector UI: that client included a
  // hosted management link but no destination. New desktop requests default to
  // the local workspace and never need a hosted capability.
  return String(input.managementLink || '').trim() ? 'hosted' : 'local';
}

function createDesktopCultureStageRoute(input = {}, options = {}) {
  const destination = desktopStagingDestination(input);
  if (destination === 'hosted') {
    return {
      destination,
      stageExternalSeeds: createDesktopCultureStager(input.managementLink, options),
    };
  }
  if (typeof options.localStageExternalSeeds !== 'function') {
    throw new CultureStagingError(
      'Local culture-candidate staging is not available in this desktop runtime.',
      'LOCAL_STAGING_UNAVAILABLE',
      { statusCode: 503 },
    );
  }
  return {
    destination,
    stageExternalSeeds: options.localStageExternalSeeds,
  };
}

module.exports = {
  isLoopback,
  parseHostedManagementLink,
  createDesktopCultureStager,
  desktopStagingDestination,
  createDesktopCultureStageRoute,
};

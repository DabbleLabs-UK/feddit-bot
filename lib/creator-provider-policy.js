'use strict';

const POLICY_VERSION = 1;
const READY_STATES = new Set(['ready', 'busy']);

function clean(value, max = 300) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function normalizedStatuses(value) {
  return (Array.isArray(value) ? value : []).filter((item) => item && item.id).map((item) => ({
    ...item,
    id: clean(item.id, 40),
    label: clean(item.label, 100) || clean(item.id, 40),
    state: clean(item.state, 40),
    models: (Array.isArray(item.models) ? item.models : []).filter((model) => model && model.id).map((model) => ({
      ...model,
      id: clean(model.id, 300),
      label: clean(model.label, 300) || clean(model.id, 300),
    })),
    creator: item.creator && typeof item.creator === 'object' ? item.creator : {},
  }));
}

function providerReady(status) {
  return Boolean(status && READY_STATES.has(status.state));
}

function preferredModel(status, requestedModel = '') {
  const requested = clean(requestedModel, 300);
  const models = Array.isArray(status && status.models) ? status.models : [];
  if (requested) {
    if (!models.length || models.some((model) => model.id === requested)) return requested;
    return '';
  }
  const order = Array.isArray(status && status.creator && status.creator.preferredModels)
    ? status.creator.preferredModels.map((item) => clean(item, 300)).filter(Boolean)
    : [];
  for (const id of order) {
    const exact = models.find((model) => model.id === id);
    if (exact) return exact.id;
  }
  return models[0] ? models[0].id : '';
}

function unavailablePlan(options, message, provider = '', model = '', label = '') {
  return {
    available: false,
    provider: clean(provider, 40),
    model: clean(model, 300),
    label: clean(label, 100) || clean(provider, 40),
    fallback: false,
    selectionMode: clean(options.selectionMode, 60) || 'unavailable',
    selectionReason: clean(message, 500),
    policyVersion: POLICY_VERSION,
    error: clean(message, 500),
  };
}

function selectedPlan(status, model, selectionMode, selectionReason, fallback = false) {
  return {
    available: true,
    provider: status.id,
    model,
    label: status.label,
    fallback,
    selectionMode,
    selectionReason,
    policyVersion: POLICY_VERSION,
  };
}

function explicitPlan(statuses, options) {
  const provider = clean(options.explicitProvider, 40);
  const model = clean(options.explicitModel, 300);
  if (!provider && !model) return null;
  if (!provider || !model) {
    return unavailablePlan(
      { selectionMode: 'explicit' },
      'Choose both a creator provider and creator model.',
      provider,
      model,
    );
  }
  const status = statuses.find((item) => item.id === provider);
  if (!status || status.creator.eligible !== true) {
    return unavailablePlan(
      { selectionMode: 'explicit' },
      'The selected provider is not available for character creation.',
      provider,
      model,
      status && status.label,
    );
  }
  if (!providerReady(status) && status.creator.durableOfflineQueue !== true) {
    return unavailablePlan(
      { selectionMode: 'explicit' },
      'The selected character creator is not connected and ready: ' + clean(status.detail || status.state || 'unavailable', 320),
      provider,
      model,
      status.label,
    );
  }
  const selectedModel = preferredModel(status, model);
  if (!selectedModel) {
    return unavailablePlan(
      { selectionMode: 'explicit' },
      'The selected creator model is not available from this provider.',
      provider,
      model,
      status.label,
    );
  }
  return selectedPlan(status, selectedModel, 'explicit', 'Explicit operator-selected character creator.');
}

function automaticPlan(statuses) {
  const candidates = statuses
    .filter((status) => status.creator.eligible === true && status.creator.autoPreferred === true && providerReady(status))
    .map((status) => ({
      status,
      model: preferredModel(status),
      priority: Number(status.creator.preference) || 0,
    }))
    .filter((candidate) => candidate.model)
    .sort((a, b) => b.priority - a.priority || a.status.id.localeCompare(b.status.id));
  const chosen = candidates[0];
  if (!chosen) return null;
  return selectedPlan(
    chosen.status,
    chosen.model,
    'automatic-preferred',
    'Automatically preferred an already-connected high-capability creator. No separately billed API provider was selected.',
  );
}

function configuredPlan(statuses, options) {
  const provider = clean(options.configuredProvider, 40);
  const model = clean(options.configuredModel, 300);
  if (!provider && !model) return null;
  if (!provider || !model) {
    return unavailablePlan(
      { selectionMode: 'configured-path' },
      'The configured character creator is incomplete. Configure both its provider and model.',
      provider,
      model,
      options.configuredLabel,
    );
  }
  const status = statuses.find((item) => item.id === provider);
  if (!status || status.creator.eligible !== true) {
    return unavailablePlan(
      { selectionMode: 'configured-path' },
      'The configured creator provider is not available in this runner placement.',
      provider,
      model,
      options.configuredLabel || status && status.label,
    );
  }
  if (!providerReady(status) && status.creator.durableOfflineQueue !== true) {
    return unavailablePlan(
      { selectionMode: 'configured-path' },
      'The configured creator path is not ready: ' + clean(status.detail || status.state || 'unavailable', 320),
      provider,
      model,
      options.configuredLabel || status.label,
    );
  }
  const selectedModel = preferredModel(status, model);
  if (!selectedModel) {
    return unavailablePlan(
      { selectionMode: 'configured-path' },
      'The configured creator model is not available from this provider.',
      provider,
      model,
      options.configuredLabel || status.label,
    );
  }
  return {
    ...selectedPlan(status, selectedModel, 'configured-path', 'Used the configured hosted or local character-creator path.'),
    label: clean(options.configuredLabel, 100) || status.label,
  };
}

function fallbackPlan(statuses, options) {
  if (options.allowRuntimeFallback !== true) return null;
  const provider = clean(options.runtimeProvider, 40);
  const model = clean(options.runtimeModel, 300);
  const status = statuses.find((item) => item.id === provider);
  if (!provider || !model || !status ||
      (!providerReady(status) && status.creator.durableOfflineQueue !== true)) return null;
  return {
    ...selectedPlan(
      status,
      model,
      'explicit-runtime-fallback',
      'The operator explicitly allowed the normal runtime provider and model for this creation only.',
      true,
    ),
    label: clean(options.runtimeLabel, 100) || status.label,
  };
}

function resolveCreatorPreference(options = {}) {
  const statuses = normalizedStatuses(options.providers);
  const explicit = explicitPlan(statuses, options);
  if (explicit) return explicit;
  const automatic = automaticPlan(statuses);
  if (automatic) return automatic;
  const configured = configuredPlan(statuses, options);
  if (configured && configured.available) return configured;
  const fallback = fallbackPlan(statuses, options);
  if (fallback) return fallback;
  if (configured) return configured;
  return unavailablePlan(
    {},
    'No connected strong character creator is available. Connect a supported subscription provider, configure a creator path, choose a creator explicitly, or explicitly allow the normal runtime model for this creation.',
  );
}

module.exports = {
  POLICY_VERSION,
  READY_STATES,
  normalizedStatuses,
  providerReady,
  preferredModel,
  resolveCreatorPreference,
};

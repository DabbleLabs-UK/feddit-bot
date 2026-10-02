'use strict';

// One provider registry sits above provider-specific mechanics. It deliberately
// does not make those mechanics identical: Ollama keeps its single-flight gate,
// DeepSeek keeps its bounded remote semaphore, DELL keeps its durable queue,
// and subscription providers own their official authentication flows.

const ollama = require('./ollama');
const deepseek = require('./deepseek');
const dellFactory = require('./dell');
const chatgptFactory = require('./chatgpt-plan');
const claudePlanFactory = require('./claude-plan');
const contract = require('./contract');

const PROVIDERS = ['ollama', 'dell', 'deepseek', 'chatgpt-plan', 'claude-plan'];
const DEEPSEEK_MAX_CONCURRENT = 3;
let dell = null;
let dellQueue = null;
let runtime = { secrets: null, placement: 'desktop' };
let chatgptPlan = null;
let claudePlan = null;

let dsActive = 0;
const dsWaiters = [];
let chatgptActive = 0;
const chatgptWaiters = [];
let claudeActive = 0;
const claudeWaiters = [];

function acquireDeepseekSlot() {
  if (dsActive < DEEPSEEK_MAX_CONCURRENT) {
    dsActive++;
    return Promise.resolve();
  }
  return new Promise((resolve) => dsWaiters.push(resolve));
}

function releaseDeepseekSlot() {
  const next = dsWaiters.shift();
  if (next) next();
  else dsActive--;
}

function deepseekInFlight() {
  return dsActive;
}

function acquireChatgptSlot() {
  if (chatgptActive < 1) {
    chatgptActive++;
    return Promise.resolve();
  }
  return new Promise((resolve) => chatgptWaiters.push(resolve));
}

function releaseChatgptSlot() {
  const next = chatgptWaiters.shift();
  if (next) next();
  else chatgptActive--;
}

function chatgptInFlight() {
  return chatgptActive;
}

function acquireClaudeSlot() {
  if (claudeActive < 1) {
    claudeActive++;
    return Promise.resolve();
  }
  return new Promise((resolve) => claudeWaiters.push(resolve));
}

function releaseClaudeSlot() {
  const next = claudeWaiters.shift();
  if (next) next();
  else claudeActive--;
}

function claudeInFlight() {
  return claudeActive;
}

const descriptors = Object.freeze({
  ollama: Object.freeze({
    id: 'ollama', label: 'Ollama', category: 'local',
    creator: Object.freeze({
      eligible: true, autoPreferred: false, preference: 50, preferredModels: Object.freeze([]),
    }),
    capabilities: Object.freeze({
      structuredOutput: true, cancellation: true, modelSelection: true,
      efficientBatch: false, longLivedSession: true, maxConcurrency: 1,
    }),
  }),
  dell: Object.freeze({
    id: 'dell', label: 'Feddit hosted compute', category: 'managed',
    creator: Object.freeze({
      eligible: true, autoPreferred: false, preference: 100,
      durableOfflineQueue: true, preferredModels: Object.freeze([]),
    }),
    capabilities: Object.freeze({
      structuredOutput: true, cancellation: false, modelSelection: false,
      efficientBatch: false, longLivedSession: true, maxConcurrency: 1,
    }),
  }),
  deepseek: Object.freeze({
    id: 'deepseek', label: 'DeepSeek API', category: 'api',
    creator: Object.freeze({
      eligible: true,
      // A configured DeepSeek creator remains available, but the selector never
      // spends API credit merely because a key exists.
      autoPreferred: false,
      preference: 250,
      preferredModels: Object.freeze(['deepseek-v4-pro', 'deepseek-v4-flash']),
    }),
    capabilities: Object.freeze({
      structuredOutput: true, cancellation: true, modelSelection: true,
      efficientBatch: false, longLivedSession: false, maxConcurrency: DEEPSEEK_MAX_CONCURRENT,
    }),
  }),
  'chatgpt-plan': chatgptFactory.descriptor,
  'claude-plan': claudePlanFactory.descriptor,
});

function configureRuntime(options = {}) {
  runtime = {
    secrets: options.secrets || runtime.secrets,
    placement: String(options.placement || runtime.placement || 'desktop'),
  };
  if (runtime.secrets) {
    chatgptPlan = chatgptFactory.createChatgptPlanProvider({
      secrets: runtime.secrets,
      placement: runtime.placement,
      fetchImpl: options.fetchImpl,
      now: options.now,
    });
  }
  claudePlan = claudePlanFactory.createClaudePlanProvider({
    placement: runtime.placement,
    run: options.claudeRun,
    launchLogin: options.claudeLaunchLogin,
    env: options.env,
    command: options.claudeCommand,
  });
}

function configureDellQueue(queue, options) {
  dellQueue = queue;
  dell = dellFactory.createDellProvider(queue, options);
  return dell;
}

function normProvider(provider) {
  return String(provider || 'ollama');
}

function requestProvider(options = {}) {
  return normProvider(options.providerOverride || options.provider || 'ollama');
}

function providerDescriptor(provider) {
  return descriptors[normProvider(provider)] || null;
}

function ollamaBusy() {
  return ollama.isBusy();
}

function unavailableStatus(id, detail) {
  const descriptor = descriptors[id];
  return {
    id,
    label: descriptor.label,
    state: contract.PROVIDER_STATES.UNAVAILABLE,
    detail,
    capabilities: descriptor.capabilities,
    creator: descriptor.creator,
    models: [],
  };
}

async function status(provider) {
  const id = normProvider(provider);
  const descriptor = descriptors[id];
  if (!descriptor) {
    return { id, label: id, state: contract.PROVIDER_STATES.UNAVAILABLE, detail: 'Unknown provider.', capabilities: {}, models: [] };
  }

  if (id === 'ollama') {
    if (runtime.placement === 'hosted') return unavailableStatus(id, 'Local Ollama models are available in desktop and self-hosted runners.');
    const result = await ollama.status();
    return {
      id, label: descriptor.label,
      state: result.up ? (result.busy ? contract.PROVIDER_STATES.BUSY : contract.PROVIDER_STATES.READY) : contract.PROVIDER_STATES.UNAVAILABLE,
      detail: result.up ? (result.busy ? 'Generating on this computer.' : 'Ready on this computer.') : (result.error || 'Ollama is not reachable.'),
      capabilities: descriptor.capabilities,
      creator: descriptor.creator,
      models: (result.models || []).map((model) => ({ id: model, label: model })),
    };
  }

  if (id === 'deepseek') {
    if (runtime.placement === 'hosted') return unavailableStatus(id, 'Personal API credentials are not exposed to the hosted workspace.');
    const key = runtime.secrets && runtime.secrets.getDeepseekKey ? runtime.secrets.getDeepseekKey() : '';
    const result = await deepseek.reachable(key);
    let state = contract.PROVIDER_STATES.UNAVAILABLE;
    if (!key) state = contract.PROVIDER_STATES.AUTH_REQUIRED;
    else if (result.up && result.keyOk) state = dsActive ? contract.PROVIDER_STATES.BUSY : contract.PROVIDER_STATES.READY;
    else if (result.up) state = contract.PROVIDER_STATES.AUTH_REQUIRED;
    return {
      id, label: descriptor.label, state,
      detail: !key ? 'Add an API key.' : (result.keyOk ? (dsActive ? 'Requests are running.' : 'Configured and reachable.') : (result.error || 'Unavailable.')),
      capabilities: descriptor.capabilities,
      creator: descriptor.creator,
      models: deepseek.MODELS.map((model) => ({ id: model, label: model })),
      credential: runtime.secrets && runtime.secrets.publicView ? runtime.secrets.publicView() : { hasKey: Boolean(key), redacted: '' },
    };
  }

  if (id === 'dell') {
    if (runtime.placement !== 'hosted') return unavailableStatus(id, 'Managed hosted compute is selected automatically in the hosted workspace.');
    const capacity = dellQueue && typeof dellQueue.capacity === 'function' ? dellQueue.capacity() : null;
    const online = capacity && capacity.online !== false;
    return {
      id, label: descriptor.label,
      state: !dell ? contract.PROVIDER_STATES.UNAVAILABLE : (online ? contract.PROVIDER_STATES.READY : contract.PROVIDER_STATES.UNAVAILABLE),
      detail: !dell ? 'The hosted queue is not configured.' : (online ? 'Managed by Feddit.' : 'The hosted worker is not checking in.'),
      capabilities: descriptor.capabilities,
      creator: descriptor.creator,
      models: [],
    };
  }

  if (id === 'chatgpt-plan') {
    if (!chatgptPlan) return unavailableStatus(id, 'The local ChatGPT connection adapter is not configured.');
    return { ...await chatgptPlan.status(), creator: descriptor.creator };
  }
  if (!claudePlan) return unavailableStatus(id, 'The local Claude connection adapter is not configured.');
  return { ...await claudePlan.status(), creator: descriptor.creator };
}

async function statuses() {
  const ids = runtime.placement === 'hosted'
    ? ['dell']
    : ['ollama', 'chatgpt-plan', 'claude-plan', 'deepseek'];
  return Promise.all(ids.map(status));
}

async function generate(options = {}) {
  const provider = requestProvider(options);
  const descriptor = descriptors[provider];
  if (!descriptor) {
    throw new contract.ProviderError('Unknown AI provider "' + provider + '".', 'UNAVAILABLE', { provider });
  }
  const request = { ...options, provider };
  delete request.providerOverride;
  let result;
  try {
    if (provider === 'deepseek') {
      await acquireDeepseekSlot();
      try {
        if (!request.apiKey && runtime.secrets) request.apiKey = runtime.secrets.getDeepseekKey();
        result = await deepseek.generate(request);
      } finally {
        releaseDeepseekSlot();
      }
    } else if (provider === 'dell') {
      if (!dell) throw new contract.ProviderError('The hosted compute queue is not configured.', 'NOT_CONFIGURED', { provider });
      result = await dell.generate(request);
    } else if (provider === 'chatgpt-plan') {
      if (!chatgptPlan) throw new contract.ProviderError('The ChatGPT plan provider is not configured.', 'NOT_CONFIGURED', { provider });
      await acquireChatgptSlot();
      try { result = await chatgptPlan.generate(request); }
      finally { releaseChatgptSlot(); }
    } else if (provider === 'claude-plan') {
      if (!claudePlan) throw new contract.ProviderError('The Claude plan provider is not configured.', 'NOT_CONFIGURED', { provider });
      await acquireClaudeSlot();
      try { result = await claudePlan.generate(request); }
      finally { releaseClaudeSlot(); }
    } else {
      result = await ollama.generate(request);
    }
    return contract.normalizeGeneration(result, request, descriptor);
  } catch (error) {
    if (!error.provider) error.provider = provider;
    throw error;
  }
}

function enqueueDell(options = {}) {
  if (!dell) throw new Error('The hosted compute queue is not configured.');
  return dell.enqueue(options);
}

async function connect(provider) {
  const adapter = provider === 'chatgpt-plan' ? chatgptPlan : (provider === 'claude-plan' ? claudePlan : null);
  if (!adapter) {
    throw new contract.ProviderError('This provider has no supported connection flow.', 'UNAVAILABLE', { provider });
  }
  return adapter.beginConnect();
}

async function disconnect(provider) {
  const adapter = provider === 'chatgpt-plan' ? chatgptPlan : (provider === 'claude-plan' ? claudePlan : null);
  if (!adapter) {
    throw new contract.ProviderError('This provider has no supported disconnect flow.', 'UNAVAILABLE', { provider });
  }
  return adapter.disconnect();
}

module.exports = {
  PROVIDERS,
  DEEPSEEK_MAX_CONCURRENT,
  DEFAULT_MODEL: ollama.DEFAULT_MODEL,
  descriptors,
  contract,
  ollama,
  deepseek,
  dellFactory,
  chatgptFactory,
  claudePlanFactory,
  generate,
  enqueueDell,
  configureDellQueue,
  configureRuntime,
  status,
  statuses,
  connect,
  disconnect,
  providerDescriptor,
  ollamaBusy,
  deepseekInFlight,
  chatgptInFlight,
  claudeInFlight,
  normProvider,
  requestProvider,
};

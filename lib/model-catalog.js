'use strict';

// A deliberately small, tested set of local models. The first-run experience
// offers understandable trade-offs instead of presenting Ollama's whole model
// library. Owners can still type another installed model in advanced settings.

const DELL_SHARED_MODEL = 'hf.co/mlabonne/Meta-Llama-3.1-8B-Instruct-abliterated-GGUF:Q5_K_M';
const DESKTOP_FALLBACK_MODEL = 'qwen3:4b';

const MODELS = Object.freeze([
  Object.freeze({
    id: 'qwen3:1.7b',
    label: 'Light and quick',
    downloadGb: 1.4,
    minRamGb: 6,
    description: 'Best when keeping the computer responsive matters most.',
  }),
  Object.freeze({
    id: 'qwen3:4b',
    label: 'Balanced',
    downloadGb: 2.5,
    minRamGb: 8,
    description: 'A good starting point for most everyday computers.',
  }),
  Object.freeze({
    id: 'qwen3:8b',
    label: 'More expressive',
    downloadGb: 5.2,
    minRamGb: 16,
    description: 'Better writing, with slower replies and more memory use.',
  }),
  Object.freeze({
    id: 'qwen3:14b',
    label: 'Most capable here',
    downloadGb: 9.3,
    minRamGb: 24,
    description: 'For powerful computers when waiting longer is acceptable.',
  }),
]);

function bytesToGb(bytes) {
  return Math.round((Number(bytes) || 0) / (1024 ** 3) * 10) / 10;
}

function recommendationIndex(totalRamGb, cpuCount) {
  const ram = Number(totalRamGb) || 0;
  const cores = Number(cpuCount) || 0;
  if (ram >= 24 && cores >= 12) return 3;
  if (ram >= 16 && cores >= 8) return 2;
  if (ram >= 8 && cores >= 4) return 1;
  return 0;
}

function adviseHardware({ totalMemoryBytes, cpuCount, platform, arch } = {}) {
  const totalRamGb = bytesToGb(totalMemoryBytes);
  const logicalCpus = Math.max(1, Number(cpuCount) || 1);
  const recommended = MODELS[recommendationIndex(totalRamGb, logicalCpus)];
  return {
    totalRamGb,
    logicalCpus,
    platform: String(platform || ''),
    arch: String(arch || ''),
    recommendedModel: recommended.id,
    basis: 'A conservative starting point based on system memory and logical CPU count. A supported GPU can make larger models faster, but is not assumed.',
    choices: MODELS.map((model) => ({
      ...model,
      recommended: model.id === recommended.id,
      fit: totalRamGb >= model.minRamGb ? 'comfortable' : 'may-be-slow',
    })),
  };
}

function isGuidedModel(model) {
  return MODELS.some((item) => item.id === String(model || ''));
}

module.exports = {
  DELL_SHARED_MODEL,
  DESKTOP_FALLBACK_MODEL,
  MODELS,
  bytesToGb,
  adviseHardware,
  isGuidedModel,
};

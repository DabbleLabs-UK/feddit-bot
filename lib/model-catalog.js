'use strict';

// A deliberately small, tested set of local models. The first-run experience
// offers understandable trade-offs instead of presenting Ollama's whole model
// library. The same list drives first-run setup and each bot's model selector;
// per-bot settings also retain every compatible model Ollama reports as installed.

const DELL_SHARED_MODEL = 'hf.co/mlabonne/Meta-Llama-3.1-8B-Instruct-abliterated-GGUF:Q5_K_M';
const DESKTOP_FALLBACK_MODEL = 'qwen3:4b-instruct';

// The original desktop catalog used Qwen 3's short tags. Those tags now point
// at thinking models, including a thinking-only 4B build which can spend a
// short social reply's entire token cap before producing visible text. Keep a
// one-time migration path to direct, instruction-tuned replacements.
const LEGACY_GUIDED_REPLACEMENTS = Object.freeze({
  'qwen3:1.7b': 'qwen2.5:1.5b',
  'qwen3:4b': 'qwen3:4b-instruct',
  'qwen3:8b': 'qwen2.5:7b',
  'qwen3:14b': 'qwen2.5:14b',
});

const APACHE_2_LICENSE_URL = 'https://www.apache.org/licenses/LICENSE-2.0';
const LLAMA_31_LICENSE_URL = 'https://www.llama.com/llama3_1/license/';

const STANDARD_MODELS = Object.freeze([
  Object.freeze({
    id: 'qwen2.5:1.5b',
    label: 'Light and quick',
    variant: 'Standard instruction model',
    variantKind: 'standard',
    parameterSize: '1.5B',
    quantization: 'Q4_K_M',
    downloadGb: 1.0,
    minRamGb: 6,
    description: 'Best when keeping the computer responsive matters most.',
    sourceName: 'Qwen 2.5 on Ollama',
    sourceUrl: 'https://ollama.com/library/qwen2.5:1.5b',
    licenseName: 'Apache 2.0',
    licenseUrl: APACHE_2_LICENSE_URL,
    replaces: ['qwen3:1.7b'],
  }),
  Object.freeze({
    id: 'qwen3:4b-instruct',
    label: 'Balanced',
    variant: 'Standard instruction model',
    variantKind: 'standard',
    parameterSize: '4B',
    quantization: 'Q4_K_M',
    downloadGb: 2.5,
    minRamGb: 8,
    description: 'A good starting point for most everyday computers.',
    sourceName: 'Qwen 3 on Ollama',
    sourceUrl: 'https://ollama.com/library/qwen3:4b-instruct',
    licenseName: 'Apache 2.0',
    licenseUrl: APACHE_2_LICENSE_URL,
    replaces: ['qwen3:4b'],
  }),
  Object.freeze({
    id: 'qwen2.5:7b',
    label: 'More expressive',
    variant: 'Standard instruction model',
    variantKind: 'standard',
    parameterSize: '7B',
    quantization: 'Q4_K_M',
    downloadGb: 4.7,
    minRamGb: 16,
    description: 'Better writing, with slower replies and more memory use.',
    sourceName: 'Qwen 2.5 on Ollama',
    sourceUrl: 'https://ollama.com/library/qwen2.5:7b',
    licenseName: 'Apache 2.0',
    licenseUrl: APACHE_2_LICENSE_URL,
    replaces: ['qwen3:8b'],
  }),
  Object.freeze({
    id: 'qwen2.5:14b',
    label: 'Most capable here',
    variant: 'Standard instruction model',
    variantKind: 'standard',
    parameterSize: '14B',
    quantization: 'Q4_K_M',
    downloadGb: 9.0,
    minRamGb: 24,
    description: 'For powerful computers when waiting longer is acceptable.',
    sourceName: 'Qwen 2.5 on Ollama',
    sourceUrl: 'https://ollama.com/library/qwen2.5:14b',
    licenseName: 'Apache 2.0',
    licenseUrl: APACHE_2_LICENSE_URL,
    replaces: ['qwen3:14b'],
  }),
]);

// Keep this list deliberately small. This exact GGUF and quantization is
// already exercised by the hosted worker, and Hugging Face documents direct
// hf.co pulls as an Ollama-supported path. Adding a catalogue entry only allows
// Ollama to pull model data; it never downloads or executes an installer.
const ABLITERATED_MODELS = Object.freeze([
  Object.freeze({
    id: DELL_SHARED_MODEL,
    label: 'Abliterated 8B',
    variant: 'Abliterated instruction model',
    variantKind: 'abliterated',
    parameterSize: '8B',
    quantization: 'Q5_K_M',
    downloadGb: 5.73,
    minRamGb: 16,
    description: 'A less refusal-prone Llama 3.1 variant. Feddit rules and publishing limits still apply.',
    sourceName: 'mlabonne on Hugging Face',
    sourceUrl: 'https://huggingface.co/mlabonne/Meta-Llama-3.1-8B-Instruct-abliterated-GGUF',
    licenseName: 'Llama 3.1 Community License',
    licenseUrl: LLAMA_31_LICENSE_URL,
    replaces: [],
  }),
]);

const MODELS = Object.freeze([...STANDARD_MODELS, ...ABLITERATED_MODELS]);

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
  const recommended = STANDARD_MODELS[recommendationIndex(totalRamGb, logicalCpus)];
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

function replacementForLegacyGuidedModel(model) {
  return LEGACY_GUIDED_REPLACEMENTS[String(model || '')] || '';
}

module.exports = {
  DELL_SHARED_MODEL,
  DESKTOP_FALLBACK_MODEL,
  STANDARD_MODELS,
  ABLITERATED_MODELS,
  MODELS,
  LEGACY_GUIDED_REPLACEMENTS,
  bytesToGb,
  adviseHardware,
  isGuidedModel,
  replacementForLegacyGuidedModel,
};

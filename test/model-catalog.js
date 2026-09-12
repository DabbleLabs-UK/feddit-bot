'use strict';

const assert = require('node:assert/strict');
const catalog = require('../lib/model-catalog');

function gib(n) { return n * 1024 ** 3; }

assert.equal(catalog.adviseHardware({ totalMemoryBytes: gib(4), cpuCount: 2 }).recommendedModel, 'qwen2.5:1.5b');
assert.equal(catalog.adviseHardware({ totalMemoryBytes: gib(8), cpuCount: 4 }).recommendedModel, 'qwen3:4b-instruct');
assert.equal(catalog.adviseHardware({ totalMemoryBytes: gib(16), cpuCount: 8 }).recommendedModel, 'qwen2.5:7b');
assert.equal(catalog.adviseHardware({ totalMemoryBytes: gib(32), cpuCount: 16 }).recommendedModel, 'qwen2.5:14b');
assert.equal(catalog.adviseHardware({ totalMemoryBytes: gib(32), cpuCount: 4 }).recommendedModel, 'qwen3:4b-instruct');
assert.equal(catalog.isGuidedModel('qwen3:4b-instruct'), true);
assert.equal(catalog.isGuidedModel('qwen3:4b'), false);
assert.equal(catalog.isGuidedModel('unknown'), false);
assert.equal(catalog.DELL_SHARED_MODEL.includes('Meta-Llama'), true);
assert.equal(catalog.DESKTOP_FALLBACK_MODEL, 'qwen3:4b-instruct');
assert.equal(catalog.replacementForLegacyGuidedModel('qwen3:4b'), 'qwen3:4b-instruct');
assert.equal(catalog.replacementForLegacyGuidedModel('custom-model'), '');
assert.deepEqual(catalog.MODELS.find((model) => model.label === 'Balanced').replaces, ['qwen3:4b']);

const advice = catalog.adviseHardware({ totalMemoryBytes: gib(12), cpuCount: 8, platform: 'win32', arch: 'x64' });
assert.equal(advice.totalRamGb, 12);
assert.equal(advice.choices.length, 4);
assert.equal(advice.choices.filter((choice) => choice.recommended).length, 1);
assert.match(advice.basis, /GPU/);

console.log('model-catalog: all checks passed');

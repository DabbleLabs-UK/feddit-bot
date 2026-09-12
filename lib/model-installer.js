'use strict';

const { isGuidedModel } = require('./model-catalog');

function cleanProgress(model, state, progress = {}) {
  const total = Math.max(0, Number(progress.total) || 0);
  const completed = Math.max(0, Number(progress.completed) || 0);
  return {
    model,
    state,
    message: String(progress.status || (state === 'starting' ? 'Starting download' : state)),
    completed,
    total,
    percent: total > 0 ? Math.min(100, Math.round(completed / total * 100)) : null,
    error: progress.error ? String(progress.error) : null,
    updatedAt: new Date().toISOString(),
  };
}

function createModelInstaller({ pullModel, onReady, allowModel } = {}) {
  if (typeof pullModel !== 'function') throw new Error('pullModel is required.');
  const permitted = typeof allowModel === 'function' ? allowModel : isGuidedModel;
  const downloads = new Map();
  let activeModel = null;

  function get(model) {
    return downloads.get(String(model || '')) || null;
  }

  function list() {
    return Array.from(downloads.values());
  }

  function start(model) {
    const name = String(model || '').trim();
    if (!permitted(name)) throw new Error('Choose one of the guided local models.');
    if (activeModel) {
      if (activeModel === name) return get(name);
      throw new Error('Finish downloading ' + activeModel + ' before starting another model.');
    }

    activeModel = name;
    downloads.set(name, cleanProgress(name, 'starting'));
    Promise.resolve()
      .then(() => pullModel(name, (progress) => {
        downloads.set(name, cleanProgress(name, 'downloading', progress));
      }))
      .then(() => {
        downloads.set(name, cleanProgress(name, 'ready', { status: 'Ready' }));
        activeModel = null;
        if (typeof onReady === 'function') onReady(name);
      })
      .catch((error) => {
        downloads.set(name, cleanProgress(name, 'failed', {
          status: 'Download failed',
          error: error && error.message ? error.message : String(error),
        }));
        activeModel = null;
      });
    return get(name);
  }

  return { get, list, start };
}

module.exports = { cleanProgress, createModelInstaller };

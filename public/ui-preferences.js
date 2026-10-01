'use strict';

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FedditUiPreferences = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const DEVELOPER_TOOLS_KEY = 'fedditBotsDeveloperTools';

  function availableStorage(storage) {
    if (storage) return storage;
    try { return globalThis.localStorage; } catch { return null; }
  }

  function developerToolsEnabled(storage) {
    try {
      const value = availableStorage(storage);
      return Boolean(value && value.getItem(DEVELOPER_TOOLS_KEY) === '1');
    } catch {
      return false;
    }
  }

  function setDeveloperToolsEnabled(enabled, storage) {
    const value = availableStorage(storage);
    try {
      if (value) {
        if (enabled) value.setItem(DEVELOPER_TOOLS_KEY, '1');
        else value.removeItem(DEVELOPER_TOOLS_KEY);
      }
    } catch {
      // The preference remains usable for this page even when storage is blocked.
    }
    return Boolean(enabled);
  }

  function developerVisibility(enabled, isTestMode) {
    return {
      showDeveloperControls: Boolean(enabled),
      showTestModeNotice: !enabled && Boolean(isTestMode),
    };
  }

  return {
    DEVELOPER_TOOLS_KEY,
    developerToolsEnabled,
    setDeveloperToolsEnabled,
    developerVisibility,
  };
});

'use strict';

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FedditUiDisclosure = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function setExpanded(button, body, expanded) {
    const open = Boolean(expanded);
    button.setAttribute('aria-expanded', open ? 'true' : 'false');
    body.hidden = !open;
    return open;
  }

  function toggle(button, body) {
    return setExpanded(button, body, button.getAttribute('aria-expanded') !== 'true');
  }

  return { setExpanded, toggle };
});

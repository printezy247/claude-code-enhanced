'use strict';
/**
 * Mask the credentials that ride along in a URL.
 *
 * The desktop app withholds a connector's URL from the model and shows the
 * real host only on the card. CCE cannot do that half: the model talks to
 * the CLI, so the CLI owns what the model sees. What the host CAN do is keep
 * the secrets out of what is put on the user's screen — a permission card
 * that prints `?token=ghp_…` leaks a credential into a screenshot, a screen
 * share and the clipboard.
 *
 * Only the secret parts are masked: the host, the path and the parameter
 * names stay readable, so the card still says which call it is about.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CCESecrets = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // Query parameters whose name says the value is a credential.
  const SECRET_PARAM = /^(api[-_]?key|access[-_]?token|auth|authorization|bearer|client[-_]?secret|password|passwd|pwd|refresh[-_]?token|session[-_]?token|secret|signature|sig|token|key|code)$/i;

  // The userinfo part of a URL: https://user:pass@host
  const USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^/\s@]+)@/gi;

  // A key=value pair in a query string.
  const QUERY = /([?&])([A-Za-z0-9_.-]+)=([^&\s"'<>]+)/g;

  const isSecretName = (name) => SECRET_PARAM.test(String(name || ''));

  /** Mask one URL's credentials. */
  function maskUrl(url) {
    let out = String(url == null ? '' : url);
    out = out.replace(USERINFO, (_m, scheme, user, pass) => {
      // The user name is rarely a secret; the password always is.
      return scheme + user + ':<hidden>@';
    });
    out = out.replace(QUERY, (m, sep, name, value) => {
      if (!isSecretName(name)) return m;
      return sep + name + '=<hidden>';
    });
    return out;
  }

  /**
   * Mask every URL in a block of text, and every secret-looking query
   * parameter. Used for the raw tool input on a permission card.
   */
  function maskText(text) {
    let out = String(text == null ? '' : text);
    out = out.replace(/\b([a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+)/gi, (m) => maskUrl(m));
    out = out.replace(QUERY, (m, sep, name, value) => {
      if (!isSecretName(name)) return m;
      return sep + name + '=<hidden>';
    });
    return out;
  }

  /**
   * Mask a tool input for display: every string value goes through the
   * masker, so a credential in any field is hidden, not just in a URL.
   */
  function maskToolInput(input) {
    if (input == null) return input;
    if (typeof input === 'string') return maskText(input);
    if (Array.isArray(input)) return input.map(maskToolInput);
    if (typeof input !== 'object') return input;
    const out = {};
    for (const [key, value] of Object.entries(input)) {
      if (isSecretName(key) && typeof value === 'string' && value) out[key] = '<hidden>';
      else out[key] = maskToolInput(value);
    }
    return out;
  }

  return { maskUrl, maskText, maskToolInput, isSecretName };
});

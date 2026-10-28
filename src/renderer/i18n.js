// Translations (item 26): a tiny key→string layer for the core UI chrome.
// Scope is honest — nav labels, buttons and settings headings; engine output
// and chat content stay in whatever language the model answers in.
// Unknown locale or key falls back: en → the key itself (never a blank UI).

export const LOCALES = ['en', 'es', 'de'];

const dict = {
  en: {
    'nav.conversations': 'Conversations',
    'nav.board': 'Board',
    'nav.usage': 'Usage',
    'nav.providers': 'Providers',
    'nav.connectors': 'Connectors',
    'nav.settings': 'Settings',
    'btn.newChat': 'New chat',
    'btn.save': 'Save',
    'btn.cancel': 'Cancel',
    'btn.refresh': 'Refresh',
    'btn.remove': 'Remove',
    'btn.add': 'Add',
    'set.language': 'Language',
    'set.hint.language': 'Interface language. Chat content is not translated.',
    'set.spendCeiling': 'Spend ceiling',
    'set.codebaseIndex': 'Codebase index',
    'set.updates': 'Updates',
    'set.checkUpdates': 'Check for updates',
    'msg.saved': 'Settings saved',
  },
  es: {
    'nav.conversations': 'Conversaciones',
    'nav.board': 'Tablero',
    'nav.usage': 'Uso',
    'nav.providers': 'Proveedores',
    'nav.connectors': 'Conectores',
    'nav.settings': 'Ajustes',
    'btn.newChat': 'Chat nuevo',
    'btn.save': 'Guardar',
    'btn.cancel': 'Cancelar',
    'btn.refresh': 'Actualizar',
    'btn.remove': 'Quitar',
    'btn.add': 'Añadir',
    'set.language': 'Idioma',
    'set.hint.language': 'Idioma de la interfaz. El contenido del chat no se traduce.',
    'set.spendCeiling': 'Tope de gasto',
    'set.codebaseIndex': 'Índice del código',
    'set.updates': 'Actualizaciones',
    'set.checkUpdates': 'Buscar actualizaciones',
    'msg.saved': 'Ajustes guardados',
  },
  de: {
    'nav.conversations': 'Unterhaltungen',
    'nav.board': 'Board',
    'nav.usage': 'Nutzung',
    'nav.providers': 'Anbieter',
    'nav.connectors': 'Verbinder',
    'nav.settings': 'Einstellungen',
    'btn.newChat': 'Neuer Chat',
    'btn.save': 'Speichern',
    'btn.cancel': 'Abbrechen',
    'btn.refresh': 'Aktualisieren',
    'btn.remove': 'Entfernen',
    'btn.add': 'Hinzufügen',
    'set.language': 'Sprache',
    'set.hint.language': 'Sprache der Oberfläche. Chat-Inhalt wird nicht übersetzt.',
    'set.spendCeiling': 'Ausgabenlimit',
    'set.codebaseIndex': 'Code-Index',
    'set.updates': 'Updates',
    'set.checkUpdates': 'Nach Updates suchen',
    'msg.saved': 'Einstellungen gespeichert',
  },
};

let lang = 'en';

export function setLang(next) {
  lang = dict[next] ? next : 'en';
  return lang;
}
export function getLang() { return lang; }

export function t(key) {
  const k = String(key);
  return (dict[lang] && dict[lang][k]) || dict.en[k] || k;
}

/** Locales missing keys that en has — the test asserts this stays empty. */
export function incompleteLocales() {
  const missing = [];
  const enKeys = Object.keys(dict.en);
  for (const code of LOCALES) {
    if (code === 'en') continue;
    const lack = enKeys.filter((k) => !dict[code][k]);
    if (lack.length) missing.push({ locale: code, keys: lack });
  }
  return missing;
}

/** Apply translations to every [data-i18n] element in the page. */
export function applyLang(root) {
  const doc = root || (typeof document !== 'undefined' ? document : null);
  if (!doc) return 0;
  let n = 0;
  for (const el of doc.querySelectorAll('[data-i18n]')) {
    el.textContent = t(el.getAttribute('data-i18n'));
    n++;
  }
  return n;
}

// Monaco entry: expose the ESM API as the classic `monaco` global.
import * as monaco from '../node_modules/monaco-editor/esm/vs/editor/editor.main.js';

window.monaco = monaco;

// Split from the former chat.js (roadmap 4.1). Behaviour is unchanged.
import { attachFiles, toggleExpanded } from './composer.js';
import { handleEvent } from './events.js';
import { openPalette, showFind } from './panels.js';
import { activateChat, closeChat, createSession, pollContext } from './session.js';
import { renderDiff } from './tools.js';
import { chats, fixNestedFences } from './util.js';

export const Chat = { createSession, handleEvent, chats, closeChat, activateChat, showFind, openPalette, toggleExpanded, fixNestedFences, pollContext, renderDiff, attachFiles };

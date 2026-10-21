import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const findinpage = require('../src/main/findinpage.js');
const about = require('../src/main/about.js');

describe('find in page (B8)', () => {
  it('calls webContents.findInPage with expected options', () => {
    const mockWc = {
      id: 42,
      findInPage: vi.fn().mockReturnValue(123),
      stopFindInPage: vi.fn(),
    };
    const reqId = findinpage.find(mockWc, 'test query', { forward: true });
    expect(reqId).toBe(123);
    expect(mockWc.findInPage).toHaveBeenCalledWith('test query', {
      forward: true,
      findNext: false,
      matchCase: false,
    });

    findinpage.stop(mockWc, 'clearSelection');
    expect(mockWc.stopFindInPage).toHaveBeenCalledWith('clearSelection');
  });

  it('stops find when search query is empty', () => {
    const mockWc = {
      id: 43,
      findInPage: vi.fn(),
      stopFindInPage: vi.fn(),
    };
    findinpage.find(mockWc, '');
    expect(mockWc.stopFindInPage).toHaveBeenCalledWith('clearSelection');
  });
});

describe('about info (B9)', () => {
  it('returns non-empty version and credits', () => {
    const info = about.getAboutInfo();
    expect(info.name).toBe('Claude Code Enhanced');
    expect(info.version).toBeTruthy();
    expect(info.credits).toMatch(/Claude Code/);
  });
});

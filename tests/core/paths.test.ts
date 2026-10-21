import { describe, expect, it } from 'vitest';
import { defaultConfigDir } from '../../src/core/config/paths.js';

describe('defaultConfigDir', () => {
  it('CF_PAGES_CONFIG_DIR wins on every platform', () => {
    const env = { CF_PAGES_CONFIG_DIR: '/custom', XDG_CONFIG_HOME: '/xdg', APPDATA: 'C:\\Roaming' };
    expect(defaultConfigDir(env, 'linux', '/home/u')).toBe('/custom');
    expect(defaultConfigDir(env, 'win32', 'C:\\Users\\u')).toBe('/custom');
  });

  it('win32 uses %APPDATA%\\cf-pages', () => {
    expect(defaultConfigDir({ APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, 'win32', 'C:\\Users\\u')).toBe(
      'C:\\Users\\u\\AppData\\Roaming\\cf-pages',
    );
  });

  it('win32 without APPDATA falls back to the roaming profile under home', () => {
    expect(defaultConfigDir({}, 'win32', 'C:\\Users\\u')).toBe('C:\\Users\\u\\AppData\\Roaming\\cf-pages');
  });

  it('other platforms use $XDG_CONFIG_HOME/cf-pages', () => {
    expect(defaultConfigDir({ XDG_CONFIG_HOME: '/xdg' }, 'linux', '/home/u')).toBe('/xdg/cf-pages');
  });

  it('other platforms fall back to ~/.config/cf-pages', () => {
    expect(defaultConfigDir({}, 'darwin', '/Users/u')).toBe('/Users/u/.config/cf-pages');
    expect(defaultConfigDir({ XDG_CONFIG_HOME: '', CF_PAGES_CONFIG_DIR: '' }, 'linux', '/home/u')).toBe(
      '/home/u/.config/cf-pages',
    );
  });
});

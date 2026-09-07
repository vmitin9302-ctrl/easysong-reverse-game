// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { connectTelegramBridge } from './telegram';
afterEach(() => { delete window.Telegram; vi.unstubAllGlobals(); });
it('initializes a late SDK and detaches lifecycle handlers on unmount', () => {
  window.location.hash = '#tgWebAppVersion=9.0';
  const active = vi.fn(), inactive = vi.fn();
  const cleanup = connectTelegramBridge(active, inactive);
  const ready = vi.fn(), expand = vi.fn(), onEvent = vi.fn(), offEvent = vi.fn();
  window.Telegram = { WebApp: {ready,expand,onEvent,offEvent} };
  window.dispatchEvent(new Event('telegram-sdk-ready'));
  window.dispatchEvent(new Event('telegram-sdk-ready'));
  expect(ready).toHaveBeenCalledOnce(); expect(expand).toHaveBeenCalledOnce();
  expect(onEvent).toHaveBeenCalledWith('activated', active);
  expect(onEvent).toHaveBeenCalledWith('deactivated', inactive);
  cleanup();
  expect(offEvent).toHaveBeenCalledWith('activated', active);
  window.location.hash = '';
});

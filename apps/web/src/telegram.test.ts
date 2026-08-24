import { afterEach, describe, expect, it, vi } from 'vitest';
import { initTelegram } from './telegram';

afterEach(() => vi.unstubAllGlobals());

describe('initTelegram', () => {
  it('keeps an ordinary web invite independent from the Telegram SDK', () => {
    vi.stubGlobal('window', { location: { hash: '' } });
    expect(initTelegram()).toEqual({ isTelegram: false, initData: '' });
  });

  it('does not misclassify Chrome when the public Telegram SDK injects an empty WebApp object', () => {
    vi.stubGlobal('window', { location: { hash: '' }, Telegram: { WebApp: { initData: '' } } });
    expect(initTelegram()).toEqual({ isTelegram: false, initData: '' });
  });

  it('recognizes a Telegram launch even when the async SDK has not loaded yet', () => {
    vi.stubGlobal('window', {
      location: { hash: '#tgWebAppVersion=9.0&tgWebAppData=query_id%3Dabc%26start_param%3Dinvite' },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    expect(initTelegram()).toEqual({ isTelegram: true, initData: 'query_id=abc&start_param=invite', startParam: 'invite' });
  });

  it('uses the Telegram SDK when it is available', () => {
    const ready = vi.fn(), expand = vi.fn();
    vi.stubGlobal('window', {
      location: { hash: '' },
      Telegram: { WebApp: { initData: 'query_id=abc', initDataUnsafe: { start_param: 'room' }, ready, expand } },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    expect(initTelegram()).toEqual({ isTelegram: true, initData: 'query_id=abc', startParam: 'room' });
    expect(ready).toHaveBeenCalledOnce();
    expect(expand).toHaveBeenCalledOnce();
  });
});

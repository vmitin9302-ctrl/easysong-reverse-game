type TelegramWebApp = {
  initData?: string;
  initDataUnsafe?: { start_param?: string };
  ready?: () => void;
  expand?: () => void;
  onEvent?: (name: string, callback: () => void) => void;
  offEvent?: (name: string, callback: () => void) => void;
};

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
  }
}

function validateInitDataOnServer(initData: string) {
  const apiBase = ((import.meta.env.VITE_API_BASE_URL as string | undefined) || '').replace(/\/$/, '');
  if (!apiBase || !initData) return;

  void fetch(`${apiBase}/v1/auth/telegram`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ init_data: initData }),
  }).catch(() => {
    // Telegram validation must not make the audio game unavailable during a transient outage.
  });
}

export function initTelegram(): { isTelegram: boolean; initData: string; startParam?: string } {
  const webApp = window.Telegram?.WebApp;
  const launch = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const fallbackInitData = launch.get('tgWebAppData') ?? '';
  const isTelegramLaunch = Boolean(webApp?.initData || fallbackInitData || launch.get('tgWebAppVersion'));
  if (!isTelegramLaunch) return { isTelegram: false, initData: '' };

  prepareBridge(webApp);

  const initData = webApp?.initData || fallbackInitData;
  validateInitDataOnServer(initData);

  const initParams = new URLSearchParams(initData);

  return {
    isTelegram: true,
    initData,
    startParam: webApp?.initDataUnsafe?.start_param || initParams.get('start_param') || undefined,
  };
}

const prepared = new WeakSet<TelegramWebApp>();
function prepareBridge(webApp?: TelegramWebApp) {
  if (!webApp || prepared.has(webApp)) return;
  try { webApp.ready?.(); webApp.expand?.(); prepared.add(webApp); }
  catch { /* A host bridge failure must not prevent browser gameplay. */ }
}

export function connectTelegramBridge(onActivated: () => void, onDeactivated: () => void): () => void {
  let attached: TelegramWebApp | undefined;
  const detach = () => {
    attached?.offEvent?.('activated', onActivated);
    attached?.offEvent?.('deactivated', onDeactivated);
    attached = undefined;
  };
  const attach = () => {
    const webApp = window.Telegram?.WebApp;
    if (!webApp || attached === webApp || !initTelegram().isTelegram) return;
    detach(); prepareBridge(webApp); attached = webApp;
    webApp.onEvent?.('activated', onActivated);
    webApp.onEvent?.('deactivated', onDeactivated);
  };
  window.addEventListener('telegram-sdk-ready', attach);
  attach();
  return () => { window.removeEventListener('telegram-sdk-ready', attach); detach(); };
}

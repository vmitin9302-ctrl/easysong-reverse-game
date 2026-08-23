type TelegramWebApp = {
  initData?: string;
  initDataUnsafe?: { start_param?: string };
  ready?: () => void;
  expand?: () => void;
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
  if (!webApp) return { isTelegram: false, initData: '' };

  webApp.ready?.();
  webApp.expand?.();

  const initData = webApp.initData ?? '';
  validateInitDataOnServer(initData);

  return {
    isTelegram: Boolean(initData),
    initData,
    startParam: webApp.initDataUnsafe?.start_param,
  };
}

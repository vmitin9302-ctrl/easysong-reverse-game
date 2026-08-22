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

export function initTelegram(): { isTelegram: boolean; initData: string; startParam?: string } {
  const webApp = window.Telegram?.WebApp;
  if (!webApp) return { isTelegram: false, initData: '' };

  webApp.ready?.();
  webApp.expand?.();

  return {
    isTelegram: true,
    initData: webApp.initData ?? '',
    startParam: webApp.initDataUnsafe?.start_param,
  };
}

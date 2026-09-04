import { FormEvent, useEffect, useState } from 'react';
import { adminLogin, adminLogout, getAnalytics, type AnalyticsReport } from './api';
import './admin.css';

const metrics: [string, string][] = [
  ['sessions', 'Визиты и сессии'], ['clicks', 'Все клики'], ['game_starts', 'Запуски игр'],
  ['game_completions', 'Завершения'], ['local_duels', 'Локальные дуэли'], ['online_duels', 'Онлайн-дуэли'],
  ['easysong_clicks', 'Переходы в EasySong'], ['telegram_banner_clicks', 'Клики по Telegram-баннеру'],
  ['bot_starts', 'Запуски бота'], ['bot_check_clicks', '«Проверить себя»'], ['bot_game_opens', 'Переходы из бота'],
];
const SESSION_KEY = 'reverse_game_admin_session';

export default function AdminDashboard() {
  const [report, setReport] = useState<AnalyticsReport | null>(null);
  const [days, setDays] = useState(30);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = async (period = days, token = sessionStorage.getItem(SESSION_KEY) || undefined) => {
    setLoading(true); setError('');
    try { setReport(await getAnalytics(period, token)); }
    catch { sessionStorage.removeItem(SESSION_KEY); setReport(null); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, []);

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setLoading(true); setError('');
    const data = new FormData(event.currentTarget);
    try {
      const token = await adminLogin(String(data.get('username')), String(data.get('password')));
      sessionStorage.setItem(SESSION_KEY, token);
      await load(days, token);
    }
    catch { setError('Неверный логин или пароль.'); setLoading(false); }
  }

  if (!report) return <main className="admin-login">
    <form className="admin-login__card" onSubmit={login}>
      <div className="admin-logo">S</div><p className="admin-eyebrow">Сонграйтер</p>
      <h1>Статистика игры</h1><p>Войдите, чтобы посмотреть закрытый отчёт.</p>
      <label>Логин<input name="username" autoComplete="username" required /></label>
      <label>Пароль<input name="password" type="password" autoComplete="current-password" required /></label>
      {error && <div className="admin-error">{error}</div>}
      <button disabled={loading}>{loading ? 'Проверяем…' : 'Войти'}</button>
      <a href="/">← Вернуться в игру</a>
    </form>
  </main>;

  const daily = Object.entries(report.daily);
  const maxDaily = Math.max(1, ...daily.map(([, row]) => row.sessions || 0));
  return <main className="admin-page">
    <header><div><p className="admin-eyebrow">Сонграйтер · Аналитика</p><h1>Статистика игры</h1></div>
      <div className="admin-actions"><select value={days} onChange={(e) => { const next = Number(e.target.value); setDays(next); void load(next); }}>
        <option value="7">7 дней</option><option value="30">30 дней</option><option value="90">90 дней</option><option value="366">Год</option>
      </select><button onClick={() => void load()}>Обновить</button><button className="admin-quiet" onClick={() => { sessionStorage.removeItem(SESSION_KEY); void adminLogout().finally(() => setReport(null)); }}>Выйти</button></div>
    </header>
    <section className="metric-grid">{metrics.map(([key, label]) => <article key={key}><span>{label}</span><strong>{report.totals[key] || 0}</strong></article>)}</section>
    <section className="admin-panel"><h2>Сессии по дням</h2><div className="daily-chart">{daily.length ? daily.map(([date, row]) =>
      <div className="daily-bar" key={date}><b title={`${row.sessions || 0} сессий`} style={{ height: `${Math.max(5, ((row.sessions || 0) / maxDaily) * 100)}%` }} /><span>{date.slice(5)}</span></div>) : <p>Данных за этот период пока нет.</p>}</div></section>
    <section className="admin-columns"><div className="admin-panel"><h2>Популярные кнопки</h2><table><thead><tr><th>Элемент</th><th>Клики</th></tr></thead><tbody>{report.top_elements.map(row => <tr key={row.element}><td>{row.element}</td><td>{row.clicks}</td></tr>)}</tbody></table></div>
      <div className="admin-panel"><h2>Все события</h2><table><thead><tr><th>Событие</th><th>Количество</th></tr></thead><tbody>{Object.entries(report.events).sort((a,b) => b[1]-a[1]).map(([name, count]) => <tr key={name}><td>{name}</td><td>{count}</td></tr>)}</tbody></table></div></section>
    {loading && <div className="admin-loading">Обновляем данные…</div>}
  </main>;
}

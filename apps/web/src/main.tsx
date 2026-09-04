import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import AdminDashboard from './AdminDashboard';
import './extras.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {location.pathname === '/stats' ? <AdminDashboard /> : <App />}
  </StrictMode>,
);

import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { Cctv, LayoutDashboard, PlaySquare } from 'lucide-react';

import { DashboardView } from '@/pages/dashboard/DashboardView';
import { PlaybackView } from '@/pages/playback/PlaybackView';
import { useNvrHealth } from '@/hooks/health';

export const App = () => {
  const { health, refresh } = useNvrHealth();
  const connectionLabel = health === 'connected' ? 'Connected to NVR' : health === 'checking' ? 'Checking NVR…' : 'NVR unavailable';

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><Cctv size={24} /> Home <span>NVR</span></div>
      <p className="eyebrow">NVR control center</p>
      <nav>
        <NavLink to="/dashboard"><LayoutDashboard size={18} /> Dashboard</NavLink>
        <NavLink to="/playback"><PlaySquare size={18} /> Playback</NavLink>
      </nav>
      <div className={`sidebar-note ${health}`}><span /> {connectionLabel}</div>
    </aside>
    <main><Routes>
      <Route path="/dashboard" element={<DashboardView onHealthRefresh={refresh} />} />
      <Route path="/playback" element={<PlaybackView />} />
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes></main>
  </div>;
};

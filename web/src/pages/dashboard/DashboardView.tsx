import { Grid2X2, Grid3X3, Grid, RefreshCw } from 'lucide-react';
import { useState } from 'react';

import { CameraGrid } from '@/components/CameraGrid';
import { useCameras } from '@/hooks/cameras';

const gridOptions = [{ size: 1, icon: Grid }, { size: 2, icon: Grid2X2 }, { size: 3, icon: Grid3X3 }, { size: 4, icon: Grid }];

interface DashboardViewProps { onHealthRefresh: () => Promise<void>; }

export const DashboardView = ({ onHealthRefresh }: DashboardViewProps) => {
  const { cameras, isLoading, refresh } = useCameras();
  const [gridSize, setGridSize] = useState(2);
  const [streamSession, setStreamSession] = useState(0);
  const refreshDashboard = async () => {
    await Promise.all([refresh(), onHealthRefresh()]);
    setStreamSession((session) => session + 1);
  };
  return <div className="page dashboard-page"><header className="page-header"><div><p className="eyebrow">Live views</p><h1>Your property, at a glance.</h1><p className="subtle">The grid adapts to the cameras the NVR discovers.</p></div><div className="header-actions"><div className="grid-picker">{gridOptions.map(({ size, icon: Icon }) => <button key={size} className={size === gridSize ? 'selected' : ''} onClick={() => setGridSize(size)}><Icon size={16} /> {size} × {size}</button>)}</div><button className="outline-button" onClick={() => void refreshDashboard()} disabled={isLoading}><RefreshCw size={16} className={isLoading ? 'spin' : ''} /> Refresh</button></div></header>
    <div className="status-bar"><span><i className="live-dot" /> {cameras.length} cameras online</span><span>Dynamic discovery enabled</span></div>
    <CameraGrid cameras={cameras} gridSize={gridSize} streamSession={streamSession} />
  </div>;
};

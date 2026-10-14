import { Download } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';

import { nvrClient } from '@/api/rest/nvr-client';
import type { Camera } from '@/types/camera';
import { datetimeLocalToTimestamp, timeZoneName } from '@/utils/time';

interface RecordingDownloadFormProps {
  cameras: Camera[];
  activeDate?: string;
}

export const RecordingDownloadForm = ({ cameras, activeDate }: RecordingDownloadFormProps) => {
  const [cameraId, setCameraId] = useState(() => cameras[0]?.id ?? '');
  const [from, setFrom] = useState(() => activeDate ? `${activeDate}T00:00` : '');
  const [to, setTo] = useState(() => activeDate ? `${activeDate}T00:10` : '');
  const [message, setMessage] = useState('');
  const [isPreparing, setIsPreparing] = useState(false);
  const camera = useMemo(() => cameras.find((item) => item.id === cameraId) ?? cameras[0], [cameraId, cameras]);

  const download = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!camera) return;
    setIsPreparing(true);
    setMessage('Preparing your MP4…');
    try {
      const url = await nvrClient.getDownloadUrl(camera, datetimeLocalToTimestamp(from), datetimeLocalToTimestamp(to));
      const link = document.createElement('a');
      link.href = url;
      link.download = `${camera.name.toLowerCase().replaceAll(' ', '-')}-${from.replaceAll(':', '-')}.mp4`;
      document.body.append(link);
      link.click();
      link.remove();
      setMessage('Download started.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The NVR could not prepare this download.');
    } finally {
      setIsPreparing(false);
    }
  };

  return <form className="download-form" onSubmit={(event) => void download(event)}>
    <div className="download-title"><Download size={17} /><div><p className="eyebrow">Export</p><h2>Download recording</h2></div></div>
    <label>Camera<select value={cameraId || camera?.id || ''} onChange={(event) => setCameraId(event.target.value)}>{cameras.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
    <label>From<input type="datetime-local" required step="1" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
    <label>To<input type="datetime-local" required step="1" value={to} onChange={(event) => setTo(event.target.value)} /></label>
    <div className="download-actions"><span>MP4 · {timeZoneName}</span><button className="outline-button" disabled={!camera || isPreparing} type="submit"><Download size={15} /> {isPreparing ? 'Preparing…' : 'Download MP4'}</button></div>
    <p className="download-note">The MP4 is cut directly from the retained recordings, with audio. Gaps in the recording are skipped.</p>
    {message && <p className="download-message" role="status">{message}</p>}
  </form>;
};

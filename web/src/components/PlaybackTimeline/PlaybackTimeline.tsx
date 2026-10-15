import { Minus, Pause, Play, Plus, SkipBack, SkipForward } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent } from 'react';

import type { Camera, RecordingSegment } from '@/types/camera';
import { formatTime, formatTimestamp, timestampAtPosition } from '@/utils/time';

interface PlaybackTimelineProps {
  cameras: Camera[];
  segments: RecordingSegment[];
  windowStart: number;
  windowEnd: number;
  position: number;
  isPlaying: boolean;
  playbackSpeed: number;
  isLive: boolean;
  /** The playhead is being dragged; preview only. */
  onScrub: (value: number) => void;
  /** Seek to this position (a click, or the end of a drag). */
  onPositionChange: (value: number) => void;
  onSkip: (seconds: number) => void;
  onTogglePlay: () => void;
  onPlaybackSpeedChange: (value: number) => void;
}

const zoomLevels = [1, 2, 4, 8, 12, 24];

export const PlaybackTimeline = ({ cameras, segments, windowStart, windowEnd, position, isPlaying, playbackSpeed, isLive, onScrub, onPositionChange, onSkip, onTogglePlay, onPlaybackSpeedChange }: PlaybackTimelineProps) => {
  const [zoomLevel, setZoomLevel] = useState(1);
  const [viewStart, setViewStart] = useState(0);
  const scrubPositionRef = useRef(0);
  const isSeekingRef = useRef(false);
  const panRef = useRef<{ start: number; x: number; width: number } | undefined>(undefined);
  const view = useMemo(() => {
    const span = 100 / zoomLevel;
    const start = Math.max(0, Math.min(100 - span, viewStart));
    return { start, end: start + span, span };
  }, [viewStart, zoomLevel]);
  const toVisiblePosition = (value: number) => ((value - view.start) / view.span) * 100;
  const clampViewStart = (value: number, span = view.span) => Math.max(0, Math.min(100 - span, value));
  const positionFromPointer = (event: PointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const pointerPosition = ((event.clientX - bounds.left) / bounds.width) * 100;
    return Math.min(100, Math.max(0, view.start + (pointerPosition / 100) * view.span));
  };
  const scrub = (value: number) => {
    scrubPositionRef.current = value;
    onScrub(value);
  };
  const beginSeek = (event: PointerEvent<HTMLDivElement>) => {
    isSeekingRef.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    scrub(positionFromPointer(event));
  };
  const endSeek = (event: PointerEvent<HTMLDivElement>) => {
    if (!isSeekingRef.current) return;
    isSeekingRef.current = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    // A cancelled pointer carries no usable position; keep the last one.
    onPositionChange(event.type === 'pointercancel' ? scrubPositionRef.current : positionFromPointer(event));
  };
  const beginPan = (event: PointerEvent<HTMLDivElement>) => {
    if (zoomLevel === 1) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    panRef.current = { start: view.start, x: event.clientX, width: bounds.width };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const panTimeline = (event: PointerEvent<HTMLDivElement>) => {
    if (!panRef.current || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const travel = ((event.clientX - panRef.current.x) / panRef.current.width) * view.span;
    setViewStart(clampViewStart(panRef.current.start - travel));
  };
  const timestamp = timestampAtPosition(windowStart, windowEnd, position);
  const rulerPositions = [0, 16, 33, 50, 66, 83, 100];
  const zoomIndex = zoomLevels.indexOf(zoomLevel);
  const changeZoom = (nextZoom: number) => {
    const nextSpan = 100 / nextZoom;
    setViewStart(clampViewStart(position - nextSpan / 2, nextSpan));
    setZoomLevel(nextZoom);
  };
  useEffect(() => {
    if (zoomLevel === 1) return;
    const visiblePosition = (position - view.start) / view.span;
    const nextStart = visiblePosition > 0.88
      ? Math.max(0, Math.min(100 - view.span, position - view.span * 0.72))
      : visiblePosition < 0.12
        ? Math.max(0, Math.min(100 - view.span, position - view.span * 0.28))
        : view.start;
    if (nextStart === view.start) return;
    const frameId = requestAnimationFrame(() => setViewStart(nextStart));
    return () => cancelAnimationFrame(frameId);
  }, [position, view, zoomLevel]);

  return <section className="timeline-card">
    <div className="timeline-heading"><div><p className="eyebrow">Master clock</p><h2>Shared recording timeline</h2></div><span>{isLive ? 'Live' : windowEnd ? formatTimestamp(timestamp) : 'Loading timeline…'}</span></div>
    <div className={`timeline-ruler ${zoomLevel > 1 ? 'pannable' : ''}`} title={zoomLevel > 1 ? 'Drag to pan the zoomed timeline' : undefined} onPointerDown={beginPan} onPointerMove={panTimeline} onPointerUp={() => { panRef.current = undefined; }}>{rulerPositions.map((rulerPosition) => <span key={rulerPosition}>{windowEnd ? formatTime(timestampAtPosition(windowStart, windowEnd, view.start + (rulerPosition / 100) * view.span)) : '--:--'}</span>)}</div>
    <div className="recording-lanes">{cameras.map((camera, index) => <div className="recording-lane" key={camera.id}><label>{camera.name}</label><div className="lane-track" onPointerDown={beginSeek} onPointerMove={(event) => { if (isSeekingRef.current) scrub(positionFromPointer(event)); }} onPointerUp={endSeek} onPointerCancel={endSeek}>{segments.filter((segment) => segment.cameraId === camera.id).map((segment, segmentIndex) => {
      const start = Math.max(segment.start, view.start);
      const end = Math.min(segment.end, view.end);
      if (end <= start) return null;
      return <i className={`segment color-${index % 5}`} key={segmentIndex} style={{ left: `${toVisiblePosition(start)}%`, width: `${toVisiblePosition(end) - toVisiblePosition(start)}%` }} />;
    })}</div></div>)}<div className="playhead-layer"><b className="playhead" style={{ left: `${toVisiblePosition(position)}%` }} /></div></div>
    <div className="timeline-controls"><span className="zoom"><button aria-label="Zoom out timeline" disabled={zoomIndex === 0} onClick={() => changeZoom(zoomLevels[zoomIndex - 1])}><Minus size={16} /></button><span>Zoom {zoomLevel}×</span><button aria-label="Zoom in timeline" disabled={zoomIndex === zoomLevels.length - 1} onClick={() => changeZoom(zoomLevels[zoomIndex + 1])}><Plus size={16} /></button></span><div><button aria-label="Back 10 seconds" title="Back 10 s (←)" onClick={() => onSkip(-10)}><SkipBack /></button><button className="play-button" onClick={onTogglePlay} aria-label={isPlaying ? 'Pause all cameras' : 'Play all cameras'} title={isPlaying ? 'Pause (Space)' : 'Play (Space)'}>{isPlaying ? <Pause /> : <Play />}</button><button aria-label="Forward 10 seconds" title="Forward 10 s (→)" onClick={() => onSkip(10)}><SkipForward /></button></div><select className="speed" aria-label="Playback speed" disabled={isLive} title={isLive ? 'Live view always plays at 1×' : undefined} value={isLive ? 1 : playbackSpeed} onChange={(event) => onPlaybackSpeedChange(Number(event.target.value))}>{[1, 1.25, 1.5, 2, 4, 8].map((speed) => <option key={speed} value={speed}>{speed}×</option>)}</select></div>
  </section>;
};

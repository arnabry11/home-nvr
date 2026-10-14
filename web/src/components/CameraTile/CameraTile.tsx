import { CameraOff, Maximize2, Minimize2, Volume2, VolumeX } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { LiveCameraVideo } from "@/components/LiveCameraVideo";
import { RecordedCameraVideo } from "@/components/RecordedCameraVideo/RecordedCameraVideo";
import type { Camera, RecordingSpan } from "@/types/camera";

interface CameraTileProps {
  camera?: Camera;
  timestamp?: string;
  playbackStart?: number;
  masterTime?: number;
  recordingSpans?: RecordingSpan[];
  isSyncing?: boolean;
  onBufferingChange?: (cameraId: string, isBuffering: boolean) => void;
  isPlayback?: boolean;
  isFollowingLive?: boolean;
  isPlaying?: boolean;
  playbackSpeed?: number;
}

const noSpans: RecordingSpan[] = [];
const ignoreBuffering = () => undefined;

export const CameraTile = ({
  camera,
  timestamp,
  playbackStart = 0,
  masterTime = playbackStart,
  recordingSpans = noSpans,
  isSyncing = true,
  onBufferingChange = ignoreBuffering,
  isPlayback = false,
  isFollowingLive = false,
  isPlaying = false,
  playbackSpeed = 1,
}: CameraTileProps) => {
  const tileRef = useRef<HTMLElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isMuted, setIsMuted] = useState(true);
  useEffect(() => {
    const syncFullscreenState = () =>
      setIsFullscreen(document.fullscreenElement === tileRef.current);
    document.addEventListener("fullscreenchange", syncFullscreenState);
    return () =>
      document.removeEventListener("fullscreenchange", syncFullscreenState);
  }, []);
  const toggleFullscreen = async () => {
    if (!tileRef.current) return;
    if (document.fullscreenElement === tileRef.current) {
      await document.exitFullscreen();
      return;
    }
    await tileRef.current.requestFullscreen();
  };
  if (!camera)
    return (
      <article className="camera-tile empty-tile">
        <CameraOff />
        <span>Camera slot available</span>
        <small>New cameras appear after refresh</small>
      </article>
    );
  const isLive = isFollowingLive || !isPlayback;
  return (
    <article className="camera-tile" ref={tileRef}>
      {isLive ? (
        <LiveCameraVideo
          // Full resolution only when the tile fills the screen.
          stream={isFullscreen ? camera.mainStream : camera.liveStream}
          muted={isMuted}
        />
      ) : (
        <RecordedCameraVideo
          camera={camera}
          spans={recordingSpans}
          startTime={playbackStart}
          masterTime={masterTime}
          isPlaying={isPlaying}
          isSyncing={isSyncing}
          onBufferingChange={onBufferingChange}
          playbackSpeed={playbackSpeed}
          muted={isMuted}
        />
      )}
      <header>
        <span>
          <i
            className={camera.status === "online" ? "live-dot" : "offline-dot"}
          />{" "}
          {camera.name}
        </span>
        <button
          aria-label={`${isFullscreen ? "Exit fullscreen for" : "Expand"} ${camera.name}`}
          onClick={() => void toggleFullscreen()}
        >
          {isFullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
        </button>
      </header>
      <footer>
        {timestamp ? <span>{timestamp}</span> : <span />}
        <span className="tile-actions">
          <b>{isLive || !timestamp ? "LIVE" : "REC"}</b>
          <button
            aria-label={`${isMuted ? "Unmute" : "Mute"} ${camera.name}`}
            aria-pressed={!isMuted}
            onClick={() => setIsMuted((muted) => !muted)}
          >
            {isMuted ? <VolumeX size={15} /> : <Volume2 size={15} />}
          </button>
        </span>
      </footer>
    </article>
  );
};

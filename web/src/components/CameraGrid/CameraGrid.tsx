import type { Camera, RecordingSpan } from "@/types/camera";
import { CameraTile } from "@/components/CameraTile";

interface CameraGridProps {
  cameras: Camera[];
  gridSize?: number;
  flexible?: boolean;
  timestamp?: string;
  playbackStart?: number;
  masterTime?: number;
  recordingSpans?: Record<string, RecordingSpan[]>;
  isSyncing?: boolean;
  onBufferingChange?: (cameraId: string, isBuffering: boolean) => void;
  streamSession?: number;
  isPlayback?: boolean;
  isFollowingLive?: boolean;
  isPlaying?: boolean;
  playbackSpeed?: number;
}

export const CameraGrid = ({
  cameras,
  gridSize,
  flexible = false,
  timestamp,
  playbackStart,
  masterTime,
  recordingSpans,
  isSyncing,
  onBufferingChange,
  streamSession = 0,
  isPlayback = false,
  isFollowingLive = false,
  isPlaying = false,
  playbackSpeed = 1,
}: CameraGridProps) => (
  <section
    className={`camera-grid ${flexible ? `flexible-grid camera-count-${cameras.length}` : `grid-${gridSize}`}`}
    aria-label="Camera grid"
  >
    {Array.from(
      { length: flexible ? cameras.length : (gridSize ?? 1) ** 2 },
      (_, index) => {
        const camera = cameras[index];
        return (
          <CameraTile
            key={`${camera?.id ?? `slot-${index}`}-${streamSession}`}
            camera={camera}
            timestamp={timestamp}
            playbackStart={playbackStart}
            masterTime={masterTime}
            recordingSpans={camera ? recordingSpans?.[camera.id] : undefined}
            isSyncing={isSyncing}
            onBufferingChange={onBufferingChange}
            isPlayback={isPlayback}
            isFollowingLive={isFollowingLive}
            isPlaying={isPlaying}
            playbackSpeed={playbackSpeed}
          />
        );
      },
    )}
  </section>
);

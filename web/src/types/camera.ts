export type CameraStatus = "online" | "offline";

export interface Camera {
  id: string;
  name: string;
  status: CameraStatus;
  /** go2rtc stream name; also the MediaMTX recording path and live service camera. */
  mainStream: string;
}

/** A continuous stretch of recording, in epoch milliseconds. */
export interface RecordingSpan {
  start: number;
  end: number;
}

export interface RecordingSegment {
  cameraId: string;
  start: number;
  end: number;
}

export interface PlaybackData {
  segments: RecordingSegment[];
  /** Recording spans per camera id; a span still being recorded never ends. */
  spans: Record<string, RecordingSpan[]>;
  windowStart: number;
  windowEnd: number;
}

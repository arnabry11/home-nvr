export type CameraStatus = "online" | "offline";

export interface Camera {
  id: string;
  name: string;
  status: CameraStatus;
  /** Full-resolution go2rtc stream; also the MediaMTX recording path. */
  mainStream: string;
  /** Low-resolution go2rtc stream used for the live grid. */
  liveStream: string;
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
  windowStart: number;
  windowEnd: number;
}

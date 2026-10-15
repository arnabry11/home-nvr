import type { Camera, PlaybackData, RecordingSpan } from "@/types/camera";
import { dayBounds, positionAtTimestamp } from "@/utils/time";

// All are reverse-proxied on the same origin: by Vite in development and by
// nginx in the container.
const go2rtcOrigin = "/api/go2rtc";
const playbackOrigin = "/api/mediamtx";
const liveOrigin = "/api/live";
// A span that ended this recently is the one MediaMTX is still writing.
const growingSpanThresholdMs = 2 * 60 * 1_000;

interface MediamtxSpan {
  start: string;
  duration: number;
}

const requestJson = async <Response>(
  url: string,
  signal?: AbortSignal,
): Promise<Response> => {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`NVR returned ${response.status} for ${url}`);
  return response.json() as Promise<Response>;
};

const formatCameraName = (name: string) =>
  name.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());

const listSpans = async (
  camera: Camera,
  start?: number,
  end?: number,
): Promise<RecordingSpan[]> => {
  const query = new URLSearchParams({ path: camera.mainStream });
  if (start !== undefined) query.set("start", new Date(start).toISOString());
  if (end !== undefined) query.set("end", new Date(end).toISOString());
  const response = await fetch(`${playbackOrigin}/list?${query}`);
  // MediaMTX answers 404 when a path has no recordings in the range.
  if (response.status === 404) return [];
  if (!response.ok) throw new Error(`NVR returned ${response.status} for recordings`);
  const spans = (await response.json()) as MediamtxSpan[];
  return spans.map((span) => {
    const spanStart = new Date(span.start).getTime();
    return { start: spanStart, end: spanStart + span.duration * 1_000 };
  });
};

export const nvrClient = {
  async getHealth(): Promise<void> {
    await requestJson(`${go2rtcOrigin}/api`);
  },
  async discoverCameras(): Promise<Camera[]> {
    const streams = await requestJson<Record<string, unknown>>(
      `${go2rtcOrigin}/api/streams`,
    );
    return Object.keys(streams)
      .sort()
      .map((name) => ({
        id: name,
        name: formatCameraName(name),
        status: "online" as const,
        mainStream: name,
      }));
  },
  listSpans,
  async getPlaybackData(cameras: Camera[], day: string): Promise<PlaybackData> {
    const { start, end } = dayBounds(day);
    const spansByCamera = await Promise.all(
      cameras.map(async (camera) => ({
        camera,
        spans: await listSpans(camera, start, end),
      })),
    );
    return {
      segments: spansByCamera.flatMap(({ camera, spans }) =>
        spans.map((span) => ({
          cameraId: camera.id,
          start: positionAtTimestamp(start, end, Math.max(span.start, start)),
          end: positionAtTimestamp(start, end, Math.min(span.end, end)),
        })),
      ),
      spans: Object.fromEntries(
        spansByCamera.map(({ camera, spans }) => [
          camera.id,
          spans.map((span) =>
            Date.now() - span.end < growingSpanThresholdMs
              ? { ...span, end: Number.POSITIVE_INFINITY }
              : span,
          ),
        ]),
      ),
      windowStart: start,
      windowEnd: end,
    };
  },
  playbackUrl(
    camera: Camera,
    start: number,
    durationSeconds: number,
    format: "fmp4" | "mp4" = "fmp4",
  ) {
    return `${playbackOrigin}/get?${new URLSearchParams({
      path: camera.mainStream,
      start: new Date(start).toISOString(),
      duration: String(durationSeconds),
      format,
    })}`;
  },
  async getDownloadUrl(camera: Camera, start: number, end: number) {
    if (end <= start) throw new Error("The end time must be after the start time.");
    const spans = await listSpans(camera, start, end);
    if (!spans.some((span) => span.end > start && span.start < end))
      throw new Error("There is no recording for this camera in the selected range.");
    return this.playbackUrl(camera, start, (end - start) / 1_000, "mp4");
  },
  /** An endless fMP4 following the camera's newest recording. */
  liveUrl(stream: string, session: number) {
    return `${liveOrigin}/${encodeURIComponent(stream)}?${new URLSearchParams({
      session: String(session),
    })}`;
  },
};

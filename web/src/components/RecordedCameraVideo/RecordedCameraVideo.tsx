import { useEffect, useRef, useState } from "react";

import { nvrClient } from "@/api/rest/nvr-client";
import type { Camera, RecordingSpan } from "@/types/camera";

interface RecordedCameraVideoProps {
  camera: Camera;
  spans: RecordingSpan[];
  /** Where the user last sought to; the video reloads there on change. */
  startTime: number;
  /** The shared playback clock the video follows. */
  masterTime: number;
  isPlaying: boolean;
  /** False while the user drags the playhead, so the video waits for release. */
  isSyncing: boolean;
  playbackSpeed: number;
  muted: boolean;
  onBufferingChange: (cameraId: string, isBuffering: boolean) => void;
}

// MediaMTX streams each request progressively, so a long window costs nothing
// up front; past its end the drift check below loads the next one.
const windowSeconds = 60 * 60;
const maximumDriftMs = 1_500;
const reloadCooldownMs = 2_000;
// A camera that cannot buffer stops holding back the shared clock.
const bufferingTimeoutMs = 5_000;

const isRecordedAt = (spans: RecordingSpan[], time: number) =>
  spans.some((span) => span.start <= time && time < span.end);

export const RecordedCameraVideo = ({
  camera,
  spans,
  startTime,
  masterTime,
  isPlaying,
  isSyncing,
  playbackSpeed,
  muted,
  onBufferingChange,
}: RecordedCameraVideoProps) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const playStateRef = useRef({ isPlaying, playbackSpeed });
  // Wall-clock time at the video's currentTime 0; undefined while unloaded.
  const loadedStartRef = useRef<number | undefined>(undefined);
  const lastLoadRef = useRef(0);
  const syncRef = useRef<(time: number, force: boolean) => void>(() => undefined);
  const [hasError, setHasError] = useState(false);
  const isInGap = !isRecordedAt(spans, masterTime);

  useEffect(() => {
    syncRef.current = (time, force) => {
      const video = videoRef.current;
      if (!video) return;
      if (!isRecordedAt(spans, time)) {
        if (loadedStartRef.current !== undefined) {
          loadedStartRef.current = undefined;
          video.removeAttribute("src");
          video.load();
          onBufferingChange(camera.id, false);
        }
        return;
      }
      const loadedStart = loadedStartRef.current;
      const drift =
        loadedStart === undefined
          ? Number.POSITIVE_INFINITY
          : Math.abs(loadedStart + video.currentTime * 1_000 - time);
      if (!force && drift < maximumDriftMs) return;
      if (!force && performance.now() - lastLoadRef.current < reloadCooldownMs)
        return;
      loadedStartRef.current = time;
      lastLoadRef.current = performance.now();
      video.src = nvrClient.playbackUrl(camera, time, windowSeconds);
      video.playbackRate = playStateRef.current.playbackSpeed;
      if (playStateRef.current.isPlaying)
        void video.play().catch(() => undefined);
    };
  });

  useEffect(() => {
    if (videoRef.current) videoRef.current.muted = muted;
  }, [muted]);

  useEffect(() => {
    playStateRef.current = { isPlaying, playbackSpeed };
    const video = videoRef.current;
    if (!video) return;
    video.playbackRate = playbackSpeed;
    if (isPlaying && loadedStartRef.current !== undefined)
      void video.play().catch(() => undefined);
    else video.pause();
  }, [isPlaying, playbackSpeed]);

  useEffect(() => {
    syncRef.current(startTime, true);
  }, [camera, startTime]);

  useEffect(() => {
    if (isPlaying && isSyncing) syncRef.current(masterTime, false);
  }, [isPlaying, isSyncing, masterTime, spans]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let bufferingTimeoutId: number | undefined;
    const setBuffering = (isBuffering: boolean) => {
      window.clearTimeout(bufferingTimeoutId);
      onBufferingChange(camera.id, isBuffering);
      if (isBuffering)
        bufferingTimeoutId = window.setTimeout(
          () => onBufferingChange(camera.id, false),
          bufferingTimeoutMs,
        );
    };
    const onWaiting = () => setBuffering(true);
    const onReady = () => {
      setHasError(false);
      setBuffering(false);
    };
    const onError = () => {
      // Removing the source on a gap also raises an error; ignore that one.
      if (loadedStartRef.current === undefined) return;
      setHasError(true);
      setBuffering(false);
    };
    video.addEventListener("waiting", onWaiting);
    video.addEventListener("playing", onReady);
    video.addEventListener("canplay", onReady);
    video.addEventListener("error", onError);
    return () => {
      window.clearTimeout(bufferingTimeoutId);
      video.removeEventListener("waiting", onWaiting);
      video.removeEventListener("playing", onReady);
      video.removeEventListener("canplay", onReady);
      video.removeEventListener("error", onError);
      onBufferingChange(camera.id, false);
    };
  }, [camera.id, onBufferingChange]);

  useEffect(() => {
    const video = videoRef.current;
    return () => {
      video?.removeAttribute("src");
      video?.load();
    };
  }, []);

  return (
    <>
      {(isInGap || hasError) && (
        <span className="stream-error">No recording at this time</span>
      )}
      <video ref={videoRef} className="camera-video" muted playsInline />
    </>
  );
};

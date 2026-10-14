import { useEffect, useRef, useState } from "react";

import { nvrClient } from "@/api/rest/nvr-client";
import type { Camera } from "@/types/camera";

interface RecordedCameraVideoProps {
  camera: Camera;
  startTime: number;
  isPlaying: boolean;
  playbackSpeed: number;
  muted: boolean;
}

// MediaMTX streams each request progressively, so a long window costs nothing
// up front; when it runs out the player continues with the next window.
const windowSeconds = 60 * 60;

export const RecordedCameraVideo = ({
  camera,
  startTime,
  isPlaying,
  playbackSpeed,
  muted,
}: RecordedCameraVideoProps) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const playStateRef = useRef({ isPlaying, playbackSpeed });
  const [status, setStatus] = useState<"loading" | "error">("loading");

  useEffect(() => {
    if (videoRef.current) videoRef.current.muted = muted;
  }, [muted]);

  useEffect(() => {
    playStateRef.current = { isPlaying, playbackSpeed };
    const video = videoRef.current;
    if (!video) return;
    video.playbackRate = playbackSpeed;
    if (isPlaying) void video.play().catch(() => undefined);
    else video.pause();
  }, [isPlaying, playbackSpeed]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let windowStart = startTime;
    const load = () => {
      video.src = nvrClient.playbackUrl(camera, windowStart, windowSeconds);
      video.playbackRate = playStateRef.current.playbackSpeed;
      if (playStateRef.current.isPlaying) void video.play().catch(() => undefined);
    };
    const continueWithNextWindow = () => {
      windowStart += windowSeconds * 1_000;
      if (windowStart < Date.now()) load();
    };
    const showError = () => setStatus("error");
    const clearError = () => setStatus("loading");
    video.addEventListener("ended", continueWithNextWindow);
    video.addEventListener("error", showError);
    video.addEventListener("loadeddata", clearError);
    load();
    return () => {
      video.removeEventListener("ended", continueWithNextWindow);
      video.removeEventListener("error", showError);
      video.removeEventListener("loadeddata", clearError);
      video.removeAttribute("src");
      video.load();
    };
  }, [camera, startTime]);

  return (
    <>
      {status === "error" && (
        <span className="stream-error">No recording at this time</span>
      )}
      <video ref={videoRef} className="camera-video" muted playsInline />
    </>
  );
};

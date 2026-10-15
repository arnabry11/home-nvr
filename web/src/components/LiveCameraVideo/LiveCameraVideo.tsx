import { useEffect, useRef, useState } from "react";

import { nvrClient } from "@/api/rest/nvr-client";
import type { Camera } from "@/types/camera";
import { catchUpTime } from "@/utils/live";

interface LiveCameraVideoProps {
  camera: Camera;
  muted: boolean;
}

// The live service ends the stream when a recording restarts or stalls.
const reconnectDelayMs = 2_000;

export const LiveCameraVideo = ({ camera, muted }: LiveCameraVideoProps) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [session, setSession] = useState(0);
  const [isUnavailable, setIsUnavailable] = useState(false);

  useEffect(() => {
    if (videoRef.current) videoRef.current.muted = muted;
  }, [muted]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let reconnectId: number | undefined;
    const reconnect = () => {
      window.clearTimeout(reconnectId);
      reconnectId = window.setTimeout(
        () => setSession((value) => value + 1),
        reconnectDelayMs,
      );
    };
    const onError = () => {
      setIsUnavailable(true);
      reconnect();
    };
    const onPlaying = () => setIsUnavailable(false);
    const onTimeUpdate = () => {
      const { buffered } = video;
      const target = catchUpTime(
        video.currentTime,
        buffered.length ? buffered.end(buffered.length - 1) : undefined,
      );
      if (target !== undefined) video.currentTime = target;
    };
    video.addEventListener("ended", reconnect);
    video.addEventListener("error", onError);
    video.addEventListener("playing", onPlaying);
    video.addEventListener("timeupdate", onTimeUpdate);
    video.src = nvrClient.liveUrl(camera.mainStream, session);
    void video.play().catch(() => undefined);
    return () => {
      window.clearTimeout(reconnectId);
      video.removeEventListener("ended", reconnect);
      video.removeEventListener("error", onError);
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("timeupdate", onTimeUpdate);
      video.removeAttribute("src");
      video.load();
    };
  }, [camera.mainStream, session]);

  return (
    <>
      {isUnavailable && (
        <span className="stream-error">Live view unavailable, retrying</span>
      )}
      <video ref={videoRef} className="camera-video" autoPlay muted playsInline />
    </>
  );
};

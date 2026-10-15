import { useEffect, useRef, useState } from "react";

import { nvrClient } from "@/api/rest/nvr-client";
import type { Camera } from "@/types/camera";
import { catchUpTime } from "@/utils/live";

interface LiveCameraVideoProps {
  camera: Camera;
  muted: boolean;
}

// A failed request (for example a camera that stopped recording) retries
// after this; a stream the live service ended reconnects at once.
const reconnectDelayMs = 2_000;
// A stream can stop arriving without any event (a half-open connection after
// sleep or a network change), so a picture that stops moving retries too.
const stalledAfterMs = 10_000;
const progressCheckMs = 1_000;

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
    const reconnectNow = () => setSession((value) => value + 1);
    const onError = () => {
      setIsUnavailable(true);
      window.clearTimeout(reconnectId);
      reconnectId = window.setTimeout(reconnectNow, reconnectDelayMs);
    };
    let lastTime = Number.NaN;
    let lastProgress = Date.now();
    const progressId = window.setInterval(() => {
      // Hidden tabs may stop playback on purpose; they get a fresh 10 s.
      if (document.hidden || video.currentTime !== lastTime) {
        lastTime = video.currentTime;
        lastProgress = Date.now();
      } else if (Date.now() - lastProgress >= stalledAfterMs) {
        // Once per stall, even if the new session takes a while to render.
        lastProgress = Date.now();
        setIsUnavailable(true);
        reconnectNow();
      }
    }, progressCheckMs);
    const onPlaying = () => setIsUnavailable(false);
    const onTimeUpdate = () => {
      const { buffered } = video;
      const target = catchUpTime(
        video.currentTime,
        buffered.length ? buffered.end(buffered.length - 1) : undefined,
      );
      if (target !== undefined) video.currentTime = target;
    };
    video.addEventListener("ended", reconnectNow);
    video.addEventListener("error", onError);
    video.addEventListener("playing", onPlaying);
    video.addEventListener("timeupdate", onTimeUpdate);
    video.src = nvrClient.liveUrl(camera.mainStream, session);
    void video.play().catch(() => undefined);
    return () => {
      window.clearTimeout(reconnectId);
      window.clearInterval(progressId);
      video.removeEventListener("ended", reconnectNow);
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

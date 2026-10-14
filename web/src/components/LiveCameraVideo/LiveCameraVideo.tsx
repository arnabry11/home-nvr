import { useEffect, useRef, useState } from "react";

import { nvrClient } from "@/api/rest/nvr-client";

interface LiveCameraVideoProps {
  stream: string;
  muted: boolean;
}

// Codecs go2rtc may offer over MSE; it picks the ones this browser accepts.
const candidateCodecs = [
  "avc1.640029",
  "avc1.64002A",
  "avc1.640033",
  "hvc1.1.6.L153.B0",
  "mp4a.40.2",
  "mp4a.40.5",
  "flac",
  "opus",
];
// Live view should stay close to real time and not hoard memory.
const maximumLatencySeconds = 3;
const retainedSeconds = 10;

export const LiveCameraVideo = ({ stream, muted }: LiveCameraVideoProps) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [status, setStatus] = useState<"connecting" | "error">("connecting");

  useEffect(() => {
    if (videoRef.current) videoRef.current.muted = muted;
  }, [muted]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const mediaSource = new MediaSource();
    const pending: ArrayBuffer[] = [];
    let sourceBuffer: SourceBuffer | undefined;
    let socket: WebSocket | undefined;
    let isUnmounted = false;

    const fail = () => {
      if (!isUnmounted) setStatus("error");
    };
    const appendNext = () => {
      if (!sourceBuffer || sourceBuffer.updating) return;
      const { buffered } = sourceBuffer;
      if (buffered.length) {
        const end = buffered.end(buffered.length - 1);
        if (end - video.currentTime > maximumLatencySeconds)
          video.currentTime = end - 0.5;
        if (video.currentTime - buffered.start(0) > retainedSeconds * 2) {
          sourceBuffer.remove(buffered.start(0), video.currentTime - retainedSeconds);
          return;
        }
      }
      const next = pending.shift();
      if (next) sourceBuffer.appendBuffer(next);
    };
    const connect = () => {
      socket = new WebSocket(nvrClient.liveSocketUrl(stream));
      socket.binaryType = "arraybuffer";
      socket.onopen = () => {
        const codecs = candidateCodecs.filter((codec) =>
          MediaSource.isTypeSupported(`video/mp4; codecs="${codec}"`),
        );
        socket?.send(JSON.stringify({ type: "mse", value: codecs.join() }));
      };
      socket.onmessage = ({ data }) => {
        if (isUnmounted) return;
        if (typeof data === "string") {
          const message = JSON.parse(data) as { type: string; value: string };
          if (message.type === "error") return fail();
          if (message.type !== "mse" || sourceBuffer) return;
          sourceBuffer = mediaSource.addSourceBuffer(message.value);
          sourceBuffer.mode = "segments";
          sourceBuffer.addEventListener("updateend", appendNext);
          sourceBuffer.addEventListener("error", fail);
          void video.play().catch(() => undefined);
          return;
        }
        pending.push(data as ArrayBuffer);
        appendNext();
      };
      socket.onerror = fail;
    };
    const objectUrl = URL.createObjectURL(mediaSource);
    video.src = objectUrl;
    mediaSource.addEventListener("sourceopen", connect, { once: true });
    return () => {
      isUnmounted = true;
      socket?.close();
      URL.revokeObjectURL(objectUrl);
    };
  }, [stream]);

  return (
    <>
      {status === "error" && (
        <span className="stream-error">Live stream unavailable</span>
      )}
      <video ref={videoRef} className="camera-video" autoPlay muted playsInline />
    </>
  );
};

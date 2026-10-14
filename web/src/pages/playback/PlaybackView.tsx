import { CalendarDays, Check, Film, Radio, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { nvrClient } from "@/api/rest/nvr-client";
import { CameraGrid } from "@/components/CameraGrid";
import { PlaybackTimeline } from "@/components/PlaybackTimeline";
import { RecordingDownloadForm } from "@/components/RecordingDownloadForm/RecordingDownloadForm";
import { useCameras } from "@/hooks/cameras";
import type { PlaybackData } from "@/types/camera";
import {
  dayKey,
  formatDate,
  formatTimestamp,
  positionAtTimestamp,
  recordedTimeFrom,
  timestampAtPosition,
} from "@/utils/time";

const todayRefreshMs = 30_000;
// Playback this close to now hands over to the live streams.
const liveEdgeMs = 10_000;
const skipSeconds = 10;
const longSkipSeconds = 60;

export const PlaybackView = () => {
  const { cameras } = useCameras();
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [playbackData, setPlaybackData] = useState<PlaybackData>({
    segments: [],
    spans: {},
    windowStart: 0,
    windowEnd: 0,
  });
  const [availableDates, setAvailableDates] = useState<string[]>([]);
  const [position, setPosition] = useState(0);
  const [loadPosition, setLoadPosition] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [selectedDate, setSelectedDate] = useState<string>();
  const [isCalendarOpen, setIsCalendarOpen] = useState(false);
  const [isFollowingLive, setIsFollowingLive] = useState(false);
  const [isScrubbing, setIsScrubbing] = useState(false);
  const [bufferingIds, setBufferingIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const positionRef = useRef(position);
  const followLiveRef = useRef<() => void>(() => undefined);
  const previousFrameRef = useRef<number | undefined>(undefined);
  const effectiveSelectedIds = useMemo(
    () =>
      selectedIds.length > 0
        ? selectedIds
        : cameras.slice(0, 1).map(({ id }) => id),
    [cameras, selectedIds],
  );
  const selectedCameras = useMemo(
    () => cameras.filter((camera) => effectiveSelectedIds.includes(camera.id)),
    [cameras, effectiveSelectedIds],
  );
  const selectedSpans = useMemo(
    () => selectedCameras.flatMap((camera) => playbackData.spans[camera.id] ?? []),
    [playbackData.spans, selectedCameras],
  );
  useEffect(() => {
    let isCurrent = true;
    void Promise.all(selectedCameras.map((camera) => nvrClient.listSpans(camera)))
      .then((spansByCamera) => {
        const dates = new Set<string>();
        spansByCamera.flat().forEach((span) => {
          for (let day = span.start; day < span.end; day += 86_400_000)
            dates.add(dayKey(day));
          dates.add(dayKey(span.end));
        });
        if (isCurrent)
          setAvailableDates([...dates].sort((left, right) => right.localeCompare(left)));
      })
      .catch(() => undefined);
    return () => {
      isCurrent = false;
    };
  }, [selectedCameras]);
  const activeDate =
    selectedDate && availableDates.includes(selectedDate)
      ? selectedDate
      : availableDates[0];
  useEffect(() => {
    if (!activeDate) return;
    const isToday = activeDate === dayKey(Date.now());
    let isCurrent = true;
    const load = () => {
      void nvrClient
        .getPlaybackData(selectedCameras, activeDate)
        .then((data) => {
          if (isCurrent) setPlaybackData(data);
        })
        .catch(() => undefined);
    };
    const requestId = window.setTimeout(load, 180);
    // Today's recordings keep growing; keep the lanes current.
    const refreshId = isToday
      ? window.setInterval(load, todayRefreshMs)
      : undefined;
    return () => {
      isCurrent = false;
      window.clearTimeout(requestId);
      window.clearInterval(refreshId);
    };
  }, [activeDate, selectedCameras]);
  const handleBufferingChange = useCallback(
    (cameraId: string, isBuffering: boolean) =>
      setBufferingIds((ids) => {
        if (ids.has(cameraId) === isBuffering) return ids;
        const next = new Set(ids);
        if (isBuffering) next.add(cameraId);
        else next.delete(cameraId);
        return next;
      }),
    [],
  );
  useEffect(() => {
    positionRef.current = position;
  }, [position]);
  const isClockHeld = bufferingIds.size > 0 || isScrubbing;
  useEffect(() => {
    if (
      !isPlaying ||
      isFollowingLive ||
      isClockHeld ||
      playbackData.windowEnd <= playbackData.windowStart
    )
      return;
    const dayDurationSeconds =
      (playbackData.windowEnd - playbackData.windowStart) / 1_000;
    const isToday = activeDate === dayKey(Date.now());
    previousFrameRef.current = undefined;
    let frameId = 0;
    const advance = (now: number) => {
      const previousFrame = previousFrameRef.current ?? now;
      previousFrameRef.current = now;
      let nextPosition =
        positionRef.current +
        ((now - previousFrame) / 1_000 / dayDurationSeconds) *
          100 *
          playbackSpeed;
      const nextTime = timestampAtPosition(
        playbackData.windowStart,
        playbackData.windowEnd,
        nextPosition,
      );
      if (isToday && nextTime >= Date.now() - liveEdgeMs) {
        followLiveRef.current();
        return;
      }
      // Skip stretches where none of the selected cameras recorded.
      const recordedTime = recordedTimeFrom(selectedSpans, nextTime);
      if (recordedTime === undefined && !isToday) nextPosition = 100;
      else if (recordedTime !== undefined && recordedTime > nextTime)
        nextPosition = positionAtTimestamp(
          playbackData.windowStart,
          playbackData.windowEnd,
          recordedTime,
        );
      if (nextPosition >= 100) {
        positionRef.current = 100;
        setPosition(100);
        setIsPlaying(false);
        return;
      }
      positionRef.current = nextPosition;
      setPosition(nextPosition);
      frameId = requestAnimationFrame(advance);
    };
    frameId = requestAnimationFrame(advance);
    return () => {
      cancelAnimationFrame(frameId);
      previousFrameRef.current = undefined;
    };
  }, [
    activeDate,
    isClockHeld,
    isFollowingLive,
    isPlaying,
    playbackData.windowEnd,
    playbackData.windowStart,
    playbackSpeed,
    selectedSpans,
  ]);
  useEffect(() => {
    if (!isFollowingLive || selectedCameras.length === 0) return;
    const resyncLivePosition = () => {
      const livePosition = positionAtTimestamp(
        playbackData.windowStart,
        playbackData.windowEnd,
        Date.now(),
      );
      const dayDurationSeconds =
        (playbackData.windowEnd - playbackData.windowStart) / 1_000;
      const maximumDrift =
        dayDurationSeconds > 0 ? (5 / dayDurationSeconds) * 100 : 0;
      if (Math.abs(livePosition - positionRef.current) > maximumDrift) {
        positionRef.current = livePosition;
        setPosition(livePosition);
      }
    };
    const intervalId = window.setInterval(resyncLivePosition, 10_000);
    return () => window.clearInterval(intervalId);
  }, [
    isFollowingLive,
    playbackData.windowEnd,
    playbackData.windowStart,
    selectedCameras,
  ]);
  const toggleCamera = (id: string) => {
    setIsFollowingLive(false);
    setSelectedIds((ids) => {
      const current =
        ids.length > 0 ? ids : cameras.slice(0, 1).map((camera) => camera.id);
      return current.includes(id)
        ? current.filter((item) => item !== id)
        : [...current, id];
    });
  };
  const scrub = (value: number) => {
    setIsFollowingLive(false);
    setIsScrubbing(true);
    positionRef.current = value;
    setPosition(value);
  };
  const seek = (value: number, { snapToRecording = true } = {}) => {
    const { windowStart, windowEnd } = playbackData;
    const time = timestampAtPosition(windowStart, windowEnd, value);
    // Landing in a gap jumps ahead to the next recording.
    const recordedTime = snapToRecording
      ? recordedTimeFrom(selectedSpans, time)
      : undefined;
    const target =
      recordedTime !== undefined && recordedTime > time
        ? positionAtTimestamp(windowStart, windowEnd, recordedTime)
        : value;
    setIsFollowingLive(false);
    setIsScrubbing(false);
    positionRef.current = target;
    setPosition(target);
    setLoadPosition(target);
  };
  const skip = (seconds: number) => {
    const { windowStart, windowEnd } = playbackData;
    if (windowEnd <= windowStart) return;
    const step = ((seconds * 1_000) / (windowEnd - windowStart)) * 100;
    seek(Math.min(100, Math.max(0, positionRef.current + step)), {
      snapToRecording: false,
    });
  };
  const followLive = () => {
    if (selectedCameras.length === 0) return;
    const today = dayKey(Date.now());
    setIsFollowingLive(true);
    setSelectedDate(today);
    setPlaybackSpeed(1);
    const livePosition =
      activeDate === today
        ? positionAtTimestamp(
            playbackData.windowStart,
            playbackData.windowEnd,
            Date.now(),
          )
        : positionAtTimestamp(
            new Date().setHours(0, 0, 0, 0),
            new Date().setHours(24, 0, 0, 0),
            Date.now(),
          );
    positionRef.current = livePosition;
    setPosition(livePosition);
    setLoadPosition(livePosition);
    setIsPlaying(true);
  };
  const shortcutRef = useRef<(event: KeyboardEvent) => void>(() => undefined);
  useEffect(() => {
    followLiveRef.current = followLive;
    shortcutRef.current = (event) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("input, select, textarea, [contenteditable]")) return;
      if (event.key === " ") {
        // A focused button already handles Space itself.
        if (target?.closest("button")) return;
        event.preventDefault();
        setIsPlaying((value) => !value);
      } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        const seconds = event.shiftKey ? longSkipSeconds : skipSeconds;
        skip(event.key === "ArrowLeft" ? -seconds : seconds);
      } else if (event.key === "l" || event.key === "L") {
        followLive();
      }
    };
  });
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => shortcutRef.current(event);
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  const selectedTimestamp = timestampAtPosition(
    playbackData.windowStart,
    playbackData.windowEnd,
    position,
  );
  const playbackStart = timestampAtPosition(
    playbackData.windowStart,
    playbackData.windowEnd,
    loadPosition,
  );
  return (
    <div className="page playback-page">
      <header className="page-header">
        <div>
          <p className="eyebrow">Investigate</p>
          <h1>Synchronized playback.</h1>
          <p className="subtle">
            One timestamp drives every selected camera. Gaps stay visible.
          </p>
        </div>
        <div className="header-actions">
          <button
            className={
              isFollowingLive
                ? "outline-button selected-live-button"
                : "outline-button"
            }
            onClick={followLive}
          >
            <Radio size={16} /> {isFollowingLive ? "Following live" : "Live"}
          </button>
          <div className="calendar-control">
            <button
              className="outline-button"
              onClick={() => setIsCalendarOpen((open) => !open)}
            >
              <CalendarDays size={16} />{" "}
              {playbackData.windowEnd
                ? formatDate(selectedTimestamp)
                : "Loading recordings…"}
            </button>
            {isCalendarOpen && (
              <div className="calendar-popover">
                <p className="eyebrow">Dates with recordings</p>
                {availableDates.map((date) => (
                  <button
                    className={date === activeDate ? "selected" : ""}
                    key={date}
                    onClick={() => {
                      setIsFollowingLive(false);
                      positionRef.current = 0;
                      setSelectedDate(date);
                      setPosition(0);
                      setLoadPosition(0);
                      setIsCalendarOpen(false);
                    }}
                  >
                    {formatDate(new Date(`${date}T00:00:00`).getTime())}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </header>
      <div className="playback-layout">
        <aside className="camera-picker">
          <div className="picker-title">
            <Film size={17} />
            <span>Camera selection</span>
            <b>{effectiveSelectedIds.length}</b>
          </div>
          <label className="search">
            <Search size={15} />
            <input placeholder="Filter cameras" />
          </label>
          {cameras.map((camera) => (
            <button
              className="camera-choice"
              key={camera.id}
              onClick={() => toggleCamera(camera.id)}
            >
              <span
                className={
                  effectiveSelectedIds.includes(camera.id)
                    ? "checkbox checked"
                    : "checkbox"
                }
              >
                {effectiveSelectedIds.includes(camera.id) && (
                  <Check size={13} />
                )}
              </span>
              <span className="camera-monogram">{camera.name.slice(0, 1)}</span>
              <span>
                <b>{camera.name}</b>
              </span>
            </button>
          ))}
        </aside>
        <div className="playback-content">
          <CameraGrid
            cameras={selectedCameras}
            flexible
            isPlayback
            isFollowingLive={isFollowingLive}
            // Every camera waits while any of them buffers, so none runs ahead.
            isPlaying={isPlaying && !isClockHeld}
            playbackSpeed={playbackSpeed}
            playbackStart={playbackStart}
            masterTime={selectedTimestamp}
            recordingSpans={playbackData.spans}
            isSyncing={!isScrubbing}
            onBufferingChange={handleBufferingChange}
            timestamp={
              playbackData.windowEnd
                ? formatTimestamp(selectedTimestamp)
                : undefined
            }
          />
          <PlaybackTimeline
            cameras={selectedCameras}
            segments={playbackData.segments}
            windowStart={playbackData.windowStart}
            windowEnd={playbackData.windowEnd}
            position={position}
            isPlaying={isPlaying}
            playbackSpeed={playbackSpeed}
            isLive={isFollowingLive}
            onScrub={scrub}
            onPositionChange={seek}
            onSkip={skip}
            onTogglePlay={() => setIsPlaying((value) => !value)}
            onPlaybackSpeedChange={setPlaybackSpeed}
          />
          <RecordingDownloadForm
            key={activeDate ?? "no-recordings"}
            cameras={cameras}
            activeDate={activeDate}
          />
        </div>
      </div>
    </div>
  );
};

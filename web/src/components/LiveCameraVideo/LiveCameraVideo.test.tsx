// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Camera } from "@/types/camera";

import { LiveCameraVideo } from "./LiveCameraVideo";

const camera: Camera = {
  id: "garage",
  name: "Garage",
  status: "online",
  mainStream: "garage",
};

describe("LiveCameraVideo", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(
      () => undefined,
    );
  });
  afterEach(() => {
    // Vitest runs without globals, so Testing Library cannot clean up by itself.
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const videoIn = (container: HTMLElement) => {
    const video = container.querySelector("video");
    if (!video) throw new Error("no video element");
    return video;
  };

  it("plays the camera's live stream", () => {
    const { container } = render(<LiveCameraVideo camera={camera} muted />);
    expect(videoIn(container).getAttribute("src")).toBe(
      "/api/live/garage?session=0",
    );
  });

  it("reconnects as soon as the stream ends", () => {
    // The live service ends a stream at its age limit or when the recording
    // restarts; a camera that stopped answers 503, which retries after 2 s.
    const { container } = render(<LiveCameraVideo camera={camera} muted />);
    act(() => {
      videoIn(container).dispatchEvent(new Event("ended"));
    });
    expect(videoIn(container).getAttribute("src")).toBe(
      "/api/live/garage?session=1",
    );
  });

  it("retries when the picture stops moving for 10 s", () => {
    const { container, queryByText } = render(
      <LiveCameraVideo camera={camera} muted />,
    );
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(videoIn(container).getAttribute("src")).toBe(
      "/api/live/garage?session=0",
    );
    act(() => {
      vi.advanceTimersByTime(7_000);
    });
    expect(videoIn(container).getAttribute("src")).toBe(
      "/api/live/garage?session=1",
    );
    expect(queryByText("Live view unavailable, retrying")).not.toBeNull();
  });

  it("leaves a moving picture alone", () => {
    const { container } = render(<LiveCameraVideo camera={camera} muted />);
    let currentTime = 0;
    Object.defineProperty(videoIn(container), "currentTime", {
      configurable: true,
      get: () => currentTime,
    });
    for (let second = 0; second < 30; second++) {
      currentTime = second;
      act(() => {
        vi.advanceTimersByTime(1_000);
      });
    }
    expect(videoIn(container).getAttribute("src")).toBe(
      "/api/live/garage?session=0",
    );
  });

  it("says it is retrying after an error, until the video plays", () => {
    const { container, queryByText } = render(
      <LiveCameraVideo camera={camera} muted />,
    );
    act(() => {
      videoIn(container).dispatchEvent(new Event("error"));
    });
    expect(queryByText("Live view unavailable, retrying")).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    act(() => {
      videoIn(container).dispatchEvent(new Event("playing"));
    });
    expect(queryByText("Live view unavailable, retrying")).toBeNull();
  });
});

// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { formatTimestamp, timestampAtPosition } from "@/utils/time";

import { PlaybackTimeline } from "./PlaybackTimeline";

// Vitest runs without globals, so Testing Library cannot clean up by itself.
afterEach(cleanup);

const windowStart = new Date(2026, 9, 15).getTime();
const windowEnd = windowStart + 86_400_000;
const ignore = () => undefined;

const renderTimeline = (isLive: boolean) =>
  render(
    <PlaybackTimeline
      cameras={[]}
      segments={[]}
      windowStart={windowStart}
      windowEnd={windowEnd}
      position={50}
      isPlaying
      playbackSpeed={1}
      isLive={isLive}
      onScrub={ignore}
      onPositionChange={ignore}
      onSkip={ignore}
      onTogglePlay={ignore}
      onPlaybackSpeedChange={ignore}
    />,
  );

describe("PlaybackTimeline heading", () => {
  const noon = formatTimestamp(timestampAtPosition(windowStart, windowEnd, 50));

  it("shows the playhead's time during playback", () => {
    expect(renderTimeline(false).queryByText(noon)).not.toBeNull();
  });

  it("shows Live instead of a clock while following live", () => {
    const { container, queryByText } = renderTimeline(true);
    expect(queryByText(noon)).toBeNull();
    expect(container.querySelector(".timeline-heading > span")?.textContent).toBe(
      "Live",
    );
  });
});

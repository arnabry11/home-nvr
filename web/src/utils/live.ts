// Stay near the newest recording if the browser falls behind.
const maximumLatencySeconds = 4;
const catchUpMarginSeconds = 1;

/** Where a live video should jump to, or undefined to leave it playing. */
export const catchUpTime = (
  currentTime: number,
  bufferedEnd: number | undefined,
) =>
  bufferedEnd !== undefined && bufferedEnd - currentTime > maximumLatencySeconds
    ? bufferedEnd - catchUpMarginSeconds
    : undefined;

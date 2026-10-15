import { describe, expect, it } from "vitest";

import { catchUpTime } from "./live";

describe("catchUpTime", () => {
  it("leaves playback alone within 4 s of the buffered end", () => {
    expect(catchUpTime(10, 13.9)).toBeUndefined();
  });
  it("jumps to 1 s before the buffered end when further behind", () => {
    expect(catchUpTime(10, 14.5)).toBe(13.5);
  });
  it("waits until something is buffered", () => {
    expect(catchUpTime(0, undefined)).toBeUndefined();
  });
});

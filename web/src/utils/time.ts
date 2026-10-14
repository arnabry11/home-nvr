export const timeZoneName = Intl.DateTimeFormat().resolvedOptions().timeZone;

export const timestampAtPosition = (start: number, end: number, position: number) =>
  start + ((end - start) * position) / 100;

export const positionAtTimestamp = (start: number, end: number, timestamp: number) =>
  end > start ? ((timestamp - start) / (end - start)) * 100 : 0;

const pad = (value: number) => String(value).padStart(2, "0");

/** Local calendar day of a timestamp, as YYYY-MM-DD. */
export const dayKey = (timestamp: number) => {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

/** Local midnight at the start of a YYYY-MM-DD day, and of the next day. */
export const dayBounds = (day: string) => {
  const [year, month, date] = day.split("-").map(Number);
  return {
    start: new Date(year, month - 1, date).getTime(),
    end: new Date(year, month - 1, date + 1).getTime(),
  };
};

export const formatDate = (timestamp: number) =>
  new Intl.DateTimeFormat("en-IN", { dateStyle: "medium" }).format(timestamp);

export const formatTime = (timestamp: number) =>
  new Intl.DateTimeFormat("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(timestamp);

export const formatTimestamp = (timestamp: number) =>
  new Intl.DateTimeFormat("en-IN", {
    dateStyle: "medium",
    timeStyle: "medium",
    hour12: false,
  }).format(timestamp);

/** Value for an <input type="datetime-local"> showing a local timestamp. */
export const toDatetimeLocal = (timestamp: number) => {
  const date = new Date(timestamp);
  return `${dayKey(timestamp)}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
};

export const datetimeLocalToTimestamp = (value: string) => {
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) throw new Error("Enter both a date and time.");
  return timestamp;
};

/**
 * The first moment at or after `time` that any span covers: `time` itself when
 * it is inside a span, otherwise the start of the next span. Undefined when
 * nothing is recorded after `time`.
 */
export const recordedTimeFrom = (
  spans: readonly { start: number; end: number }[],
  time: number,
) => {
  let next: number | undefined;
  for (const span of spans) {
    if (span.start <= time && time < span.end) return time;
    if (span.start > time && (next === undefined || span.start < next))
      next = span.start;
  }
  return next;
};

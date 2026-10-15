# Recorded live view: design

Date: 2026-10-15. Status: agreed in conversation, waiting for plan review.

## Goal

Record each camera exactly as it sends it (H.264 video plus its own G.711
audio), with nothing running in the background just to convert audio. Serve
both playback and "live" from those recordings. In this NVR, live means "the
newest recording, a few seconds behind": the Tapo app already covers
real-time viewing.

## Why

- go2rtc used a separate always-on ffmpeg process per stream to add AAC
  audio. That audio reached MediaMTX late. MediaMTX discarded it ("sample of
  track 2 received too late") and the rest was recorded about 6.7 s ahead of
  the picture (Left Corner, measured by cross-correlating the AAC and raw
  recordings of the same microphone). Recordings with an empty audio track
  stalled Chrome for about 4 s on every load, which put tiles on "No video
  at this time".
- Live view opened a second connection to each camera for its sub stream.

## Evidence from tests on homeserver (2026-10-15)

- MediaMTX records go2rtc's `?video&audio=pcma` as H.264 plus LPCM
  (`ipcm`, 16-bit big-endian, 8 kHz, mono, 128 kbit/s, about 1.4 GB per
  camera per day). Over 5 minutes of Left Corner the audio covered 300.0 s
  of 300 s, starting and ending with the video, with no late-sample drops.
- Chrome 155 plays these recordings straight from MediaMTX `/get` in a
  plain `<video src>`, with no conversion: about 0.6 s to start, audio
  decoding at 16 kB/s, from any start point.
- Chrome's MSE rejects LPCM in MP4 (`addSourceBuffer` throws
  NotSupportedError; `ipcm`, `lpcm`, `alaw` and `sowt` are all unsupported).
- MediaMTX `/get` at the live edge returns what exists (about 4.5 s) and
  ends, so a single request can't follow the recording.
- Segment files: `ftyp`, `moov` (tracks, `mvex`, `udta/mtxi`), then one
  `moof`+`mdat` pair per 1 s part, appended as recorded. Timestamps restart
  at 0 in each file. Keyframes every 2 s, so about every other part starts
  with one. Track order can change when MediaMTX restarts a recording.
- `udta/mtxi` (MediaMTX's own box): a 16-byte stream ID (new for each
  recording session), the segment number within that session, the segment
  start as stream time (DTS, ns) and as wall-clock time (NTP, ns since the
  Unix epoch).
- `github.com/bluenviron/mediacommon/v2` v2.9.6 (`pkg/formats/fmp4`) reads
  these files once `mtxi` is registered with `github.com/abema/go-mp4`, and
  rewrites parts with new base times byte for byte.

## Decisions

1. **Recording:** every camera is recorded with `?video&audio=pcma`. go2rtc
   keeps one stream per camera (the main stream), with no ffmpeg sources and
   no `_sub` streams.
2. **Playback (investigations, downloads):** unchanged. The browser plays
   MediaMTX `/get` directly. No conversion, because only Chrome is used.
3. **Live:** a new Go service, `live`, follows each camera's newest segment
   file and sends Chrome one endless progressive fMP4 per viewer:
   - Starts at the newest part that begins with a video keyframe.
   - Sends that segment's `ftyp`+`moov` once, then every part as it is
     written, re-timed so the output starts at 0 and stays continuous.
   - Continues into the next segment when it has the same `mtxi` stream ID,
     the next segment number and the same tracks. Times come from `mtxi`
     DTS, so there is no wall-clock drift.
   - Ends the response when the recording restarts (new stream ID, skipped
     number or different tracks) or stops growing for 15 s. The browser
     then reconnects.
   - Reads the recordings directory read-only. It never talks to the
     cameras, go2rtc or MediaMTX.
4. **Browser live tile:** `<video src="/api/live/<camera>">`, reconnects 2 s
   after the stream ends or fails, and jumps forward when it falls more than
   4 s behind what it has buffered. The go2rtc MSE/WebSocket live player is
   removed.
5. **No clock in live view:** while the playback page follows live, the
   tiles and the timeline heading show "Live" instead of a time. The page's
   clock would show the current time, but the picture is a few seconds
   behind.
6. **Stack:** Go 1.26, mediacommon v2.9.6, standard library HTTP server,
   distroless static image running as non-root.

## Non-goals

- Real-time (sub-second) live view.
- Browsers other than Chrome. Safari and iOS Chrome (WebKit) may not play
  LPCM.
- Converting audio anywhere.
- Changing MediaMTX's segment length (15 min) or part length (1 s).

## Known consequences

- Recordings made before the switch keep their AAC audio and its offset.
  They still play.
- Downloaded MP4s carry LPCM audio. Chrome, VLC and ffmpeg play it; other
  desktop players may not.

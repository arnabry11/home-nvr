# Recorded Live View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record every camera as it arrives (H.264 plus its own G.711 audio) and serve live view from the growing recordings through a new Go service, with no audio conversion anywhere.

**Architecture:** go2rtc keeps one RTSP session per camera; MediaMTX pulls `?video&audio=pcma` and records fMP4 segments (G.711 stored as LPCM). A new `live` service reads the recordings directory read-only. It follows each camera's newest segment and streams one endless, re-timed fMP4 per viewer, which Chrome plays in a plain `<video src>`. Playback keeps using MediaMTX `/get` directly.

**Tech Stack:** Go 1.26.0, `github.com/bluenviron/mediacommon/v2` v2.9.6 (`pkg/formats/fmp4`), `github.com/abema/go-mp4` (pulled in by mediacommon), Go standard library HTTP, distroless static image; React 19 + TypeScript + Vite + Vitest (existing `web/`).

**Spec:** `docs/superpowers/specs/2026-10-15-recorded-live-design.md`

## Global Constraints

- Only Chrome is supported. Never convert or transcode audio, in any service.
- Go `1.26.0` (`live/go.mod` and `live/mise.toml`); build image `golang:1.26.0-alpine`; runtime image `gcr.io/distroless/static-debian12:nonroot`.
- mediacommon `v2.9.6`. No other direct Go dependencies except `github.com/abema/go-mp4` (needed to register the `mtxi` box).
- The live service only reads `/recordings` (mounted `:ro`). It never connects to the cameras, go2rtc or MediaMTX.
- Leave MediaMTX `recordSegmentDuration: 15m` and `recordPartDuration: 1s` unchanged.
- Live service tuning: poll every `200ms`; a recording that hasn't grown for `15s` counts as stopped.
- Browser live tile: reconnect `2_000` ms after the stream ends or errors; jump forward when more than `4` s behind the buffered end, landing `1` s before it.
- Error text shown on a live tile: `Live view unavailable, retrying`.
- No clock in live view: while following live, tiles show no time (just the `LIVE` badge) and the timeline heading reads `Live`.
- No new npm dependencies.
- Match the surrounding code: short comments that explain why, existing naming and formatting (Prettier-style double quotes in `web/src`, `gofmt` for Go).
- Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Deploying (Task 6) restarts recording on homeserver: get the user's go-ahead before pushing or deploying.

## Review Focus

- **Segment rollover every 15 minutes:** a viewer's stream should carry on without a reconnect or a timestamp jump when MediaMTX starts the next segment. Task 2 `TestLiveContinuesIntoTheNextSegment`; checked on the real recordings in Task 6, Step 6.
- **Reading while MediaMTX writes:** a half-written init or part should mean "wait", never an error or a truncated part. Task 1 `TestOpenSegmentWaitsForItsInit` and `TestNextPartWaitsForAHalfWrittenPart`; Task 2 `TestOpenLiveWaitsForAKeyframe`.
- **Camera reconnects (watchdog detach, Wi-Fi drop):** MediaMTX starts a new recording session, so the stream should end and the browser should reconnect within about 2 s. Task 2 `TestLiveEndsWhenTheRecordingRestarts`; Task 4 `reconnects 2 s after the stream ends`.
- **Camera offline:** a recording that stopped growing should answer 503 and the tile should say it is retrying, not spin forever. Task 2 `TestOpenLiveOnAStoppedRecording` and `TestLiveEndsWhenTheRecordingStalls`; Task 3 `TestServeLiveReportsAStoppedRecording`; Task 4 error-message test.
- **Hostile or mistyped camera names in the URL** (`..%2Fetc`, uppercase, dots): 404, never a file outside `/recordings/<camera>`. Task 3 `TestServeLiveRejectsUnknownCameras`.

---

## File Structure

New Go module `live/` (module path `github.com/arnabry11/home-nvr/live`, package `main`):

| File | Responsibility |
|------|----------------|
| `live/mtxi.go` | Registers MediaMTX's `mtxi` box with go-mp4 so `fmp4.Init.Unmarshal` can read MediaMTX segments. |
| `live/segment.go` | `segmentFile`: reads one segment that may still be growing (init, parts, newest keyframe, continuity check) and the time conversions. |
| `live/stream.go` | `liveStream`: picks the start, re-times parts, follows the file and the next segments, and decides when to end. Also lists segment files. |
| `live/handler.go` | HTTP routing (`GET /live/{camera}`), name validation, status codes, flushing. |
| `live/main.go` | Configuration from the environment and starting the server. |
| `live/testsegment_test.go` | Test helpers: build MediaMTX-shaped segments, collect the stream's output. |
| `live/segment_test.go`, `live/stream_test.go`, `live/handler_test.go` | Tests. |
| `live/Dockerfile`, `live/mise.toml`, `live/go.mod`, `live/go.sum` | Build and toolchain. |

Modified:

| File | Change |
|------|--------|
| `docker-compose.yml`, `docker-compose.dev.yml` | Add the `live` service (dev: publish `8082`). |
| `web/nginx/default.conf` | Proxy `/api/live/`; drop the go2rtc WebSocket upgrade. |
| `web/vite.config.ts` | Dev proxy for `/api/live`; drop `ws` for go2rtc. |
| `web/src/components/LiveCameraVideo/LiveCameraVideo.tsx` | Rewritten: plain `<video src>` on the live service with reconnect and catch-up. |
| `web/src/components/LiveCameraVideo/LiveCameraVideo.test.tsx` | New tests. |
| `web/src/utils/live.ts`, `web/src/utils/live.test.ts` | New: `catchUpTime`, the live tile's catch-up rule, and its tests. |
| `web/src/pages/playback/PlaybackView.tsx`, `web/src/components/PlaybackTimeline/PlaybackTimeline.tsx` (+ new test) | No clock while following live. |
| `web/src/components/CameraTile/CameraTile.tsx` | Always use the main stream for live. |
| `web/src/api/rest/nvr-client.ts`, `web/src/types/camera.ts` | Add `liveUrl`; remove sub streams and the go2rtc WebSocket URL. |
| `go2rtc/go2rtc.yaml`, `mediamtx/mediamtx.yml` | One stream per camera, no ffmpeg; record `?video&audio=pcma`. |
| `README.md` | Describe the new pipeline. |

---

### Task 1: Segment reader

**Files:**
- Create: `live/mise.toml`, `live/go.mod`, `live/go.sum` (generated), `live/mtxi.go`, `live/segment.go`
- Test: `live/testsegment_test.go`, `live/segment_test.go`

**Interfaces:**
- Consumes: nothing.
- Produces (used by Tasks 2 and 3):
  - `type mtxi struct { amp4.FullBox; StreamID [16]byte; SegmentNumber uint64; DTS int64; NTP int64 }`
  - `var errIncomplete error`
  - `type segmentFile struct { name string; file *os.File; initRaw []byte; init fmp4.Init; info *mtxi; offset int64 }`
  - `func openSegment(path string) (*segmentFile, error)`, `func (s *segmentFile) Close() error`
  - `func (s *segmentFile) partAt(offset int64) (*fmp4.Part, int64, error)`
  - `func (s *segmentFile) nextPart() (*fmp4.Part, error)`
  - `func (s *segmentFile) seekToNewestKeyframe() error`
  - `func (s *segmentFile) videoTrackID() int`, `func (s *segmentFile) timeScale(trackID int) uint32`
  - `func (s *segmentFile) startNanos(part *fmp4.Part) int64`
  - `func (s *segmentFile) continues(next *segmentFile) bool`
  - `func toTicks(nanos int64, timeScale uint32) int64`, `func toNanos(ticks int64, timeScale uint32) int64`
  - Test helpers: `testSegment`, `streamA`, `streamB`, `(testSegment).initBytes/partBytes/write/name`, `appendBytes`, `collector`, `(*collector).waitForParts`, `baseTime`

- [ ] **Step 1: Create the module**

`live/mise.toml`:

```toml
[tools]
go = "1.26.0"
```

Then:

```bash
cd live
mise install
go mod init github.com/arnabry11/home-nvr/live
go mod edit -go=1.26.0
go get github.com/bluenviron/mediacommon/v2@v2.9.6
```

Expected: `go.mod` lists `github.com/bluenviron/mediacommon/v2 v2.9.6`.

- [ ] **Step 2: Write the test helpers**

`live/testsegment_test.go`:

```go
package main

import (
	"os"
	"path/filepath"
	"slices"
	"sync"
	"testing"
	"time"

	amp4 "github.com/abema/go-mp4"
	"github.com/bluenviron/mediacommon/v2/pkg/formats/fmp4"
	"github.com/bluenviron/mediacommon/v2/pkg/formats/fmp4/seekablebuffer"
)

// The SPS and PPS of the Garage camera's main stream.
var (
	testSPS  = []byte{0x67, 0x4d, 0x00, 0x32, 0x8a, 0x8a, 0x50, 0x14, 0x00, 0x5a, 0xd3, 0x64, 0x00, 0x00, 0x0f, 0xa0, 0x00, 0x03, 0x0d, 0x40, 0x10}
	testPPS  = []byte{0x68, 0xee, 0x3c, 0x80}
	streamA  = [16]byte{0xa}
	streamB  = [16]byte{0xb}
	testWall = time.Date(2026, 10, 15, 2, 50, 3, 966058000, time.UTC)
)

// testSegment describes a segment shaped like MediaMTX's recordings: 1 s
// parts of 25 fps H.264 and, optionally, 8 kHz LPCM audio.
type testSegment struct {
	stream    [16]byte
	number    uint64
	start     time.Duration // stream time (DTS) at the segment's start
	keyframes []bool        // whether each part's video starts with a keyframe
	audio     bool
	// audioLead starts each part's audio this much before its video
	// (except in part 0, which starts at zero).
	audioLead time.Duration
}

func (s testSegment) tracks() []*fmp4.InitTrack {
	tracks := []*fmp4.InitTrack{{
		ID: 1, TimeScale: 90000,
		Codec: &fmp4.CodecH264{SPS: testSPS, PPS: testPPS},
	}}
	if s.audio {
		tracks = append(tracks, &fmp4.InitTrack{
			ID: 2, TimeScale: 8000,
			Codec: &fmp4.CodecLPCM{BitDepth: 16, SampleRate: 8000, ChannelCount: 1},
		})
	}
	return tracks
}

// name follows MediaMTX's recordPath: the segment's start time.
func (s testSegment) name() string {
	return testWall.Add(s.start).Format("2006-01-02_15-04-05-000000") + ".mp4"
}

func (s testSegment) initBytes(t *testing.T) []byte {
	t.Helper()
	init := fmp4.Init{
		Tracks: s.tracks(),
		UserData: []amp4.IBox{&mtxi{
			StreamID:      s.stream,
			SegmentNumber: s.number,
			DTS:           int64(s.start),
			NTP:           testWall.Add(s.start).UnixNano(),
		}},
	}
	var buf seekablebuffer.Buffer
	if err := init.Marshal(&buf); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func (s testSegment) partBytes(t *testing.T, i int) []byte {
	t.Helper()
	video := &fmp4.PartTrack{ID: 1, BaseTime: uint64(i) * 90000}
	for n := range 25 {
		video.Samples = append(video.Samples, &fmp4.Sample{
			Duration:        3600,
			IsNonSyncSample: n > 0 || !s.keyframes[i],
			Payload:         []byte{0, 0, 0, 1, byte(n)},
		})
	}
	part := fmp4.Part{SequenceNumber: uint32(i), Tracks: []*fmp4.PartTrack{video}}
	if s.audio {
		base := uint64(i) * 8000
		if i > 0 {
			base -= uint64(toTicks(int64(s.audioLead), 8000))
		}
		audio := &fmp4.PartTrack{ID: 2, BaseTime: base}
		for range 8 {
			audio.Samples = append(audio.Samples, &fmp4.Sample{Duration: 1000, Payload: make([]byte, 2000)})
		}
		part.Tracks = append(part.Tracks, audio)
	}
	var buf seekablebuffer.Buffer
	if err := part.Marshal(&buf); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// write writes the init and the first n parts to the segment's file in dir
// and returns its path.
func (s testSegment) write(t *testing.T, dir string, n int) string {
	t.Helper()
	data := s.initBytes(t)
	for i := range n {
		data = append(data, s.partBytes(t, i)...)
	}
	path := filepath.Join(dir, s.name())
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

// appendBytes adds data to a segment the way MediaMTX grows it.
func appendBytes(t *testing.T, path string, data []byte) {
	t.Helper()
	file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if _, err := file.Write(data); err != nil {
		t.Fatal(err)
	}
}

// collector keeps every Write; the stream writes one part per Write.
type collector struct {
	mu     sync.Mutex
	writes [][]byte
}

func (c *collector) Write(p []byte) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.writes = append(c.writes, slices.Clone(p))
	return len(p), nil
}

// waitForParts waits until at least n parts were written and returns them all.
func (c *collector) waitForParts(t *testing.T, n int) []*fmp4.Part {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for {
		c.mu.Lock()
		writes := slices.Clone(c.writes)
		c.mu.Unlock()
		if len(writes) >= n {
			var parts []*fmp4.Part
			for _, write := range writes {
				var decoded fmp4.Parts
				if err := decoded.Unmarshal(write); err != nil {
					t.Fatal(err)
				}
				parts = append(parts, decoded...)
			}
			return parts
		}
		if time.Now().After(deadline) {
			t.Fatalf("got %d parts, want %d", len(writes), n)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func baseTime(t *testing.T, part *fmp4.Part, trackID int) uint64 {
	t.Helper()
	for _, track := range part.Tracks {
		if track.ID == trackID {
			return track.BaseTime
		}
	}
	t.Fatalf("part %d has no track %d", part.SequenceNumber, trackID)
	return 0
}
```

- [ ] **Step 3: Write the failing segment tests**

`live/segment_test.go`:

```go
package main

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestOpenSegmentReadsItsInitAndSession(t *testing.T) {
	segment := testSegment{stream: streamA, number: 7, start: 42 * time.Second, keyframes: []bool{true}, audio: true}
	s, err := openSegment(segment.write(t, t.TempDir(), 1))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if !bytes.Equal(s.initRaw, segment.initBytes(t)) {
		t.Error("initRaw is not the recorded ftyp+moov")
	}
	if s.info.StreamID != streamA || s.info.SegmentNumber != 7 || s.info.DTS != int64(42*time.Second) {
		t.Errorf("info = %+v", s.info)
	}
	if s.videoTrackID() != 1 || s.timeScale(1) != 90000 || s.timeScale(2) != 8000 {
		t.Errorf("tracks = video %d, time scales %d/%d", s.videoTrackID(), s.timeScale(1), s.timeScale(2))
	}
}

func TestOpenSegmentWaitsForItsInit(t *testing.T) {
	segment := testSegment{stream: streamA, keyframes: []bool{true}}
	path := filepath.Join(t.TempDir(), segment.name())
	init := segment.initBytes(t)
	if err := os.WriteFile(path, init[:len(init)/2], 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := openSegment(path); !errors.Is(err, errIncomplete) {
		t.Fatalf("err = %v, want errIncomplete", err)
	}
}

func TestSeekToNewestKeyframe(t *testing.T) {
	segment := testSegment{stream: streamA, keyframes: []bool{true, false, true, false}}
	s, err := openSegment(segment.write(t, t.TempDir(), 4))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if err := s.seekToNewestKeyframe(); err != nil {
		t.Fatal(err)
	}
	part, err := s.nextPart()
	if err != nil {
		t.Fatal(err)
	}
	if got := baseTime(t, part, 1); got != 2*90000 {
		t.Errorf("started at video time %d, want %d", got, 2*90000)
	}
}

func TestSeekToNewestKeyframeWithoutOne(t *testing.T) {
	segment := testSegment{stream: streamA, keyframes: []bool{false, false}}
	s, err := openSegment(segment.write(t, t.TempDir(), 2))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if err := s.seekToNewestKeyframe(); !errors.Is(err, errIncomplete) {
		t.Fatalf("err = %v, want errIncomplete", err)
	}
}

func TestNextPartWaitsForAHalfWrittenPart(t *testing.T) {
	segment := testSegment{stream: streamA, keyframes: []bool{true, false}, audio: true}
	path := segment.write(t, t.TempDir(), 1)
	second := segment.partBytes(t, 1)
	appendBytes(t, path, second[:len(second)/2])
	s, err := openSegment(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if _, err := s.nextPart(); err != nil {
		t.Fatal(err)
	}
	if _, err := s.nextPart(); !errors.Is(err, errIncomplete) {
		t.Fatalf("err = %v, want errIncomplete", err)
	}
	appendBytes(t, path, second[len(second)/2:])
	part, err := s.nextPart()
	if err != nil {
		t.Fatal(err)
	}
	if got := baseTime(t, part, 1); got != 90000 {
		t.Errorf("video time %d, want 90000", got)
	}
}

func TestContinues(t *testing.T) {
	dir := t.TempDir()
	open := func(segment testSegment) *segmentFile {
		s, err := openSegment(segment.write(t, dir, 1))
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { s.Close() })
		return s
	}
	first := open(testSegment{stream: streamA, number: 5, start: 0, keyframes: []bool{true}, audio: true})
	for _, test := range []struct {
		name string
		next testSegment
		want bool
	}{
		{"next segment", testSegment{stream: streamA, number: 6, start: time.Minute, keyframes: []bool{true}, audio: true}, true},
		{"new session", testSegment{stream: streamB, number: 6, start: 2 * time.Minute, keyframes: []bool{true}, audio: true}, false},
		{"skipped segment", testSegment{stream: streamA, number: 7, start: 3 * time.Minute, keyframes: []bool{true}, audio: true}, false},
		{"different tracks", testSegment{stream: streamA, number: 6, start: 4 * time.Minute, keyframes: []bool{true}}, false},
	} {
		if got := first.continues(open(test.next)); got != test.want {
			t.Errorf("%s: continues = %v, want %v", test.name, got, test.want)
		}
	}
}

func TestTimeConversionsDoNotOverflow(t *testing.T) {
	sixDays := int64(6 * 24 * time.Hour)
	if got := toTicks(sixDays, 90000); got != 6*86400*90000 {
		t.Errorf("toTicks = %d", got)
	}
	if got := toNanos(6*86400*90000, 90000); got != sixDays {
		t.Errorf("toNanos = %d", got)
	}
	if got := toTicks(-int64(time.Second)/2, 8000); got != -4000 {
		t.Errorf("toTicks(-0.5 s) = %d", got)
	}
}
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `cd live && go test ./...`
Expected: build failure, `undefined: mtxi`, `undefined: openSegment`, `undefined: toTicks`.

- [ ] **Step 5: Implement `mtxi.go`**

```go
package main

import amp4 "github.com/abema/go-mp4"

// mtxi is the box MediaMTX writes into each segment's moov/udta: the
// recording session (a new ID whenever MediaMTX restarts the recording), the
// segment's number in that session and its start as stream time (DTS) and as
// wall-clock time (NTP), both in nanoseconds.
type mtxi struct {
	amp4.FullBox  `mp4:"0,extend"`
	StreamID      [16]byte `mp4:"1,size=8,len=16"`
	SegmentNumber uint64   `mp4:"2,size=64"`
	DTS           int64    `mp4:"3,size=64"`
	NTP           int64    `mp4:"4,size=64"`
}

func (*mtxi) GetType() amp4.BoxType { return amp4.StrToBoxType("mtxi") }

// Without this, fmp4.Init.Unmarshal rejects MediaMTX segments with
// "box info not found".
func init() { amp4.AddBoxDef(&mtxi{}, 0) }
```

- [ ] **Step 6: Implement `segment.go`**

```go
package main

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"reflect"
	"time"

	"github.com/bluenviron/mediacommon/v2/pkg/formats/fmp4"
)

// errIncomplete means MediaMTX has not finished writing the next box yet.
var errIncomplete = errors.New("not fully written yet")

// segmentFile reads one MediaMTX segment: ftyp and moov, then a moof+mdat
// pair per part. MediaMTX appends parts while it records, so the file may
// still be growing.
type segmentFile struct {
	name    string
	file    *os.File
	initRaw []byte
	init    fmp4.Init
	info    *mtxi
	// offset is where the next unread part starts.
	offset int64
}

func openSegment(path string) (*segmentFile, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	segment := &segmentFile{name: filepath.Base(path), file: file}
	if err := segment.readInit(); err != nil {
		file.Close()
		return nil, err
	}
	return segment, nil
}

func (s *segmentFile) Close() error { return s.file.Close() }

func (s *segmentFile) size() (int64, error) {
	info, err := s.file.Stat()
	if err != nil {
		return 0, err
	}
	return info.Size(), nil
}

// boxSize returns the size of the box of the given type at offset, or
// errIncomplete when that box does not fit in the file yet.
func (s *segmentFile) boxSize(offset, fileSize int64, want string) (int64, error) {
	if fileSize-offset < 8 {
		return 0, errIncomplete
	}
	var header [16]byte
	if _, err := s.file.ReadAt(header[:8], offset); err != nil {
		return 0, err
	}
	size := int64(binary.BigEndian.Uint32(header[:4]))
	if size == 1 { // a 64-bit size follows the type
		if fileSize-offset < 16 {
			return 0, errIncomplete
		}
		if _, err := s.file.ReadAt(header[8:16], offset+8); err != nil {
			return 0, err
		}
		size = int64(binary.BigEndian.Uint64(header[8:16]))
	}
	if typ := string(header[4:8]); typ != want || size < 8 {
		return 0, fmt.Errorf("%s: expected a %s box at %d, found %q of size %d", s.name, want, offset, typ, size)
	}
	if offset+size > fileSize {
		return 0, errIncomplete
	}
	return size, nil
}

func (s *segmentFile) readInit() error {
	fileSize, err := s.size()
	if err != nil {
		return err
	}
	ftypSize, err := s.boxSize(0, fileSize, "ftyp")
	if err != nil {
		return err
	}
	moovSize, err := s.boxSize(ftypSize, fileSize, "moov")
	if err != nil {
		return err
	}
	s.initRaw = make([]byte, ftypSize+moovSize)
	if _, err := s.file.ReadAt(s.initRaw, 0); err != nil {
		return err
	}
	if err := s.init.Unmarshal(bytes.NewReader(s.initRaw)); err != nil {
		return fmt.Errorf("%s: %w", s.name, err)
	}
	for _, box := range s.init.UserData {
		if info, ok := box.(*mtxi); ok {
			s.info = info
		}
	}
	if s.info == nil {
		return fmt.Errorf("%s: no mtxi box", s.name)
	}
	s.offset = int64(len(s.initRaw))
	return nil
}

// partAt reads the part at offset and returns it with the offset of the
// part after it.
func (s *segmentFile) partAt(offset int64) (*fmp4.Part, int64, error) {
	fileSize, err := s.size()
	if err != nil {
		return nil, 0, err
	}
	moofSize, err := s.boxSize(offset, fileSize, "moof")
	if err != nil {
		return nil, 0, err
	}
	mdatSize, err := s.boxSize(offset+moofSize, fileSize, "mdat")
	if err != nil {
		return nil, 0, err
	}
	raw := make([]byte, moofSize+mdatSize)
	if _, err := s.file.ReadAt(raw, offset); err != nil {
		return nil, 0, err
	}
	var parts fmp4.Parts
	if err := parts.Unmarshal(raw); err != nil {
		return nil, 0, fmt.Errorf("%s: part at %d: %w", s.name, offset, err)
	}
	if len(parts) != 1 {
		return nil, 0, fmt.Errorf("%s: expected 1 part at %d, found %d", s.name, offset, len(parts))
	}
	return parts[0], offset + int64(len(raw)), nil
}

// nextPart returns the next unread part, or errIncomplete until MediaMTX
// has written all of it.
func (s *segmentFile) nextPart() (*fmp4.Part, error) {
	part, next, err := s.partAt(s.offset)
	if err != nil {
		return nil, err
	}
	s.offset = next
	return part, nil
}

// seekToNewestKeyframe moves to the newest written part whose video starts
// with a keyframe, where a viewer can start decoding. It returns
// errIncomplete while there is none.
func (s *segmentFile) seekToNewestKeyframe() error {
	fileSize, err := s.size()
	if err != nil {
		return err
	}
	var offsets []int64
	for offset := s.offset; ; {
		moofSize, err := s.boxSize(offset, fileSize, "moof")
		if errors.Is(err, errIncomplete) {
			break
		}
		if err != nil {
			return err
		}
		mdatSize, err := s.boxSize(offset+moofSize, fileSize, "mdat")
		if errors.Is(err, errIncomplete) {
			break
		}
		if err != nil {
			return err
		}
		offsets = append(offsets, offset)
		offset += moofSize + mdatSize
	}
	video := s.videoTrackID()
	for i := len(offsets) - 1; i >= 0; i-- {
		part, _, err := s.partAt(offsets[i])
		if err != nil {
			return err
		}
		if startsWithKeyframe(part, video) {
			s.offset = offsets[i]
			return nil
		}
	}
	return errIncomplete
}

func startsWithKeyframe(part *fmp4.Part, videoID int) bool {
	for _, track := range part.Tracks {
		if track.ID == videoID {
			return len(track.Samples) > 0 && !track.Samples[0].IsNonSyncSample
		}
	}
	return false
}

// videoTrackID is the ID of the video track. MediaMTX can order tracks
// either way round when it restarts a recording.
func (s *segmentFile) videoTrackID() int {
	for _, track := range s.init.Tracks {
		if track.Codec.IsVideo() {
			return track.ID
		}
	}
	return 0
}

func (s *segmentFile) timeScale(trackID int) uint32 {
	for _, track := range s.init.Tracks {
		if track.ID == trackID {
			return track.TimeScale
		}
	}
	return 0
}

// startNanos is the stream time (DTS) at which the part's earliest track
// begins.
func (s *segmentFile) startNanos(part *fmp4.Part) int64 {
	start := int64(math.MaxInt64)
	for _, track := range part.Tracks {
		start = min(start, toNanos(int64(track.BaseTime), s.timeScale(track.ID)))
	}
	return s.info.DTS + start
}

// continues reports whether next picks up exactly where s ends: the same
// MediaMTX recording session, the following segment and the same tracks.
func (s *segmentFile) continues(next *segmentFile) bool {
	return next.info.StreamID == s.info.StreamID &&
		next.info.SegmentNumber == s.info.SegmentNumber+1 &&
		sameTracks(s.init.Tracks, next.init.Tracks)
}

func sameTracks(a, b []*fmp4.InitTrack) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i].ID != b[i].ID || a[i].TimeScale != b[i].TimeScale ||
			!reflect.DeepEqual(a[i].Codec, b[i].Codec) {
			return false
		}
	}
	return true
}

// The time conversions split off whole seconds first, so days of
// nanoseconds times a 90 kHz time scale cannot overflow int64.
func toTicks(nanos int64, timeScale uint32) int64 {
	scale := int64(timeScale)
	second := int64(time.Second)
	return nanos/second*scale + nanos%second*scale/second
}

func toNanos(ticks int64, timeScale uint32) int64 {
	scale := int64(timeScale)
	second := int64(time.Second)
	return ticks/scale*second + ticks%scale*second/scale
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd live && go mod tidy && go vet ./... && go test ./...`
Expected: `ok  github.com/arnabry11/home-nvr/live`.

- [ ] **Step 8: Commit**

```bash
git add live/mise.toml live/go.mod live/go.sum live/mtxi.go live/segment.go live/testsegment_test.go live/segment_test.go
git commit -m "Read MediaMTX segments while they are being written

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Live stream

**Files:**
- Create: `live/stream.go`
- Test: `live/stream_test.go`

**Interfaces:**
- Consumes (Task 1): `segmentFile`, `openSegment`, `(*segmentFile).nextPart/partAt/seekToNewestKeyframe/startNanos/timeScale/continues/Close`, `errIncomplete`, `toTicks`, test helpers.
- Produces (used by Task 3):
  - `var errNoRecording, errStalled, errDiscontinuity error`
  - `func openLive(ctx context.Context, dir string, poll, idle time.Duration) (*liveStream, error)`
  - `func (l *liveStream) initSegment() []byte`
  - `func (l *liveStream) copyTo(ctx context.Context, w io.Writer, flush func()) error`
  - `func (l *liveStream) Close() error`

- [ ] **Step 1: Write the failing tests**

`live/stream_test.go`:

```go
package main

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func openTestLive(t *testing.T, dir string, idle time.Duration) *liveStream {
	t.Helper()
	live, err := openLive(context.Background(), dir, 10*time.Millisecond, idle)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { live.Close() })
	return live
}

// runLive streams into a collector until the test ends. The channel receives
// copyTo's result.
func runLive(t *testing.T, live *liveStream) (*collector, <-chan error) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	out := &collector{}
	done := make(chan error, 1)
	go func() { done <- live.copyTo(ctx, out, func() {}) }()
	return out, done
}

func waitDone(t *testing.T, done <-chan error) error {
	t.Helper()
	select {
	case err := <-done:
		return err
	case <-time.After(2 * time.Second):
		t.Fatal("the stream did not end")
		return nil
	}
}

func TestLiveStartsAtTheNewestKeyframeFromZero(t *testing.T) {
	dir := t.TempDir()
	segment := testSegment{stream: streamA, number: 1, start: 100 * time.Second, keyframes: []bool{true, false, true, false}, audio: true}
	segment.write(t, dir, 4)
	live := openTestLive(t, dir, time.Second)
	if !bytes.Equal(live.initSegment(), segment.initBytes(t)) {
		t.Error("the stream does not start with the recorded ftyp+moov")
	}
	out, _ := runLive(t, live)
	parts := out.waitForParts(t, 2)
	for i, want := range []struct {
		sequence     uint32
		video, audio uint64
	}{{1, 0, 0}, {2, 90000, 8000}} {
		part := parts[i]
		if part.SequenceNumber != want.sequence || baseTime(t, part, 1) != want.video || baseTime(t, part, 2) != want.audio {
			t.Errorf("part %d: sequence %d, video %d, audio %d; want %+v",
				i, part.SequenceNumber, baseTime(t, part, 1), baseTime(t, part, 2), want)
		}
	}
}

func TestLiveStartsWhereAudioLeadsVideo(t *testing.T) {
	dir := t.TempDir()
	testSegment{stream: streamA, keyframes: []bool{true, false, true}, audio: true, audioLead: 50 * time.Millisecond}.write(t, dir, 3)
	out, _ := runLive(t, openTestLive(t, dir, time.Second))
	part := out.waitForParts(t, 1)[0]
	// Audio starts 50 ms before the keyframe, so it becomes zero.
	if audio, video := baseTime(t, part, 2), baseTime(t, part, 1); audio != 0 || video != 4500 {
		t.Errorf("audio %d, video %d; want 0 and 4500", audio, video)
	}
}

func TestLiveFollowsAGrowingSegment(t *testing.T) {
	dir := t.TempDir()
	segment := testSegment{stream: streamA, keyframes: []bool{true, false}, audio: true}
	path := segment.write(t, dir, 1)
	out, _ := runLive(t, openTestLive(t, dir, time.Second))
	out.waitForParts(t, 1)
	appendBytes(t, path, segment.partBytes(t, 1))
	if got := baseTime(t, out.waitForParts(t, 2)[1], 1); got != 90000 {
		t.Errorf("video time %d, want 90000", got)
	}
}

func TestLiveContinuesIntoTheNextSegment(t *testing.T) {
	dir := t.TempDir()
	testSegment{stream: streamA, number: 5, start: 100 * time.Second, keyframes: []bool{true, false, true}, audio: true}.write(t, dir, 3)
	out, done := runLive(t, openTestLive(t, dir, time.Second))
	out.waitForParts(t, 1) // starts at 102 s
	testSegment{stream: streamA, number: 6, start: 103 * time.Second, keyframes: []bool{true, false}, audio: true}.write(t, dir, 2)
	parts := out.waitForParts(t, 3)
	for i, want := range []uint64{0, 90000, 180000} {
		if got := baseTime(t, parts[i], 1); got != want {
			t.Errorf("part %d video time %d, want %d", i, got, want)
		}
	}
	select {
	case err := <-done:
		t.Fatalf("the stream ended: %v", err)
	default:
	}
}

func TestLiveEndsWhenTheRecordingRestarts(t *testing.T) {
	dir := t.TempDir()
	testSegment{stream: streamA, number: 5, start: 100 * time.Second, keyframes: []bool{true}, audio: true}.write(t, dir, 1)
	out, done := runLive(t, openTestLive(t, dir, time.Second))
	out.waitForParts(t, 1)
	// A new recording session, named after the old one as MediaMTX's
	// wall-clock names are.
	testSegment{stream: streamB, number: 1, start: 200 * time.Second, keyframes: []bool{true}, audio: true}.write(t, dir, 1)
	if err := waitDone(t, done); !errors.Is(err, errDiscontinuity) {
		t.Fatalf("err = %v, want errDiscontinuity", err)
	}
}

func TestLiveEndsWhenTheRecordingStalls(t *testing.T) {
	dir := t.TempDir()
	testSegment{stream: streamA, keyframes: []bool{true}}.write(t, dir, 1)
	_, done := runLive(t, openTestLive(t, dir, 200*time.Millisecond))
	if err := waitDone(t, done); !errors.Is(err, errStalled) {
		t.Fatalf("err = %v, want errStalled", err)
	}
}

func TestOpenLiveWithoutRecordings(t *testing.T) {
	for _, dir := range []string{t.TempDir(), filepath.Join(t.TempDir(), "missing")} {
		if _, err := openLive(context.Background(), dir, 10*time.Millisecond, time.Second); !errors.Is(err, errNoRecording) {
			t.Errorf("%s: err = %v, want errNoRecording", dir, err)
		}
	}
}

func TestOpenLiveOnAStoppedRecording(t *testing.T) {
	dir := t.TempDir()
	path := testSegment{stream: streamA, keyframes: []bool{true}}.write(t, dir, 1)
	old := time.Now().Add(-time.Minute)
	if err := os.Chtimes(path, old, old); err != nil {
		t.Fatal(err)
	}
	if _, err := openLive(context.Background(), dir, 10*time.Millisecond, time.Second); !errors.Is(err, errStalled) {
		t.Fatalf("err = %v, want errStalled", err)
	}
}

func TestOpenLiveWaitsForAKeyframe(t *testing.T) {
	dir := t.TempDir()
	segment := testSegment{stream: streamA, keyframes: []bool{false, true}}
	path := segment.write(t, dir, 1)
	type opened struct {
		live *liveStream
		err  error
	}
	result := make(chan opened, 1)
	go func() {
		live, err := openLive(context.Background(), dir, 10*time.Millisecond, time.Second)
		result <- opened{live, err}
	}()
	time.Sleep(50 * time.Millisecond)
	appendBytes(t, path, segment.partBytes(t, 1))
	var live *liveStream
	select {
	case r := <-result:
		if r.err != nil {
			t.Fatal(r.err)
		}
		live = r.live
		t.Cleanup(func() { live.Close() })
	case <-time.After(2 * time.Second):
		t.Fatal("openLive did not return")
	}
	out, _ := runLive(t, live)
	if got := baseTime(t, out.waitForParts(t, 1)[0], 1); got != 0 {
		t.Errorf("video time %d, want 0", got)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd live && go test ./...`
Expected: build failure, `undefined: openLive`, `undefined: errDiscontinuity`.

- [ ] **Step 3: Implement `stream.go`**

```go
package main

import (
	"context"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/bluenviron/mediacommon/v2/pkg/formats/fmp4"
	"github.com/bluenviron/mediacommon/v2/pkg/formats/fmp4/seekablebuffer"
)

var (
	errNoRecording   = errors.New("no recording for this camera")
	errStalled       = errors.New("the recording stopped growing")
	errDiscontinuity = errors.New("the recording restarted")
)

// liveStream follows a camera's newest recording and re-times its parts so
// they form one continuous fMP4 stream that starts at zero.
type liveStream struct {
	dir     string
	segment *segmentFile
	// originNanos is the stream time (DTS) that becomes zero in the output.
	originNanos int64
	sequence    uint32
	poll, idle  time.Duration
}

// openLive positions a stream at the newest keyframe of the camera's newest
// segment, waiting up to idle for MediaMTX to write one.
func openLive(ctx context.Context, dir string, poll, idle time.Duration) (*liveStream, error) {
	names, err := segmentNames(dir)
	if err != nil {
		return nil, err
	}
	if len(names) == 0 {
		return nil, errNoRecording
	}
	path := filepath.Join(dir, names[len(names)-1])
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if time.Since(info.ModTime()) > idle {
		return nil, errStalled
	}
	deadline := time.Now().Add(idle)
	for {
		segment, err := openSegment(path)
		if err == nil {
			if err = segment.seekToNewestKeyframe(); err == nil {
				first, _, err := segment.partAt(segment.offset)
				if err != nil {
					segment.Close()
					return nil, err
				}
				return &liveStream{
					dir:         dir,
					segment:     segment,
					originNanos: segment.startNanos(first),
					poll:        poll,
					idle:        idle,
				}, nil
			}
			segment.Close()
		}
		if !errors.Is(err, errIncomplete) {
			return nil, err
		}
		if time.Now().After(deadline) {
			return nil, errStalled
		}
		if err := sleep(ctx, poll); err != nil {
			return nil, err
		}
	}
}

func (l *liveStream) Close() error { return l.segment.Close() }

// initSegment is the ftyp and moov the output starts with.
func (l *liveStream) initSegment() []byte { return l.segment.initRaw }

// copyTo writes each part to w as MediaMTX records it, until the context
// ends, the recording restarts or it stops growing for idle.
func (l *liveStream) copyTo(ctx context.Context, w io.Writer, flush func()) error {
	lastPart := time.Now()
	for {
		part, err := l.segment.nextPart()
		if err == nil {
			if err := l.write(w, part); err != nil {
				return err
			}
			flush()
			lastPart = time.Now()
			continue
		}
		if !errors.Is(err, errIncomplete) {
			return err
		}
		switched, err := l.switchSegment()
		if err != nil {
			return err
		}
		if switched {
			continue
		}
		if time.Since(lastPart) > l.idle {
			return errStalled
		}
		if err := sleep(ctx, l.poll); err != nil {
			return err
		}
	}
}

// switchSegment moves on to the camera's next segment once MediaMTX has
// started writing it.
func (l *liveStream) switchSegment() (bool, error) {
	name, ok, err := segmentAfter(l.dir, l.segment.name)
	if err != nil || !ok {
		return false, err
	}
	next, err := openSegment(filepath.Join(l.dir, name))
	if errors.Is(err, errIncomplete) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if !l.segment.continues(next) {
		next.Close()
		return false, errDiscontinuity
	}
	l.segment.Close()
	l.segment = next
	return true, nil
}

// write re-times a part onto the output's clock. Segment times come from
// MediaMTX's stream time, so consecutive segments join without a gap.
func (l *liveStream) write(w io.Writer, part *fmp4.Part) error {
	shift := l.segment.info.DTS - l.originNanos
	for _, track := range part.Tracks {
		base := toTicks(shift, l.segment.timeScale(track.ID)) + int64(track.BaseTime)
		// Rounding can put the first part's earliest track a tick below zero.
		track.BaseTime = uint64(max(base, 0))
	}
	l.sequence++
	part.SequenceNumber = l.sequence
	var buf seekablebuffer.Buffer
	if err := part.Marshal(&buf); err != nil {
		return err
	}
	_, err := w.Write(buf.Bytes())
	return err
}

// segmentNames lists a camera's segment files, oldest first: MediaMTX names
// them after their start time.
func segmentNames(dir string) ([]string, error) {
	entries, err := os.ReadDir(dir)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, errNoRecording
	}
	if err != nil {
		return nil, err
	}
	var names []string
	for _, entry := range entries {
		if entry.Type().IsRegular() && strings.HasSuffix(entry.Name(), ".mp4") {
			names = append(names, entry.Name())
		}
	}
	return names, nil
}

func segmentAfter(dir, name string) (string, bool, error) {
	names, err := segmentNames(dir)
	if err != nil {
		return "", false, err
	}
	for _, candidate := range names {
		if candidate > name {
			return candidate, true, nil
		}
	}
	return "", false, nil
}

func sleep(ctx context.Context, d time.Duration) error {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd live && go vet ./... && go test -race ./...`
Expected: `ok  github.com/arnabry11/home-nvr/live`.

- [ ] **Step 5: Commit**

```bash
git add live/stream.go live/stream_test.go
git commit -m "Stream a camera's newest recording as one continuous fMP4

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: HTTP service and deployment wiring

**Files:**
- Create: `live/handler.go`, `live/main.go`, `live/Dockerfile`
- Modify: `docker-compose.yml`, `docker-compose.dev.yml`, `web/nginx/default.conf`, `web/vite.config.ts`
- Test: `live/handler_test.go`

**Interfaces:**
- Consumes (Task 2): `openLive`, `(*liveStream).initSegment/copyTo/Close`, `errNoRecording`, `errStalled`, `errDiscontinuity`.
- Produces (used by Task 4): `GET /live/{camera}` in the container on `:8080`, proxied as `/api/live/{camera}` by nginx and Vite. Answers `200` with `Content-Type: video/mp4` and an endless body; `404` for unknown or invalid cameras; `503` when the recording isn't growing.

- [ ] **Step 1: Write the failing tests**

`live/handler_test.go`:

```go
package main

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func testServer(t *testing.T, root string) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(newMux(root, 10*time.Millisecond, time.Second))
	t.Cleanup(server.Close)
	return server
}

func cameraDir(t *testing.T, root, camera string) string {
	t.Helper()
	dir := filepath.Join(root, camera)
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestServeLiveRejectsUnknownCameras(t *testing.T) {
	root := t.TempDir()
	cameraDir(t, root, "garage")
	server := testServer(t, root)
	for _, camera := range []string{"missing", "Garage", "gar.age", "..%2Fetc"} {
		response, err := http.Get(server.URL + "/live/" + camera)
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if response.StatusCode != http.StatusNotFound {
			t.Errorf("%s: status %d, want 404", camera, response.StatusCode)
		}
	}
}

func TestServeLiveStreamsTheNewestRecording(t *testing.T) {
	root := t.TempDir()
	segment := testSegment{stream: streamA, keyframes: []bool{true}, audio: true}
	segment.write(t, cameraDir(t, root, "garage"), 1)
	response, err := http.Get(testServer(t, root).URL + "/live/garage")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK ||
		response.Header.Get("Content-Type") != "video/mp4" ||
		response.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("status %d, headers %v", response.StatusCode, response.Header)
	}
	init := segment.initBytes(t)
	body := make([]byte, len(init)+8)
	if _, err := io.ReadFull(response.Body, body); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(body[:len(init)], init) {
		t.Error("the body does not start with the recorded ftyp+moov")
	}
	if typ := string(body[len(init)+4:]); typ != "moof" {
		t.Errorf("the init is followed by %q, want a part", typ)
	}
}

func TestServeLiveReportsAStoppedRecording(t *testing.T) {
	root := t.TempDir()
	path := testSegment{stream: streamA, keyframes: []bool{true}}.write(t, cameraDir(t, root, "garage"), 1)
	old := time.Now().Add(-time.Minute)
	if err := os.Chtimes(path, old, old); err != nil {
		t.Fatal(err)
	}
	response, err := http.Get(testServer(t, root).URL + "/live/garage")
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusServiceUnavailable {
		t.Errorf("status %d, want 503", response.StatusCode)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd live && go test ./...`
Expected: build failure, `undefined: newMux`.

- [ ] **Step 3: Implement `handler.go`**

```go
package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"path/filepath"
	"regexp"
	"time"
)

// Camera names are MediaMTX path names; nothing else reaches the disk.
var cameraName = regexp.MustCompile(`^[a-z0-9_]+$`)

func newMux(root string, poll, idle time.Duration) *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /live/{camera}", func(w http.ResponseWriter, r *http.Request) {
		serveLive(w, r, root, poll, idle)
	})
	return mux
}

func serveLive(w http.ResponseWriter, r *http.Request, root string, poll, idle time.Duration) {
	camera := r.PathValue("camera")
	if !cameraName.MatchString(camera) {
		http.NotFound(w, r)
		return
	}
	stream, err := openLive(r.Context(), filepath.Join(root, camera), poll, idle)
	switch {
	case errors.Is(err, errNoRecording):
		http.NotFound(w, r)
		return
	case errors.Is(err, errStalled):
		http.Error(w, "camera is not recording", http.StatusServiceUnavailable)
		return
	case errors.Is(err, context.Canceled):
		return
	case err != nil:
		log.Printf("%s: %v", camera, err)
		http.Error(w, "live view failed", http.StatusInternalServerError)
		return
	}
	defer stream.Close()
	w.Header().Set("Content-Type", "video/mp4")
	w.Header().Set("Cache-Control", "no-store")
	controller := http.NewResponseController(w)
	flush := func() { _ = controller.Flush() }
	if _, err := w.Write(stream.initSegment()); err != nil {
		return
	}
	flush()
	err = stream.copyTo(r.Context(), w, flush)
	// A viewer leaving, a restarted recording and a stalled one all just end
	// the response; the browser reconnects.
	if err != nil && r.Context().Err() == nil &&
		!errors.Is(err, errDiscontinuity) && !errors.Is(err, errStalled) {
		log.Printf("%s: %v", camera, err)
	}
}
```

- [ ] **Step 4: Implement `main.go`**

```go
// Command live serves each camera's newest recording as one endless fMP4
// stream, so the NVR's live view plays exactly what MediaMTX recorded.
package main

import (
	"log"
	"net/http"
	"os"
	"time"
)

const (
	// MediaMTX appends a part every second.
	pollInterval = 200 * time.Millisecond
	// A recording that has not grown for this long counts as stopped.
	idleTimeout = 15 * time.Second
)

func main() {
	root := envOr("RECORDINGS_DIR", "/recordings")
	address := envOr("LISTEN_ADDR", ":8080")
	server := &http.Server{
		Addr:              address,
		Handler:           newMux(root, pollInterval, idleTimeout),
		ReadHeaderTimeout: 10 * time.Second,
	}
	log.Printf("serving live views of %s on %s", root, address)
	log.Fatal(server.ListenAndServe())
}

func envOr(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd live && go vet ./... && go test -race ./...`
Expected: `ok  github.com/arnabry11/home-nvr/live`.

- [ ] **Step 6: Add the Dockerfile and build it**

`live/Dockerfile`:

```dockerfile
FROM golang:1.26.0-alpine AS build

WORKDIR /src

COPY go.mod go.sum ./
RUN go mod download

COPY *.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /live .

FROM gcr.io/distroless/static-debian12:nonroot

COPY --from=build /live /live

EXPOSE 8080
ENTRYPOINT ["/live"]
```

Run: `docker build -t nvr-live ./live`
Expected: build succeeds; `docker image ls nvr-live` shows an image of roughly 10 MB.

- [ ] **Step 7: Wire it into compose, nginx and Vite**

`docker-compose.yml`: add the service after `watchdog`, and make `web` depend on it:

```yaml
  live:
    build:
      context: ./live
    container_name: nvr-live
    restart: always
    depends_on:
      - mediamtx
    volumes:
      # Read-only: the live view only ever reads what MediaMTX recorded.
      - ${RECORDINGS_DIR:-./recordings}:/recordings:ro

  web:
    build:
      context: ./web
    container_name: nvr-web
    restart: always
    depends_on:
      - go2rtc
      - mediamtx
      - live
```

`docker-compose.dev.yml`: add under `services:`, and add `live` to the run instruction in the header comment (`... up -d go2rtc mediamtx live`):

```yaml
  live:
    ports:
      - "8082:8080"
```

`web/nginx/default.conf`, full new content:

```nginx
server {
  listen 80;
  server_name _;

  root /usr/share/nginx/html;
  index index.html;

  # go2rtc: camera list.
  location /api/go2rtc/ {
    proxy_pass http://go2rtc:1984/;
    proxy_http_version 1.1;
  }

  # MediaMTX playback server: recording list and fMP4/MP4 clips.
  location /api/mediamtx/ {
    proxy_pass http://mediamtx:9996/;
    proxy_http_version 1.1;
    proxy_buffering off;
    proxy_read_timeout 1h;
  }

  # Live service: an endless fMP4 that follows a camera's newest recording.
  location /api/live/ {
    proxy_pass http://live:8080/live/;
    proxy_http_version 1.1;
    proxy_buffering off;
    proxy_read_timeout 1h;
  }

  location / {
    try_files $uri $uri/ /index.html;
  }
}
```

`web/vite.config.ts`: next to the existing targets add

```ts
  const liveTarget = environment.VITE_LIVE_URL || 'http://localhost:8082';
```

change the `// The dev compose override publishes go2rtc and MediaMTX on localhost.` comment to `// The dev compose override publishes go2rtc, MediaMTX and the live service on localhost.`, remove `ws: true,` from the `/api/go2rtc` proxy, and add after the `/api/mediamtx` entry:

```ts
        '/api/live': {
          target: liveTarget,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api/, ''),
        },
```

Run: `docker compose -f docker-compose.yml -f docker-compose.dev.yml config --quiet && cd web && npm run build`
Expected: both succeed with no output from `config --quiet`.

- [ ] **Step 8: Commit**

```bash
git add live/handler.go live/main.go live/handler_test.go live/Dockerfile docker-compose.yml docker-compose.dev.yml web/nginx/default.conf web/vite.config.ts
git commit -m "Serve live views from the recordings over HTTP

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Browser live tile

**Files:**
- Create: `web/src/utils/live.ts`
- Modify: `web/src/components/LiveCameraVideo/LiveCameraVideo.tsx` (full rewrite), `web/src/components/CameraTile/CameraTile.tsx`, `web/src/api/rest/nvr-client.ts`, `web/src/types/camera.ts`, `web/src/pages/playback/PlaybackView.tsx`, `web/src/components/PlaybackTimeline/PlaybackTimeline.tsx`
- Test: `web/src/utils/live.test.ts`, `web/src/components/LiveCameraVideo/LiveCameraVideo.test.tsx`, `web/src/components/PlaybackTimeline/PlaybackTimeline.test.tsx`

**Interfaces:**
- Consumes (Task 3): `GET /api/live/{camera}`.
- Produces: `LiveCameraVideo({ camera: Camera; muted: boolean })`, `catchUpTime(currentTime: number, bufferedEnd: number | undefined): number | undefined` in `@/utils/live` (kept out of the component file, because `react-refresh/only-export-components` fails lint on non-component exports), `nvrClient.liveUrl(stream: string, session: number): string`. `Camera` loses `liveStream`; `nvrClient` loses `liveSocketUrl`. While following live, the playback page shows no clock: tiles get no `timestamp`, and the timeline heading reads `Live`.

- [ ] **Step 1: Write the failing tests**

`web/src/utils/live.test.ts`:

```ts
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
```

`web/src/components/PlaybackTimeline/PlaybackTimeline.test.tsx`:

```tsx
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
```

`web/src/components/LiveCameraVideo/LiveCameraVideo.test.tsx`:

```tsx
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

  it("reconnects 2 s after the stream ends", () => {
    const { container } = render(<LiveCameraVideo camera={camera} muted />);
    act(() => {
      videoIn(container).dispatchEvent(new Event("ended"));
    });
    act(() => {
      vi.advanceTimersByTime(1_999);
    });
    expect(videoIn(container).getAttribute("src")).toBe(
      "/api/live/garage?session=0",
    );
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(videoIn(container).getAttribute("src")).toBe(
      "/api/live/garage?session=1",
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd web && npx vitest run`
Expected: FAIL. `./live` does not exist, the `camera` prop does not exist, and the timeline heading still shows the time while live.

- [ ] **Step 3: Add `web/src/utils/live.ts`**

```ts
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
```

- [ ] **Step 4: Rewrite `LiveCameraVideo.tsx`**

```tsx
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
```

- [ ] **Step 5: Update the client, the type and the tile**

`web/src/api/rest/nvr-client.ts`:
- Replace `const subStreamSuffix = "_sub";` with `const liveOrigin = "/api/live";`, and change the comment above the origins to `// All are reverse-proxied on the same origin: by Vite in development and by\n// nginx in the container.`
- Change `discoverCameras` to:

```ts
  async discoverCameras(): Promise<Camera[]> {
    const streams = await requestJson<Record<string, unknown>>(
      `${go2rtcOrigin}/api/streams`,
    );
    return Object.keys(streams)
      .sort()
      .map((name) => ({
        id: name,
        name: formatCameraName(name),
        status: "online" as const,
        mainStream: name,
      }));
  },
```

- Replace `liveSocketUrl` with:

```ts
  /** An endless fMP4 following the camera's newest recording. */
  liveUrl(stream: string, session: number) {
    return `${liveOrigin}/${encodeURIComponent(stream)}?${new URLSearchParams({
      session: String(session),
    })}`;
  },
```

`web/src/types/camera.ts`: remove `liveStream` and its comment, and change the `mainStream` comment to `/** go2rtc stream name; also the MediaMTX recording path and live service camera. */`

`web/src/components/CameraTile/CameraTile.tsx`: replace

```tsx
        <LiveCameraVideo
          // Full resolution only when the tile fills the screen.
          stream={isFullscreen ? camera.mainStream : camera.liveStream}
          muted={isMuted}
        />
```

with

```tsx
        <LiveCameraVideo camera={camera} muted={isMuted} />
```

- [ ] **Step 6: Remove the clock while following live**

`web/src/pages/playback/PlaybackView.tsx`: in the `<CameraGrid>` props, replace

```tsx
            timestamp={
              playbackData.windowEnd
                ? formatTimestamp(selectedTimestamp)
                : undefined
            }
```

with

```tsx
            // Live view runs a few seconds behind, so no clock is shown:
            // the tiles say LIVE instead.
            timestamp={
              playbackData.windowEnd && !isFollowingLive
                ? formatTimestamp(selectedTimestamp)
                : undefined
            }
```

`web/src/components/PlaybackTimeline/PlaybackTimeline.tsx`: in the `timeline-heading` element, replace

```tsx
<span>{windowEnd ? formatTimestamp(timestamp) : 'Loading timeline…'}</span>
```

with

```tsx
<span>{isLive ? 'Live' : windowEnd ? formatTimestamp(timestamp) : 'Loading timeline…'}</span>
```

The calendar button in the page header keeps showing the date; it carries no time.

- [ ] **Step 7: Run the tests, lint and build**

Run: `cd web && npx vitest run && npm run lint && npm run build`
Expected: all tests pass, ESLint has no warnings, the build succeeds.

- [ ] **Step 8: Commit**

```bash
git add web/src
git commit -m "Play live view from the recordings instead of go2rtc

Live view now runs a few seconds behind, so the playback page shows Live
instead of a clock while following it.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Record the cameras as they send, and document it

**Files:**
- Modify: `go2rtc/go2rtc.yaml`, `mediamtx/mediamtx.yml`, `README.md`

**Interfaces:**
- Consumes: Tasks 3 and 4 (the README describes them).
- Produces: MediaMTX paths `garage`, `backside_garden`, `left_corner`, `sideway`, `backside_main` with source `rtsp://go2rtc:8554/<name>?video&audio=pcma`; go2rtc streams with the same names and no `_sub` streams.

- [ ] **Step 1: Replace `go2rtc/go2rtc.yaml`**

Keep the five camera URLs exactly as they are (IPs `.101` to `.105`):

```yaml
# Camera connections. go2rtc keeps one RTSP session per camera and re-serves
# it to MediaMTX, which records it. Browsers never get video from go2rtc:
# playback and live view both come from the recordings.
#
# The cameras' G.711 (PCMA) audio is recorded as it arrives; Chrome plays it
# from the recordings, so nothing converts it.
api:
  listen: ":1984"

rtsp:
  listen: ":8554"

webrtc:
  listen: ""

streams:
  garage:
    - rtsp://${CAMERA_USER}:${CAMERA_PASSWORD}@192.168.0.101:554/stream1#backchannel=0#timeout=30
  backside_garden:
    - rtsp://${CAMERA_USER}:${CAMERA_PASSWORD}@192.168.0.102:554/stream1#backchannel=0#timeout=30
  left_corner:
    - rtsp://${CAMERA_USER}:${CAMERA_PASSWORD}@192.168.0.103:554/stream1#backchannel=0#timeout=30
  sideway:
    - rtsp://${CAMERA_USER}:${CAMERA_PASSWORD}@192.168.0.104:554/stream1#backchannel=0#timeout=30
  backside_main:
    - rtsp://${CAMERA_USER}:${CAMERA_PASSWORD}@192.168.0.105:554/stream1#backchannel=0#timeout=30
```

- [ ] **Step 2: Update `mediamtx/mediamtx.yml`**

Replace the first two comment lines with:

```yaml
# MediaMTX records every camera from go2rtc as the camera sends it (H.264
# video, G.711 audio stored as LPCM) and serves recordings back through its
# playback API. The live service reads the same files.
```

and set every path's source to `?video&audio=pcma`:

```yaml
paths:
  garage:
    source: rtsp://go2rtc:8554/garage?video&audio=pcma
  backside_garden:
    source: rtsp://go2rtc:8554/backside_garden?video&audio=pcma
  left_corner:
    source: rtsp://go2rtc:8554/left_corner?video&audio=pcma
  sideway:
    source: rtsp://go2rtc:8554/sideway?video&audio=pcma
  backside_main:
    source: rtsp://go2rtc:8554/backside_main?video&audio=pcma
```

- [ ] **Step 3: Update `README.md`**

Replace the opening paragraph:

```markdown
A small, inference-free NVR for the home cameras: continuous recording with
audio, synchronized multi-camera playback, a live view built from the
recordings and MP4 export. Nothing is decoded or re-encoded: video and audio
are recorded exactly as the cameras send them, so it runs in a few percent of
one CPU core.
```

Replace the diagram:

```
cameras ──RTSP──▶ go2rtc ──RTSP (H.264 + G.711)──▶ MediaMTX ──▶ recordings/ (fMP4)
                                                      │               │
                                    playback API (/list, /get)   live (follows the newest segment)
                                                      ▼               ▼
                  web (React UI + nginx) ◀── Tailscale sidecar ── https://nvr.<tailnet>.ts.net
```

Replace the service table:

```markdown
| Service     | Role |
|-------------|------|
| `go2rtc`    | Holds one RTSP session per camera and re-serves it to MediaMTX. |
| `mediamtx`  | Records every camera (H.264, G.711 stored as LPCM) to fMP4 segments, deletes them after `RECORD_RETENTION`, and serves clips through its playback API. |
| `live`      | Serves each camera's newest recording as one endless fMP4 stream for the live view (in [`live/`](live)). Reads the recordings read-only. |
| `web`       | The UI (in [`web/`](web)), plus an nginx proxy for `/api/go2rtc/`, `/api/mediamtx/` and `/api/live/`. |
| `tailscale` | Publishes `web` over HTTPS on the tailnet. No service publishes a port on the host. |
| `watchdog`  | Reconnects a camera whose recording lost its video while its audio kept flowing (a camera can do this; MediaMTX would otherwise record audio alone). |
```

Append to the end of the `## Playback` section, before the key table:

```markdown
Live view plays each camera's newest recording a few seconds behind real time
(the Tapo app is the real-time view). The live service starts at the newest
keyframe and keeps following the recording across segments; when the
recording restarts or stops, it ends the stream and the browser reconnects.

Only Chrome is supported: recordings carry the cameras' audio as LPCM, which
Chrome plays in a plain video element but not through Media Source
Extensions, and some other browsers not at all.
```

Replace the `## Cameras` list and the paragraph about cameras without audio with:

```markdown
Cameras are listed in two places:

1. [`go2rtc/go2rtc.yaml`](go2rtc/go2rtc.yaml): one stream per camera, its
   full-resolution stream.
2. [`mediamtx/mediamtx.yml`](mediamtx/mediamtx.yml): one path per camera,
   pulling `<name>?video&audio=pcma` from go2rtc.

The UI discovers cameras from go2rtc, so nothing else needs to change.
```

In `## Development`, change the compose command to `... up -d go2rtc mediamtx live` and add after the `npm` block:

````markdown
```bash
cd live
go test ./...
RECORDINGS_DIR=../recordings LISTEN_ADDR=:8082 go run .   # instead of the container
```
````

- [ ] **Step 4: Check the configuration**

Run: `docker compose -f docker-compose.yml -f docker-compose.dev.yml config --quiet && ruby -ryaml -e 'puts YAML.load_file("go2rtc/go2rtc.yaml")["streams"].keys.join(" "); YAML.load_file("mediamtx/mediamtx.yml")["paths"].each { |k, v| puts "#{k} #{v["source"]}" }'`
Expected: `garage backside_garden left_corner sideway backside_main`, then five `?video&audio=pcma` sources.

- [ ] **Step 5: Commit**

```bash
git add go2rtc/go2rtc.yaml mediamtx/mediamtx.yml README.md
git commit -m "Record each camera's own audio and drop the ffmpeg and sub streams

The always-on ffmpeg AAC converters delivered audio that MediaMTX
discarded as late or recorded seconds ahead of the picture. Recording the
camera's G.711 as-is keeps audio and video together; Chrome plays it from
the recordings and the live service.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Deploy and verify on homeserver

**Files:** none (deployment and checks).

**Interfaces:**
- Consumes: Tasks 1 to 5 on `main`.
- Produces: the running NVR.

- [ ] **Step 1: Ask the user before deploying**

Deploying restarts go2rtc and MediaMTX, leaving a few seconds' gap in every camera's recording, and pushes to GitHub. Get an explicit go-ahead.

- [ ] **Step 2: Push and deploy**

```bash
git push origin main
ssh -A homeserver 'cd /home/arnab/dev/home-nvr && git pull --ff-only && docker compose up -d --build && docker compose ps'
```

Expected: `nvr-live` and the other five containers `Up`.

- [ ] **Step 3: Check the recordings**

```bash
ssh homeserver 'sleep 20; docker logs --since 1m nvr-mediamtx 2>&1 | grep -E "recording [0-9] track"; docker exec nvr-go2rtc ps | grep -c ffmpeg; docker logs nvr-live'
```

Expected: five lines `recording 2 tracks (H264, G711)` (or `(G711, H264)`), `0` ffmpeg processes, and `serving live views of /recordings on :8080`.

- [ ] **Step 4: Check live view in Chrome**

Open `https://nvr.drake-paradise.ts.net/dashboard` in Chrome (Playwright MCP works) and run:

```js
async () => Promise.all([...document.querySelectorAll("video")].map(async (video) => {
  const before = video.webkitAudioDecodedByteCount;
  await new Promise((resolve) => setTimeout(resolve, 5000));
  return { src: video.getAttribute("src"), playing: !video.paused, currentTime: video.currentTime.toFixed(1),
           audioBytesPerSecond: Math.round((video.webkitAudioDecodedByteCount - before) / 5) };
}))
```

Expected: one entry per camera, `src` `/api/live/<camera>?session=0`, playing, `audioBytesPerSecond` close to 16000. Then open the playback page and press Live: the tiles show `LIVE` with no time, and the timeline heading reads `Live`.

- [ ] **Step 5: Check latency against the camera's clock**

Take a screenshot of the dashboard and compare each camera's burned-in Tapo timestamp with the time the screenshot was taken.
Expected: each camera 2 to 6 s behind.

- [ ] **Step 6: Check a segment rollover on the real recordings**

```bash
ssh homeserver 'docker run --rm --network home-nvr_default curlimages/curl:8.11.1 -sN --max-time 1080 http://live:8080/live/garage -o - ' > /tmp/live-garage.mp4; ffprobe -v error -select_streams v -show_entries packet=pts_time -of csv=p=0 /tmp/live-garage.mp4 | awk 'NR>1 && $1-p>0.5 {print "gap at " p " (" $1-p "s)"} {p=$1} END {print "last " p}'
```

(Check the network name with `docker network ls` first; it is `<project>_default`.) This runs for 18 minutes, so it covers at least one 15-minute rollover.
Expected: no gaps, and `last` close to 1080. A stream that ends early (with `last` well below 1080) means a rollover failed `continues`; compare the two segments' `mtxi` and tracks.

- [ ] **Step 7: Check reconnection**

```bash
ssh homeserver 'docker restart nvr-mediamtx'
```

Watch the dashboard in Chrome.
Expected: tiles show `Live view unavailable, retrying` or freeze briefly, then play again within about 20 s without a page reload.

- [ ] **Step 8: Check playback of new recordings**

On the playback page, pick a time after the deploy for all cameras and play.
Expected: all five play with audio. In MediaMTX's logs, `docker logs --since 30m nvr-mediamtx 2>&1 | grep -c "too late"` is `0`.

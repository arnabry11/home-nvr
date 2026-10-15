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
	keyframes []bool        // whether each part's video has a keyframe
	// keyframeSample is the keyframe's position in those parts: MediaMTX cuts
	// parts every second, wherever the camera's keyframes fall.
	keyframeSample int
	audio          bool
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
			IsNonSyncSample: n != s.keyframeSample || !s.keyframes[i],
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

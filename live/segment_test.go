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

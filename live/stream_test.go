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

func TestLiveEndsAtTheFirstSegmentBoundaryAfterMaxAge(t *testing.T) {
	defer func(age time.Duration) { maxStreamAge = age }(maxStreamAge)
	maxStreamAge = 0
	dir := t.TempDir()
	testSegment{stream: streamA, number: 5, start: 100 * time.Second, keyframes: []bool{true, false}, audio: true}.write(t, dir, 2)
	out, done := runLive(t, openTestLive(t, dir, time.Second))
	out.waitForParts(t, 2)
	testSegment{stream: streamA, number: 6, start: 102 * time.Second, keyframes: []bool{true}, audio: true}.write(t, dir, 1)
	if err := waitDone(t, done); !errors.Is(err, errMaxAge) {
		t.Fatalf("err = %v, want errMaxAge", err)
	}
	if parts := out.waitForParts(t, 2); len(parts) != 2 {
		t.Errorf("sent %d parts, want only the first segment's 2", len(parts))
	}
}

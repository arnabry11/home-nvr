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

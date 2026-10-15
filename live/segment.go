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

// seekToNewestKeyframe moves to the newest written part whose video has a
// keyframe, where a viewer can start decoding (see trimToKeyframe). It
// returns errIncomplete while there is none.
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
		if keyframeIndex(part, video) >= 0 {
			s.offset = offsets[i]
			return nil
		}
	}
	return errIncomplete
}

// keyframeIndex is the position of the part's first video keyframe, or -1.
func keyframeIndex(part *fmp4.Part, videoID int) int {
	for _, track := range part.Tracks {
		if track.ID != videoID {
			continue
		}
		for i, sample := range track.Samples {
			if !sample.IsNonSyncSample {
				return i
			}
		}
	}
	return -1
}

// trimToKeyframe drops what comes before the part's first video keyframe, so
// a stream starts with a picture the decoder can show. MediaMTX cuts parts
// every second, which rarely lines up with the camera's keyframes. Audio
// keeps the sample that is playing at the keyframe.
func (s *segmentFile) trimToKeyframe(part *fmp4.Part) {
	videoID := s.videoTrackID()
	keyframe := keyframeIndex(part, videoID)
	if keyframe < 0 {
		return
	}
	var keyframeNanos int64
	for _, track := range part.Tracks {
		if track.ID == videoID {
			for _, sample := range track.Samples[:keyframe] {
				track.BaseTime += uint64(sample.Duration)
			}
			track.Samples = track.Samples[keyframe:]
			keyframeNanos = toNanos(int64(track.BaseTime), s.timeScale(videoID))
		}
	}
	tracks := part.Tracks[:0]
	for _, track := range part.Tracks {
		scale := s.timeScale(track.ID)
		for track.ID != videoID && len(track.Samples) > 0 &&
			toNanos(int64(track.BaseTime)+int64(track.Samples[0].Duration), scale) <= keyframeNanos {
			track.BaseTime += uint64(track.Samples[0].Duration)
			track.Samples = track.Samples[1:]
		}
		if len(track.Samples) > 0 {
			tracks = append(tracks, track)
		}
	}
	part.Tracks = tracks
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

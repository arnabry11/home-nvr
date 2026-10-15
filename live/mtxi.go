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

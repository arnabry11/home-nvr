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

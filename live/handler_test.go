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

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

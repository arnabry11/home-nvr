# Home NVR

A small, inference-free NVR for the home cameras: continuous recording with
audio, synchronized multi-camera playback, a live view built from the
recordings and MP4 export. Nothing is decoded or re-encoded: video and audio
are recorded exactly as the cameras send them, so it runs in a few percent of
one CPU core.

```
cameras ──RTSP──▶ go2rtc ──RTSP (H.264 + G.711)──▶ MediaMTX ──▶ recordings/ (fMP4)
                                                      │               │
                                    playback API (/list, /get)   live (follows the newest segment)
                                                      ▼               ▼
                  web (React UI + nginx) ◀── Tailscale sidecar ── https://nvr.<tailnet>.ts.net
```

| Service     | Role |
|-------------|------|
| `go2rtc`    | Holds one RTSP session per camera and re-serves it to MediaMTX. |
| `mediamtx`  | Records every camera (H.264, G.711 stored as LPCM) to fMP4 segments, deletes them after `RECORD_RETENTION`, and serves clips through its playback API. |
| `live`      | Serves each camera's newest recording as one endless fMP4 stream for the live view (in [`live/`](live)). Reads the recordings read-only. |
| `web`       | The UI (in [`web/`](web)), plus an nginx proxy for `/api/go2rtc/`, `/api/mediamtx/` and `/api/live/`. |
| `tailscale` | Publishes `web` over HTTPS on the tailnet. No service publishes a port on the host. |
| `watchdog`  | Reconnects a camera whose recording lost its video while its audio kept flowing (a camera can do this; MediaMTX would otherwise record audio alone). |

## Deploy

```bash
git clone git@github.com:arnabry11/home-nvr.git && cd home-nvr
cp .env.example .env   # camera credentials, Tailscale auth key, recordings dir
docker compose up -d --build
```

The UI is then at `https://nvr.<tailnet>.ts.net` (from `TS_HOSTNAME`). The
Tailscale auth key is only needed on the first start; the node's identity is
kept in the `tailscale-state` volume.

Disk use is roughly 1 Mbps per camera on average (about 10 GB per camera per
day); MediaMTX deletes by age, not by size, so size `RECORD_RETENTION` to the
disk.

## Playback

All selected cameras follow one clock. If any camera is buffering, all of
them wait; a camera that drifts more than 1.5 s from the clock reloads at the
clock's time. Clicking a gap jumps to the next recording, stretches where no
selected camera recorded are skipped, and catching up with the present on
today's timeline switches to live view.

Live view plays each camera's newest recording a few seconds behind real time
(the Tapo app is the real-time view). The live service starts at the newest
keyframe and keeps following the recording across segments; when the
recording restarts or stops, it ends the stream and the browser reconnects.

Only Chrome is supported: recordings carry the cameras' audio as LPCM, which
Chrome plays in a plain video element but not through Media Source
Extensions, and some other browsers not at all.

| Key | Action |
|-----|--------|
| Space | Play / pause |
| ← / → | Back / forward 10 s |
| Shift + ← / → | Back / forward 1 min |
| L | Follow live |

## Cameras

Cameras are listed in two places:

1. [`go2rtc/go2rtc.yaml`](go2rtc/go2rtc.yaml): one stream per camera, its
   full-resolution stream.
2. [`mediamtx/mediamtx.yml`](mediamtx/mediamtx.yml): one path per camera,
   pulling `<name>?video&audio=pcma` from go2rtc.

The UI discovers cameras from go2rtc, so nothing else needs to change.

## Development

```bash
# Recorder stack with the APIs published on localhost (no Tailscale).
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d go2rtc mediamtx live

cd web
npm install
npm run dev      # proxies /api/go2rtc, /api/mediamtx and /api/live to the containers
npm run lint
npm run build
```

```bash
cd live
go test ./...
RECORDINGS_DIR=../recordings LISTEN_ADDR=:8082 go run .   # instead of the container
```

Add `web` to the compose command to try the production image at
`http://localhost:8081`.

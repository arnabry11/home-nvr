# Home NVR

A small, inference-free NVR for the home cameras: continuous recording with
audio, live view, synchronized multi-camera playback and MP4 export. Nothing
is decoded or re-encoded except the cameras' G.711 audio, so it runs in a few
percent of one CPU core.

```
cameras ──RTSP──▶ go2rtc ──RTSP (H.264 + AAC)──▶ MediaMTX ──▶ recordings/ (fMP4)
                    │                               │
                    │ live MSE (WebSocket)          │ playback API (/list, /get)
                    ▼                               ▼
                  web (React UI + nginx) ◀── Tailscale sidecar ── https://nvr.<tailnet>.ts.net
```

| Service     | Role |
|-------------|------|
| `go2rtc`    | Holds one RTSP session per camera stream and re-serves it. Adds an AAC copy of the PCMA audio (browsers cannot play PCMA). |
| `mediamtx`  | Records every camera's full-resolution stream to fMP4 segments, deletes them after `RECORD_RETENTION`, and serves clips through its playback API. |
| `web`       | The UI (in [`web/`](web)), plus an nginx proxy for `/api/go2rtc/` and `/api/mediamtx/`. |
| `tailscale` | Publishes `web` over HTTPS on the tailnet. No service publishes a port on the host. |

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

## Cameras

Cameras are listed in two places:

1. [`go2rtc/go2rtc.yaml`](go2rtc/go2rtc.yaml): `<name>` is the main stream
   (recorded, used for playback and fullscreen live view) and `<name>_sub` is
   the low-resolution stream used for the live grid.
2. [`mediamtx/mediamtx.yml`](mediamtx/mediamtx.yml): one path per camera,
   pulling `<name>` from go2rtc.

The UI discovers cameras from go2rtc, so nothing else needs to change.

## Development

```bash
# Recorder stack with the APIs published on localhost (no Tailscale).
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d go2rtc mediamtx

cd web
npm install
npm run dev      # proxies /api/go2rtc and /api/mediamtx to the containers
npm run lint
npm run build
```

Add `web` to the compose command to try the production image at
`http://localhost:8081`.

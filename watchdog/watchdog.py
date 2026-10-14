"""Reconnects a camera whose recording has lost its video.

A camera can stop sending video while its audio keeps flowing. MediaMTX only
notices silence on the whole connection, so it would keep recording audio
alone. Every CHECK_SECONDS this compares, per camera, the video packets go2rtc
has sent to MediaMTX; if none arrived, it points the MediaMTX path at nothing
for a few seconds (so go2rtc closes the camera session) and then back.
"""

import json
import os
import time
import urllib.request

GO2RTC_API = os.environ.get("GO2RTC_API", "http://go2rtc:1984")
MEDIAMTX_API = os.environ.get("MEDIAMTX_API", "http://mediamtx:9997")
CHECK_SECONDS = int(os.environ.get("CHECK_SECONDS", "10"))
DETACH_SECONDS = 5
RECOVERY_COOLDOWN_SECONDS = 60
DETACHED_SOURCE = "rtsp://go2rtc:8554/watchdog-detached"
# MediaMTX's RTSP client identifies itself as gortsplib.
RECORDER_USER_AGENT = "gortsplib"


def log(message):
    print(time.strftime("%Y-%m-%d %H:%M:%S"), message, flush=True)


def request_json(url, method="GET", body=None):
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(url, data=data, method=method)
    if data is not None:
        request.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(request, timeout=10) as response:
        content = response.read()
    return json.loads(content) if content else None


def set_source(path, source):
    request_json(
        f"{MEDIAMTX_API}/v3/config/paths/patch/{path}",
        method="PATCH",
        body={"source": source},
    )


def recorder_video_packets():
    """Maps each recorded camera to (recorder connection, video packets sent)."""
    streams = request_json(f"{GO2RTC_API}/api/streams")
    packets = {}
    for name, stream in streams.items():
        for consumer in (stream or {}).get("consumers") or []:
            if consumer.get("user_agent") != RECORDER_USER_AGENT:
                continue
            video = sum(
                sender.get("packets", 0)
                for sender in consumer.get("senders") or []
                if sender.get("codec", {}).get("codec_type") == "video"
            )
            packets[name] = (consumer.get("remote_addr"), video)
    return packets


def recover(path):
    source = request_json(f"{MEDIAMTX_API}/v3/config/paths/get/{path}")["source"]
    log(f"{path}: no video for {CHECK_SECONDS}s, reconnecting the camera")
    set_source(path, DETACHED_SOURCE)
    try:
        time.sleep(DETACH_SECONDS)
    finally:
        set_source(path, source)


def restore_detached_paths():
    """Undo a detach interrupted by a restart of this watchdog."""
    paths = request_json(f"{MEDIAMTX_API}/v3/config/paths/list")["items"]
    for path in paths:
        if path.get("source") == DETACHED_SOURCE:
            source = f"rtsp://go2rtc:8554/{path['name']}?video&audio=aac"
            log(f"{path['name']}: restoring source after an interrupted reconnect")
            set_source(path["name"], source)


def main():
    log(f"watching recordings every {CHECK_SECONDS}s")
    previous = {}
    last_recovery = {}
    restored = False
    while True:
        time.sleep(CHECK_SECONDS)
        try:
            if not restored:
                restore_detached_paths()
                restored = True
            current = recorder_video_packets()
            for path, (connection, packets) in current.items():
                before = previous.get(path)
                stalled = before is not None and before == (connection, packets)
                cooling_down = (
                    time.monotonic() - last_recovery.get(path, float("-inf"))
                    < RECOVERY_COOLDOWN_SECONDS
                )
                if stalled and not cooling_down:
                    recover(path)
                    last_recovery[path] = time.monotonic()
                    current.pop(path, None)
                    break
            previous = current
        except Exception as error:  # Keep watching through transient API errors.
            log(f"check failed: {error!r}")


if __name__ == "__main__":
    main()

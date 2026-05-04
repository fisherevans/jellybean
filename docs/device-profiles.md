# Device profiles + PlaybackInfo flow

How M-AT decides what stream URL to hand the kid TV.

## What problem this solves

M5 closed with a documented decoder hang on cheap Android TV WebViews
when Jellyfin transcoded video at 1080p H.264 above ~4 Mbps, or when
the source needed heavy server-side transcoding (DTS 5.1 + MKV - the
Big Hero 6 canonical case). The pre-M-AT path bypassed Jellyfin's
source negotiation entirely and just appended codec hints to a
hand-built `master.m3u8` URL, so Jellyfin had no idea what the device
could actually decode.

M-AT replaces that with Jellyfin's `POST /Items/{itemId}/PlaybackInfo`
flow: the server hands Jellyfin a `DeviceProfile` describing what the
kid TV can render, and Jellyfin returns a per-source verdict
(DirectPlay / DirectStream / Transcode) plus the URL it would generate
for the chosen path.

## Architecture

```
[Kid TV] -- GET /api/kids/items/:id/stream?maxBitrate=N --> [Jellybean]
                                                               |
                                                               | POST /Items/:id/PlaybackInfo
                                                               | body: { DeviceProfile, MaxStreamingBitrate, ... }
                                                               v
                                                          [Jellyfin]
                                                               |
                                                               | { MediaSources: [{TranscodingUrl, Supports*, ...}] }
                                                               v
                                                          [Jellybean] picks best path
                                                               |
                                                               v
                                       <-- { streamUrl, playbackPath, ... } --
[Kid TV] loads streamUrl in hls.js
```

## Where the state lives

Per-device tuning is **client-side**. The kid TV tracks its own stutter
history in `localStorage` (`jellybean.kids.maxBitrateBps`) and tells
the server "use at most N bps for me" via `?maxBitrate=N` on every
stream call. The server clamps that down further if it's below the
profile cap, but never up.

The server holds zero per-device state. No tables. No admin "device
management" page. This was a deliberate simplification: in a 3-4-TV
home setup, the admin observability wasn't worth the table + endpoint
+ UI burden when the answer to "why is this TV stuttering" comes from
the kid's complaint, not a dashboard.

If a TV needs an exception (e.g. force a 1.5 Mbps cap permanently),
that's a future client-side override - either a hidden admin URL that
writes the localStorage key, or an adult-menu setting in M9. No server
state required.

## The embedded Conservative profile

`internal/server/kids.go` defines `conservativeDeviceProfile`, a
hardcoded Jellyfin DeviceProfile JSON the server posts on every kids
stream request. It is intentionally narrow:

- **DirectPlayProfiles**: only `mp4 + h264 + aac`. Everything else
  transcodes.
- **TranscodingProfiles**: HLS / TS / h264 / AAC / 2 channels.
- **CodecProfiles**: h264 capped at level 4.1, max 1920x1080.
- **MaxStreamingBitrate**: 5 Mbps.

This is the safe floor for cheap Android TV WebViews. It deliberately
does not direct-play HEVC, MKV, or anything exotic - those paths
historically wedge the WebView decoder mid-stream.

Editing the profile means editing the Go const and rebuilding. The
DeviceProfile schema is owned by Jellyfin and documented at
<https://api.jellyfin.org/#tag/MediaInfo/operation/GetPostedPlaybackInfo>.
Reasonable starting points for new sub-profiles (when we eventually
need them):

- A "Generic Android TV" profile with HEVC + MKV direct-play and 10 Mbps cap.
- A "Browser" profile with VP9 + WebM direct-play.

For now, Conservative covers every case we have. If we need a second
profile, this is where we add it; we'd also need a way for the client
to ask for it (e.g. `?profile=android-tv` query param).

## The stutter fallback ladder

`web/kids/src/Play.tsx` runs a small state machine on top of the
`<video>` element's `waiting` events:

1. Track a rolling 60-second window of `waiting` event timestamps.
2. If the count reaches 4 within the window, declare the stream broken.
3. Re-fetch `/api/kids/items/:id/stream?maxBitrate=N` at the next
   rung: 3 Mbps, then 1.5 Mbps. A third trip exits to the error
   screen ("This video keeps stalling").
4. Each fallback preserves `currentTime` via `fallbackResumeTimeRef`,
   so the kid resumes where they stalled instead of restarting.
5. After 2 uninterrupted minutes at a fallback rung, persist the rung
   to `localStorage`. The next stream call (this session or next)
   pre-clamps without re-discovering.

Any new stall during the success-learn window cancels the timer. The
ceiling only persists when the rung is truly working.

## Recovery from a bad ceiling

If localStorage gets stuck at a too-low ceiling (e.g. one bad night
poisoned the value), the recovery paths are:

- **Clear browser data** in the kid TV WebView. Wipes localStorage.
- **Open `chrome://inspect`** on the dev machine, attach to the
  WebView, and run `localStorage.removeItem('jellybean.kids.maxBitrateBps')`
  in the console.
- **Reinstall the APK**. WebView storage gets cleared.
- A future M9 adult-menu setting will expose "reset bitrate ceiling"
  as a UI toggle.

## Why not just use Jellyfin's built-in DeviceProfile detection?

Jellyfin will infer a DeviceProfile from the User-Agent if you don't
supply one, but the inference is generous - it'll happily say a cheap
Android TV WebView can DirectPlay HEVC just because Chromium claims to.
The whole point of M-AT is that we override this with a known-narrow
profile that matches the actual decode reality on the kid TVs we care
about, not what the WebView claims.

## Why not put DeviceProfile + ceiling in SQLite?

We considered a `device_profiles` catalog + per-device
`device_overrides` table during M-AT scoping, with an admin
`/admin/devices` UI. Dropped because:

- 3-4 TVs in a home setup. Admin observability isn't load-bearing.
- The per-device ceiling is a property the device knows best (it's the
  one that actually stalled).
- The DeviceProfile JSON can ship with the binary - it's config data,
  not curation data.
- Removing the table cuts ~250 LOC of server state + an admin page we'd
  have to keep up to date for no kid-facing benefit.

If a future deployment proves we need the catalog (e.g. selling to
households with diverse TVs), reintroducing it is an additive change.

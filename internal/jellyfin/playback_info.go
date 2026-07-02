package jellyfin

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

// PostPlaybackInfo wraps Jellyfin's POST /Items/{itemId}/PlaybackInfo
// flow. The server hands Jellyfin a DeviceProfile (capabilities of the
// kid TV) and gets back per-source playback decisions: direct-play /
// direct-stream / transcode, plus the URL Jellyfin would generate for
// the chosen path.
//
// We use this instead of the hand-rolled `master.m3u8?VideoCodec=h264&...`
// from the M5 era so cheap TV WebViews don't get fed a stream their
// decoder can't handle. See docs/device-profiles.md for the profile
// catalog model.

// PlaybackInfoRequest is the body Jellyfin expects on
// POST /Items/{itemId}/PlaybackInfo.
//
// DeviceProfile is opaque JSON owned by Jellyfin's schema; we pass the
// catalog's profile body through unchanged via json.RawMessage so the
// admin can author profiles without us having to track Jellyfin's full
// type tree.
type PlaybackInfoRequest struct {
	UserID              string          `json:"UserId,omitempty"`
	MaxStreamingBitrate int64           `json:"MaxStreamingBitrate,omitempty"`
	StartTimeTicks      int64           `json:"StartTimeTicks,omitempty"`
	AudioStreamIndex    int             `json:"AudioStreamIndex,omitempty"`
	SubtitleStreamIndex int             `json:"SubtitleStreamIndex,omitempty"`
	AutoOpenLiveStream  bool            `json:"AutoOpenLiveStream"`
	EnableTranscoding   bool            `json:"EnableTranscoding"`
	AllowVideoStreamCopy bool           `json:"AllowVideoStreamCopy"`
	AllowAudioStreamCopy bool           `json:"AllowAudioStreamCopy"`
	IsPlayback          bool            `json:"IsPlayback"`
	DeviceProfile       json.RawMessage `json:"DeviceProfile"`
}

// PlaybackInfoResponse is Jellyfin's negotiated answer.
type PlaybackInfoResponse struct {
	MediaSources  []MediaSourceInfo `json:"MediaSources"`
	PlaySessionID string            `json:"PlaySessionId"`
	ErrorCode     string            `json:"ErrorCode,omitempty"`
}

// MediaSourceInfo is one playable source for the item. Most items have
// exactly one; multi-version items (alternate cuts, extras) have more.
type MediaSourceInfo struct {
	ID                     string `json:"Id"`
	Name                   string `json:"Name"`
	Container              string `json:"Container"`
	Path                   string `json:"Path"`
	Protocol               string `json:"Protocol"`
	SupportsDirectPlay     bool   `json:"SupportsDirectPlay"`
	SupportsDirectStream   bool   `json:"SupportsDirectStream"`
	SupportsTranscoding    bool   `json:"SupportsTranscoding"`
	TranscodingURL         string `json:"TranscodingUrl,omitempty"`
	TranscodingSubProtocol string `json:"TranscodingSubProtocol,omitempty"`
	DirectStreamURL        string `json:"DirectStreamUrl,omitempty"`
	Bitrate                int64  `json:"Bitrate,omitempty"`
	VideoCodec             string `json:"VideoCodec,omitempty"`
	AudioCodec             string `json:"AudioCodec,omitempty"`
}

// PlaybackPath is the negotiated decision Jellyfin made for this
// (item, profile) pair. Surfaced to the caller for logging.
type PlaybackPath string

const (
	PlaybackDirectPlay   PlaybackPath = "DirectPlay"
	PlaybackDirectStream PlaybackPath = "DirectStream"
	PlaybackTranscode    PlaybackPath = "Transcode"
)

// PlaybackResolution is the stream URL plus context the kids handler
// needs to log + report.
type PlaybackResolution struct {
	StreamURL     string
	MediaSourceID string
	Path          PlaybackPath
	PlaySessionID string
	ProfileName   string // populated by the caller for the log line
}

// PostPlaybackInfo runs the negotiation. AudioStreamIndex 0 is omitted
// (let Jellyfin pick), positive values force a specific track.
//
// startTimeTicks > 0 tells Jellyfin to transcode starting at that
// offset; the returned URL's segment 0 then represents the resume
// position rather than t=0 of the source. Critical for the M-AT
// fallback path: a fresh transcode session has no segments at an
// arbitrary seek target, so client-side video.currentTime = T after
// fallback would buffer forever waiting for content the transcoder
// never produced. Pass the resume offset here instead.
//
// Returns ErrNotFound when Jellyfin has no playable source for the
// requested DeviceProfile (e.g. all sources exceed the profile's
// constraints and EnableTranscoding doesn't help). Caller surfaces
// "can't play this on this TV" to the kid client.
func (c *Client) PostPlaybackInfo(
	ctx context.Context,
	itemID string,
	userID string,
	userToken string,
	deviceProfileJSON json.RawMessage,
	maxStreamingBitrate int64,
	audioStreamIndex int,
	startTimeTicks int64,
) (*PlaybackResolution, error) {
	if itemID == "" {
		return nil, fmt.Errorf("itemID required")
	}
	if len(deviceProfileJSON) == 0 {
		return nil, fmt.Errorf("device profile required")
	}

	body := PlaybackInfoRequest{
		UserID:               userID,
		MaxStreamingBitrate:  maxStreamingBitrate,
		StartTimeTicks:       startTimeTicks,
		AutoOpenLiveStream:   true,
		EnableTranscoding:    true,
		AllowVideoStreamCopy: true,
		AllowAudioStreamCopy: true,
		IsPlayback:           true,
		DeviceProfile:        deviceProfileJSON,
	}
	if audioStreamIndex > 0 {
		body.AudioStreamIndex = audioStreamIndex
	}
	raw, err := json.Marshal(body)
	if err != nil {
		return nil, fmt.Errorf("encode playback info request: %w", err)
	}

	q := url.Values{}
	if userID != "" {
		q.Set("UserId", userID)
	}
	if maxStreamingBitrate > 0 {
		q.Set("MaxStreamingBitrate", strconv.FormatInt(maxStreamingBitrate, 10))
	}
	if startTimeTicks > 0 {
		q.Set("StartTimeTicks", strconv.FormatInt(startTimeTicks, 10))
	}
	q.Set("AutoOpenLiveStream", "true")

	path := "/Items/" + url.PathEscape(itemID) + "/PlaybackInfo"
	if encoded := q.Encode(); encoded != "" {
		path += "?" + encoded
	}

	req, err := c.newRequestWithToken(ctx, http.MethodPost, path, bytes.NewReader(raw), userToken)
	if err != nil {
		return nil, err
	}
	var resp PlaybackInfoResponse
	if err := c.do(req, &resp); err != nil {
		return nil, fmt.Errorf("playback info: %w", err)
	}
	if len(resp.MediaSources) == 0 {
		return nil, ErrNotFound
	}
	src := pickPlayableSource(resp.MediaSources)
	if src == nil {
		return nil, ErrNotFound
	}

	pathChoice, streamURL := c.resolvePlaybackURL(itemID, *src, userToken, audioStreamIndex)
	if streamURL == "" {
		return nil, ErrNotFound
	}
	return &PlaybackResolution{
		StreamURL:     streamURL,
		MediaSourceID: src.ID,
		Path:          pathChoice,
		PlaySessionID: resp.PlaySessionID,
	}, nil
}

// pickPlayableSource scans MediaSources for the best playback path.
// Priority: DirectPlay > DirectStream > Transcoding. Returns nil only
// if every source has no supported path at all.
func pickPlayableSource(sources []MediaSourceInfo) *MediaSourceInfo {
	for i := range sources {
		if sources[i].SupportsDirectPlay {
			return &sources[i]
		}
	}
	for i := range sources {
		if sources[i].SupportsDirectStream {
			return &sources[i]
		}
	}
	for i := range sources {
		if sources[i].SupportsTranscoding && sources[i].TranscodingURL != "" {
			return &sources[i]
		}
	}
	return nil
}

// resolvePlaybackURL turns a chosen MediaSource into a fully-qualified
// URL the kid client can load. We always emit an HLS URL because the
// kid player wraps hls.js — even on DirectPlay-eligible sources we
// route through master.m3u8 so the player handles the manifest the
// same way every time. Jellyfin will direct-stream (no transcoding)
// when the source already satisfies the device profile, so the wrap
// is essentially free.
//
// Returns the resolved path (DirectPlay / DirectStream / Transcode)
// and the absolute URL. Empty URL means we couldn't construct one.
func (c *Client) resolvePlaybackURL(itemID string, src MediaSourceInfo, userToken string, audioStreamIndex int) (PlaybackPath, string) {
	switch {
	case src.SupportsDirectPlay:
		return PlaybackDirectPlay, c.hlsURL(itemID, src.ID, userToken, audioStreamIndex)
	case src.SupportsDirectStream:
		return PlaybackDirectStream, c.hlsURL(itemID, src.ID, userToken, audioStreamIndex)
	case src.SupportsTranscoding && src.TranscodingURL != "":
		// Jellyfin returns an absolute path; prefix with our base URL.
		// Token + DeviceId are already embedded by Jellyfin.
		u := src.TranscodingURL
		if !strings.HasPrefix(u, "http") {
			u = c.publicURL + u
		}
		// TranscodingUrl already carries api_key when the request was
		// authenticated; we leave it alone. Some flows omit it though,
		// in which case the kid client falls back to the cookie/header
		// auth on the request.
		return PlaybackTranscode, u
	}
	return "", ""
}

// hlsURL builds the master.m3u8 URL Jellyfin uses for HLS streaming.
// Used for DirectPlay + DirectStream paths (Jellyfin won't transcode
// when the source already satisfies the profile, so the URL just
// drives the segment splitter).
//
// We deliberately do NOT pass VideoCodec/AudioCodec/MaxStreamingBitrate
// here - those are already negotiated via the DeviceProfile that was
// sent to PlaybackInfo, so duplicating them here would double-cap.
func (c *Client) hlsURL(itemID, mediaSourceID, userToken string, audioStreamIndex int) string {
	q := url.Values{}
	q.Set("MediaSourceId", mediaSourceID)
	if audioStreamIndex > 0 {
		q.Set("AudioStreamIndex", strconv.Itoa(audioStreamIndex))
	}
	if userToken != "" {
		q.Set("api_key", userToken)
	} else if c.apiKey != "" {
		q.Set("api_key", c.apiKey)
	}
	return fmt.Sprintf("%s/Videos/%s/master.m3u8?%s", c.publicURL, url.PathEscape(itemID), q.Encode())
}

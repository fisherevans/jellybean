package jellyfin

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
)

// Playback reporting requests on Jellyfin's PlaystateApi. All three calls
// require a per-user token so Jellyfin attributes the playback session to
// the right account; pass an empty token to skip the call (admin path or
// missing kid token; the caller logs and continues).

// PlaybackStartInfo is the body of POST /Sessions/Playing.
//
// PlaySessionID is required when the playback was negotiated through
// PostPlaybackInfo (M-AT flow). Jellyfin uses it to match the report
// to the active transcode session; reports without it can be rejected
// (often as 401, confusingly) when an active session exists.
type PlaybackStartInfo struct {
	ItemID           string `json:"ItemId"`
	MediaSourceID    string `json:"MediaSourceId,omitempty"`
	PlaySessionID    string `json:"PlaySessionId,omitempty"`
	PlayMethod       string `json:"PlayMethod,omitempty"`
	PositionTicks    int64  `json:"PositionTicks"`
	IsPaused         bool   `json:"IsPaused"`
	CanSeek          bool   `json:"CanSeek"`
	AudioStreamIndex int    `json:"AudioStreamIndex,omitempty"`
}

// PlaybackProgressInfo is the body of POST /Sessions/Playing/Progress.
type PlaybackProgressInfo struct {
	ItemID           string `json:"ItemId"`
	MediaSourceID    string `json:"MediaSourceId,omitempty"`
	PlaySessionID    string `json:"PlaySessionId,omitempty"`
	PlayMethod       string `json:"PlayMethod,omitempty"`
	PositionTicks    int64  `json:"PositionTicks"`
	IsPaused         bool   `json:"IsPaused"`
	AudioStreamIndex int    `json:"AudioStreamIndex,omitempty"`
}

// PlaybackStopInfo is the body of POST /Sessions/Playing/Stopped.
type PlaybackStopInfo struct {
	ItemID        string `json:"ItemId"`
	MediaSourceID string `json:"MediaSourceId,omitempty"`
	PlaySessionID string `json:"PlaySessionId,omitempty"`
	PositionTicks int64  `json:"PositionTicks"`
}

// ReportPlaybackStart fires once at the start of playback. Empty userToken
// short-circuits to a no-op (returns nil) so the caller doesn't have to
// special-case admin / env-var paths.
func (c *Client) ReportPlaybackStart(ctx context.Context, userToken string, info PlaybackStartInfo) error {
	if userToken == "" {
		return nil
	}
	if info.PlayMethod == "" {
		info.PlayMethod = "DirectStream"
	}
	if info.AudioStreamIndex == 0 {
		info.AudioStreamIndex = 1 // skip the "no audio" stream-0 placeholder
	}
	return c.postPlayback(ctx, "/Sessions/Playing", userToken, info)
}

// ReportPlaybackProgress fires every few seconds while the player is
// playing or paused.
func (c *Client) ReportPlaybackProgress(ctx context.Context, userToken string, info PlaybackProgressInfo) error {
	if userToken == "" {
		return nil
	}
	if info.PlayMethod == "" {
		info.PlayMethod = "DirectStream"
	}
	if info.AudioStreamIndex == 0 {
		info.AudioStreamIndex = 1
	}
	return c.postPlayback(ctx, "/Sessions/Playing/Progress", userToken, info)
}

// SetPlayedState marks a single item as played or unplayed for the
// authenticated user. Used by the M9 override "Mark Watched /
// Unwatched" actions. Empty userToken / userID short-circuits to a
// no-op (returns nil) to keep the override path uniform with the
// progress reporters.
func (c *Client) SetPlayedState(ctx context.Context, userToken, userID, itemID string, played bool) error {
	if userToken == "" || userID == "" || itemID == "" {
		return nil
	}
	method := http.MethodPost
	if !played {
		method = http.MethodDelete
	}
	path := "/Users/" + userID + "/PlayedItems/" + itemID
	req, err := c.newRequestWithToken(ctx, method, path, nil, userToken)
	if err != nil {
		return err
	}
	if err := c.do(req, nil); err != nil {
		return fmt.Errorf("set played state: %w", err)
	}
	return nil
}

// ReportPlaybackStopped fires when the player closes / video ends. Carries
// the final position so Jellyfin's resume tracking sees a clean end state.
func (c *Client) ReportPlaybackStopped(ctx context.Context, userToken string, info PlaybackStopInfo) error {
	if userToken == "" {
		return nil
	}
	return c.postPlayback(ctx, "/Sessions/Playing/Stopped", userToken, info)
}

func (c *Client) postPlayback(ctx context.Context, path, userToken string, payload any) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	req, err := c.newRequestWithToken(ctx, http.MethodPost, path, bytes.NewReader(body), userToken)
	if err != nil {
		return err
	}
	if err := c.do(req, nil); err != nil {
		return fmt.Errorf("playback %s: %w", path, err)
	}
	return nil
}

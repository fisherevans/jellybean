package jellyfin

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

// GetItems lists items matching the filter. Service-account scoped (uses the
// configured API key).
func (c *Client) GetItems(ctx context.Context, f ItemsFilter) (*ItemsResult, error) {
	q := url.Values{}
	if len(f.IncludeItemTypes) > 0 {
		q.Set("IncludeItemTypes", strings.Join(f.IncludeItemTypes, ","))
	}
	if f.Recursive {
		q.Set("Recursive", "true")
	}
	if f.Limit > 0 {
		q.Set("Limit", strconv.Itoa(f.Limit))
	}
	if f.StartIndex > 0 {
		q.Set("StartIndex", strconv.Itoa(f.StartIndex))
	}
	if f.SortBy != "" {
		q.Set("SortBy", f.SortBy)
	}
	if f.SortOrder != "" {
		q.Set("SortOrder", f.SortOrder)
	}
	if f.SearchTerm != "" {
		q.Set("SearchTerm", f.SearchTerm)
	}
	q.Set("Fields", "Genres,Studios,OfficialRating,ProductionYear")

	path := "/Items"
	if encoded := q.Encode(); encoded != "" {
		path += "?" + encoded
	}
	req, err := c.newRequest(ctx, http.MethodGet, path, nil)
	if err != nil {
		return nil, err
	}
	var out ItemsResult
	if err := c.do(req, &out); err != nil {
		return nil, fmt.Errorf("get items: %w", err)
	}
	return &out, nil
}

// GetItem fetches a single item by ID.
//
// Implementation note: Jellyfin's `GET /Items/{id}` requires a user context
// (returns 400 without it). We use `GET /Items?ids={id}&Recursive=true`
// instead, which works under the service-account key, and unwrap the first
// result. Returns ErrNotFound if no item matches.
func (c *Client) GetItem(ctx context.Context, id string) (*Item, error) {
	if id == "" {
		return nil, fmt.Errorf("item id required")
	}
	q := url.Values{}
	q.Set("ids", id)
	q.Set("Recursive", "true")
	q.Set("Fields", "Genres,Studios,OfficialRating,ProductionYear")
	req, err := c.newRequest(ctx, http.MethodGet, "/Items?"+q.Encode(), nil)
	if err != nil {
		return nil, err
	}
	var out ItemsResult
	if err := c.do(req, &out); err != nil {
		return nil, fmt.Errorf("get item %s: %w", id, err)
	}
	if len(out.Items) == 0 {
		return nil, ErrNotFound
	}
	return &out.Items[0], nil
}

// StreamURL returns an HLS manifest URL the client can hand to <video>
// (Safari) or hls.js (Chrome / Firefox). userToken is used for per-user
// playback attribution; pass empty to fall back to the configured service-
// account key.
//
// Why HLS rather than a single transcoded MP4: an on-the-fly MP4 transcode
// does not include full-duration metadata at the start, so the browser
// can't seek beyond what the server has produced. HLS exposes the real
// duration and indexes the file as segments, so seeking anywhere is just
// "fetch the segment that covers timestamp T." The frontend uses hls.js
// when the browser doesn't support HLS natively.
//
// Codec hints (h264 / aac / mp3 / 2 channels) keep transcoding cheap and
// browser-friendly. Jellyfin direct-plays when the source already
// satisfies them and transcodes otherwise.
func (c *Client) StreamURL(itemID, userToken string) string {
	q := url.Values{}
	// Jellyfin requires MediaSourceId on the HLS endpoint. For single-file
	// items it matches the item ID; multi-source items would need a
	// PlaybackInfo round-trip first. M2 will revisit that when curation
	// surfaces multi-version items.
	q.Set("MediaSourceId", itemID)
	q.Set("VideoCodec", "h264")
	q.Set("AudioCodec", "aac,mp3")
	q.Set("MaxAudioChannels", "2")
	if userToken != "" {
		q.Set("api_key", userToken)
	} else if c.apiKey != "" {
		q.Set("api_key", c.apiKey)
	}
	return fmt.Sprintf("%s/Videos/%s/master.m3u8?%s", c.baseURL, url.PathEscape(itemID), q.Encode())
}

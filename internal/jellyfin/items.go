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
	return c.getItemsWith(ctx, f, "")
}

// GetItemsAsUser is the per-user variant. Authenticates with the supplied
// user token so Jellyfin's response carries that user's UserData (resume
// position, watched flag, play count). Pass empty userToken to get the
// service-account behavior of GetItems.
func (c *Client) GetItemsAsUser(ctx context.Context, f ItemsFilter, userToken string) (*ItemsResult, error) {
	return c.getItemsWith(ctx, f, userToken)
}

func (c *Client) getItemsWith(ctx context.Context, f ItemsFilter, userToken string) (*ItemsResult, error) {
	q := url.Values{}
	if len(f.IncludeItemTypes) > 0 {
		q.Set("IncludeItemTypes", strings.Join(f.IncludeItemTypes, ","))
	}
	if len(f.IDs) > 0 {
		q.Set("Ids", strings.Join(f.IDs, ","))
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
	// Always ask for the metadata fields we use; UserData only meaningful
	// when authenticated as a user.
	fields := "Genres,Studios,OfficialRating,ProductionYear,RunTimeTicks"
	if userToken != "" {
		fields += ",UserData"
	}
	q.Set("Fields", fields)

	path := "/Items"
	if encoded := q.Encode(); encoded != "" {
		path += "?" + encoded
	}
	req, err := c.newRequestWithToken(ctx, http.MethodGet, path, nil, userToken)
	if err != nil {
		return nil, err
	}
	var out ItemsResult
	if err := c.do(req, &out); err != nil {
		return nil, fmt.Errorf("get items: %w", err)
	}
	return &out, nil
}

// GetResumeItems returns items the user has started but not finished,
// newest activity first. Used for the kid client's "Continue Watching"
// row.
func (c *Client) GetResumeItems(ctx context.Context, userID, userToken string, limit int) (*ItemsResult, error) {
	if userID == "" {
		return nil, fmt.Errorf("userID required")
	}
	if limit <= 0 {
		limit = 20
	}
	q := url.Values{}
	q.Set("Limit", strconv.Itoa(limit))
	q.Set("Fields", "Genres,Studios,OfficialRating,ProductionYear,RunTimeTicks,UserData")
	q.Set("MediaTypes", "Video")
	path := "/Users/" + url.PathEscape(userID) + "/Items/Resume?" + q.Encode()

	req, err := c.newRequestWithToken(ctx, http.MethodGet, path, nil, userToken)
	if err != nil {
		return nil, err
	}
	var out ItemsResult
	if err := c.do(req, &out); err != nil {
		return nil, fmt.Errorf("get resume items: %w", err)
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

// GetNextUp returns the next-up episode for a series for the given user.
// Jellyfin's behavior: a partially-watched episode counts as "next" until
// it's marked played; otherwise the first unwatched episode (lowest season
// then episode index). Falls back to the first episode if nothing has been
// watched. Returns ErrNotFound if Jellyfin returns an empty list.
//
// Per-user token is required so the resume position + watched-set are
// the kid's, not the service account's.
func (c *Client) GetNextUp(ctx context.Context, seriesID, userID, userToken string) (*Item, error) {
	if seriesID == "" {
		return nil, fmt.Errorf("series id required")
	}
	if userID == "" || userToken == "" {
		return nil, fmt.Errorf("per-user credentials required for next-up")
	}
	q := url.Values{}
	q.Set("SeriesId", seriesID)
	q.Set("UserId", userID)
	q.Set("Limit", "1")
	q.Set("Fields", "Genres,OfficialRating,ProductionYear,RunTimeTicks,UserData")
	req, err := c.newRequestWithToken(ctx, http.MethodGet, "/Shows/NextUp?"+q.Encode(), nil, userToken)
	if err != nil {
		return nil, err
	}
	var out ItemsResult
	if err := c.do(req, &out); err != nil {
		return nil, fmt.Errorf("get next up: %w", err)
	}
	if len(out.Items) > 0 {
		return &out.Items[0], nil
	}
	// Fallback: first episode, season 1, of the series.
	q2 := url.Values{}
	q2.Set("ParentId", seriesID)
	q2.Set("UserId", userID)
	q2.Set("IncludeItemTypes", "Episode")
	q2.Set("Recursive", "true")
	q2.Set("SortBy", "ParentIndexNumber,IndexNumber")
	q2.Set("SortOrder", "Ascending")
	q2.Set("Limit", "1")
	q2.Set("Fields", "Genres,OfficialRating,ProductionYear,RunTimeTicks,UserData")
	req2, err := c.newRequestWithToken(ctx, http.MethodGet, "/Items?"+q2.Encode(), nil, userToken)
	if err != nil {
		return nil, err
	}
	var fallback ItemsResult
	if err := c.do(req2, &fallback); err != nil {
		return nil, fmt.Errorf("get series first episode: %w", err)
	}
	if len(fallback.Items) == 0 {
		return nil, ErrNotFound
	}
	return &fallback.Items[0], nil
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

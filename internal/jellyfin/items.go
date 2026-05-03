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
func (c *Client) GetItem(ctx context.Context, id string) (*Item, error) {
	if id == "" {
		return nil, fmt.Errorf("item id required")
	}
	req, err := c.newRequest(ctx, http.MethodGet, "/Items/"+url.PathEscape(id)+"?Fields=Genres,Studios,OfficialRating,ProductionYear", nil)
	if err != nil {
		return nil, err
	}
	var out Item
	if err := c.do(req, &out); err != nil {
		return nil, fmt.Errorf("get item %s: %w", id, err)
	}
	return &out, nil
}

// StreamURL returns a direct-play URL the client can hand to <video>. The
// caller's userToken is used so Jellyfin's playback tracking attributes the
// session to the right user. Pass an empty token to use the service account
// (only useful for tests / debug; real playback should always use a user
// token so progress tracking works).
//
// Direct play only: this skips Jellyfin's transcoding negotiation. If a file
// won't direct-play, the <video> element will fail to load and we surface
// that to the user. Real transcoding negotiation is a later concern.
func (c *Client) StreamURL(itemID, userToken string) string {
	q := url.Values{}
	q.Set("static", "true")
	if userToken != "" {
		q.Set("api_key", userToken)
	} else if c.apiKey != "" {
		q.Set("api_key", c.apiKey)
	}
	return fmt.Sprintf("%s/Videos/%s/stream?%s", c.baseURL, url.PathEscape(itemID), q.Encode())
}

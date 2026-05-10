package jellyfin

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
)

// StopActiveEncodings tells Jellyfin to release the transcode session
// identified by playSessionID. Mirrors `apiClient.stopActiveEncodings`
// in jellyfin-web's playbackmanager (called before a stream swap so the
// previous transcode is shut down before the new one starts).
//
// Without this, every Next-episode press leaves an old ffmpeg process
// running on the Jellyfin host until it times out internally; on a
// constrained server those accumulate and starve subsequent transcodes.
//
// Jellyfin's `DELETE /Videos/ActiveEncodings` requires `deviceId` as a
// query parameter (separate from the Authorization header's DeviceId)
// and rejects the request with 400 "deviceId field is required"
// otherwise. The deviceID is pulled from the per-request context
// (stamped via WithDeviceID upstream); empty falls back to the
// service-account identity so admin callers stay functional.
//
// Empty playSessionID is a no-op (returns nil) so callers don't have to
// special-case "no previous session" - matches the semantics of the
// other Report* helpers in this package.
func (c *Client) StopActiveEncodings(ctx context.Context, userToken, playSessionID string) error {
	if playSessionID == "" {
		return nil
	}
	deviceID, _ := ctx.Value(deviceIDKey{}).(string)
	if deviceID == "" {
		deviceID = "jellybean-server"
	}
	q := url.Values{}
	q.Set("playSessionId", playSessionID)
	q.Set("deviceId", deviceID)
	path := "/Videos/ActiveEncodings?" + q.Encode()
	req, err := c.newRequestWithToken(ctx, http.MethodDelete, path, nil, userToken)
	if err != nil {
		return err
	}
	if err := c.do(req, nil); err != nil {
		return fmt.Errorf("stop active encodings: %w", err)
	}
	return nil
}

package jellyfin

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestPostPlaybackInfoDirectPlay(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/Items/") || !strings.HasSuffix(r.URL.Path, "/PlaybackInfo") {
			t.Errorf("unexpected path %s", r.URL.Path)
		}
		body, _ := io.ReadAll(r.Body)
		var req PlaybackInfoRequest
		if err := json.Unmarshal(body, &req); err != nil {
			t.Fatalf("decode body: %v", err)
		}
		if string(req.DeviceProfile) == "" {
			t.Error("DeviceProfile not forwarded")
		}
		if req.MaxStreamingBitrate != 5000000 {
			t.Errorf("MaxStreamingBitrate = %d", req.MaxStreamingBitrate)
		}
		json.NewEncoder(w).Encode(PlaybackInfoResponse{
			PlaySessionID: "abc",
			MediaSources: []MediaSourceInfo{{
				ID:                 "src-1",
				Container:          "mp4",
				SupportsDirectPlay: true,
			}},
		})
	}))
	defer srv.Close()

	c := New(srv.URL, "service-key")
	res, err := c.PostPlaybackInfo(context.Background(), "movie-1", "user-1", "user-token",
		json.RawMessage(`{"Name":"Test","MaxStreamingBitrate":5000000}`),
		5000000, 0, 0)
	if err != nil {
		t.Fatalf("PostPlaybackInfo: %v", err)
	}
	if res.Path != PlaybackDirectPlay {
		t.Errorf("Path = %v, want DirectPlay", res.Path)
	}
	if res.MediaSourceID != "src-1" {
		t.Errorf("MediaSourceID = %q", res.MediaSourceID)
	}
	if !strings.Contains(res.StreamURL, "/Videos/movie-1/master.m3u8") {
		t.Errorf("StreamURL = %q", res.StreamURL)
	}
	if !strings.Contains(res.StreamURL, "MediaSourceId=src-1") {
		t.Errorf("StreamURL missing MediaSourceId: %q", res.StreamURL)
	}
	if !strings.Contains(res.StreamURL, "api_key=user-token") {
		t.Errorf("StreamURL missing api_key: %q", res.StreamURL)
	}
}

func TestPostPlaybackInfoTranscode(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(PlaybackInfoResponse{
			PlaySessionID: "ses-1",
			MediaSources: []MediaSourceInfo{{
				ID:                  "src-tx",
				SupportsTranscoding: true,
				TranscodingURL:      "/videos/foo/master.m3u8?DeviceId=tv&PlaySessionId=ses-1",
			}},
		})
	}))
	defer srv.Close()

	c := New(srv.URL, "service-key")
	res, err := c.PostPlaybackInfo(context.Background(), "movie-1", "user-1", "user-token",
		json.RawMessage(`{"Name":"Test"}`), 0, 0, 0)
	if err != nil {
		t.Fatalf("PostPlaybackInfo: %v", err)
	}
	if res.Path != PlaybackTranscode {
		t.Errorf("Path = %v, want Transcode", res.Path)
	}
	if !strings.HasPrefix(res.StreamURL, srv.URL+"/videos/foo/master.m3u8") {
		t.Errorf("StreamURL = %q", res.StreamURL)
	}
}

func TestPostPlaybackInfoNoSource(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(PlaybackInfoResponse{
			MediaSources: []MediaSourceInfo{},
		})
	}))
	defer srv.Close()

	c := New(srv.URL, "service-key")
	_, err := c.PostPlaybackInfo(context.Background(), "movie-1", "user-1", "user-token",
		json.RawMessage(`{"Name":"Test"}`), 0, 0, 0)
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("want ErrNotFound, got %v", err)
	}
}

func TestPickPlayableSourcePriority(t *testing.T) {
	tests := []struct {
		name string
		in   []MediaSourceInfo
		want string // expected source ID; "" = nil
	}{
		{
			name: "direct play wins over transcode",
			in: []MediaSourceInfo{
				{ID: "tx", SupportsTranscoding: true, TranscodingURL: "/x"},
				{ID: "dp", SupportsDirectPlay: true},
			},
			want: "dp",
		},
		{
			name: "direct stream beats transcode",
			in: []MediaSourceInfo{
				{ID: "tx", SupportsTranscoding: true, TranscodingURL: "/x"},
				{ID: "ds", SupportsDirectStream: true},
			},
			want: "ds",
		},
		{
			name: "transcode wins when nothing else",
			in: []MediaSourceInfo{
				{ID: "tx", SupportsTranscoding: true, TranscodingURL: "/x"},
			},
			want: "tx",
		},
		{
			name: "no playable source",
			in: []MediaSourceInfo{
				{ID: "broken"},
			},
			want: "",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := pickPlayableSource(tt.in)
			if tt.want == "" {
				if got != nil {
					t.Errorf("got %+v, want nil", got)
				}
				return
			}
			if got == nil {
				t.Fatalf("got nil, want id %q", tt.want)
			}
			if got.ID != tt.want {
				t.Errorf("got %q, want %q", got.ID, tt.want)
			}
		})
	}
}

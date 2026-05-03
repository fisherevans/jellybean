package jellyfin

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestGetItems(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/Items" {
			t.Errorf("path = %s", r.URL.Path)
		}
		q := r.URL.Query()
		if got := q.Get("IncludeItemTypes"); got != "Movie,Series" {
			t.Errorf("IncludeItemTypes = %q", got)
		}
		if q.Get("Recursive") != "true" {
			t.Errorf("Recursive missing")
		}
		if q.Get("Limit") != "20" {
			t.Errorf("Limit = %q", q.Get("Limit"))
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(ItemsResult{
			Items: []Item{
				{ID: "1", Name: "Toy Story", Type: "Movie", OfficialRating: "G"},
				{ID: "2", Name: "The Matrix", Type: "Movie", OfficialRating: "R"},
			},
			TotalRecordCount: 2,
		})
	}))
	defer srv.Close()

	c := New(srv.URL, "key")
	res, err := c.GetItems(context.Background(), ItemsFilter{
		IncludeItemTypes: []string{"Movie", "Series"},
		Recursive:        true,
		Limit:            20,
	})
	if err != nil {
		t.Fatalf("GetItems: %v", err)
	}
	if res.TotalRecordCount != 2 || len(res.Items) != 2 {
		t.Fatalf("unexpected result: %+v", res)
	}
	if res.Items[0].Name != "Toy Story" {
		t.Errorf("Items[0].Name = %s", res.Items[0].Name)
	}
}

func TestGetItem(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/Items" {
			t.Errorf("path = %s, want /Items", r.URL.Path)
		}
		if got := r.URL.Query().Get("ids"); got != "abc" {
			t.Errorf("ids = %q, want abc", got)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(ItemsResult{
			Items: []Item{{ID: "abc", Name: "Test"}},
			TotalRecordCount: 1,
		})
	}))
	defer srv.Close()

	c := New(srv.URL, "key")
	item, err := c.GetItem(context.Background(), "abc")
	if err != nil {
		t.Fatalf("GetItem: %v", err)
	}
	if item.Name != "Test" {
		t.Errorf("Name = %s", item.Name)
	}
}

func TestGetItemNotFound(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Jellyfin returns an empty result rather than 404 when ids=<unknown>.
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(ItemsResult{Items: []Item{}, TotalRecordCount: 0})
	}))
	defer srv.Close()

	c := New(srv.URL, "key")
	_, err := c.GetItem(context.Background(), "abc")
	if !IsNotFound(err) {
		t.Errorf("expected ErrNotFound, got %v", err)
	}
}

func TestStreamURL(t *testing.T) {
	c := New("https://jellyfin.local", "service-key")
	url := c.StreamURL("item123", "user-token")
	if !strings.Contains(url, "/Videos/item123/master.m3u8") {
		t.Errorf("missing path: %s", url)
	}
	for _, want := range []string{"VideoCodec=h264", "AudioCodec=aac", "MaxAudioChannels=2", "api_key=user-token"} {
		if !strings.Contains(url, want) {
			t.Errorf("missing %s: %s", want, url)
		}
	}
}

func TestStreamURLFallsBackToServiceKey(t *testing.T) {
	c := New("https://jellyfin.local", "service-key")
	url := c.StreamURL("item123", "")
	if !strings.Contains(url, "api_key=service-key") {
		t.Errorf("expected fallback to service key: %s", url)
	}
}

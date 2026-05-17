package jellyfin

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
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

// TestGetItemsByIDsBatchedConcurrent verifies that GetItemsByIDsBatched
// runs chunks in parallel (so wall-time on a slow upstream like the
// Cloudflare tunnel doesn't grow linearly with chunk count) and that
// the merged output preserves input order regardless of which chunk's
// goroutine completes first.
func TestGetItemsByIDsBatchedConcurrent(t *testing.T) {
	const total = 250 // -> 3 chunks at IDBatchSize=100
	const handlerDelay = 100 * time.Millisecond

	var inFlight, peakInFlight atomic.Int32
	var mu sync.Mutex
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cur := inFlight.Add(1)
		// Track the peak using a CAS so we only ever ratchet up.
		for {
			peak := peakInFlight.Load()
			if cur <= peak || peakInFlight.CompareAndSwap(peak, cur) {
				break
			}
		}
		defer inFlight.Add(-1)

		time.Sleep(handlerDelay)

		ids := strings.Split(r.URL.Query().Get("Ids"), ",")
		items := make([]Item, 0, len(ids))
		for _, id := range ids {
			items = append(items, Item{ID: id, Name: "Item " + id})
		}
		mu.Lock()
		defer mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(ItemsResult{Items: items, TotalRecordCount: len(items)})
	}))
	defer srv.Close()

	ids := make([]string, total)
	for i := range ids {
		ids[i] = fmt.Sprintf("id-%03d", i)
	}

	c := New(srv.URL, "key")
	start := time.Now()
	out, err := c.GetItemsByIDsBatched(context.Background(), ids, "user-token")
	elapsed := time.Since(start)
	if err != nil {
		t.Fatalf("GetItemsByIDsBatched: %v", err)
	}

	// Order: ids -> items must be in input order.
	if len(out) != total {
		t.Fatalf("len(out) = %d, want %d", len(out), total)
	}
	for i, it := range out {
		if it.ID != ids[i] {
			t.Fatalf("out[%d].ID = %q, want %q", i, it.ID, ids[i])
		}
	}

	// Concurrency: 3 sequential chunks at 100ms each = 300ms+.
	// With at least 2 in flight, total should be < 250ms.
	if elapsed >= 250*time.Millisecond {
		t.Errorf("elapsed = %v, want < 250ms (chunks not concurrent)", elapsed)
	}
	if peak := peakInFlight.Load(); peak < 2 {
		t.Errorf("peak in-flight = %d, want >= 2", peak)
	}
}

// TestGetItemsFields pins the Fields query-param composition for both
// the slim default and the IncludeHeavyFields opt-in, and verifies
// UserData / ExtraFields stack on top of either base.
//
// Why pin this: the heavy-field trim is the whole point of the t52
// perf change. Regressing the default back to including MediaStreams
// would silently re-introduce the wire-weight bloat on every kid-side
// /Items round trip, and nothing else in the test suite would catch it.
func TestGetItemsFields(t *testing.T) {
	tests := []struct {
		name          string
		filter        ItemsFilter
		userToken     string
		wantHas       []string
		wantHasNot    []string
	}{
		{
			name:       "slim default (no user)",
			filter:     ItemsFilter{IDs: []string{"x"}},
			wantHas:    []string{"OfficialRating", "ProductionYear", "RunTimeTicks", "DateCreated"},
			wantHasNot: []string{"MediaStreams", "Genres", "Studios", "UserData"},
		},
		{
			name:       "slim default with user token",
			filter:     ItemsFilter{IDs: []string{"x"}},
			userToken:  "tok",
			wantHas:    []string{"OfficialRating", "ProductionYear", "RunTimeTicks", "DateCreated", "UserData"},
			wantHasNot: []string{"MediaStreams", "Genres", "Studios"},
		},
		{
			name:       "heavy opt-in",
			filter:     ItemsFilter{IDs: []string{"x"}, IncludeHeavyFields: true},
			wantHas:    []string{"OfficialRating", "ProductionYear", "RunTimeTicks", "DateCreated", "MediaStreams", "Genres", "Studios"},
			wantHasNot: []string{"UserData"},
		},
		{
			name:       "heavy + user + extra",
			filter:     ItemsFilter{IDs: []string{"x"}, IncludeHeavyFields: true, ExtraFields: []string{"Overview"}},
			userToken:  "tok",
			wantHas:    []string{"OfficialRating", "ProductionYear", "RunTimeTicks", "DateCreated", "MediaStreams", "Genres", "Studios", "UserData", "Overview"},
		},
		{
			name:       "slim + extra",
			filter:     ItemsFilter{IDs: []string{"x"}, ExtraFields: []string{"Overview"}},
			wantHas:    []string{"OfficialRating", "ProductionYear", "RunTimeTicks", "DateCreated", "Overview"},
			wantHasNot: []string{"MediaStreams", "Genres", "Studios"},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var got string
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				got = r.URL.Query().Get("Fields")
				w.Header().Set("Content-Type", "application/json")
				json.NewEncoder(w).Encode(ItemsResult{})
			}))
			defer srv.Close()
			c := New(srv.URL, "key")
			if _, err := c.GetItemsAsUser(context.Background(), tt.filter, tt.userToken); err != nil {
				t.Fatalf("GetItemsAsUser: %v", err)
			}
			fields := strings.Split(got, ",")
			fieldSet := map[string]bool{}
			for _, f := range fields {
				fieldSet[f] = true
			}
			for _, want := range tt.wantHas {
				if !fieldSet[want] {
					t.Errorf("Fields missing %q; got %q", want, got)
				}
			}
			for _, notWant := range tt.wantHasNot {
				if fieldSet[notWant] {
					t.Errorf("Fields should not include %q; got %q", notWant, got)
				}
			}
		})
	}
}

// TestGetItemsByIDsBatchedEmpty pins the contract for empty input: no
// upstream call, returns (nil, nil).
func TestGetItemsByIDsBatchedEmpty(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("upstream should not be called on empty input; got %s", r.URL)
	}))
	defer srv.Close()

	c := New(srv.URL, "key")
	out, err := c.GetItemsByIDsBatched(context.Background(), nil, "")
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if out != nil {
		t.Errorf("out = %v, want nil", out)
	}
}

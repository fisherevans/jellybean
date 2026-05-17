package server

import (
	"reflect"
	"testing"

	"github.com/fisherevans/jellybean/internal/curation"
	"github.com/fisherevans/jellybean/internal/itemcache"
	"github.com/fisherevans/jellybean/internal/jellyfin"
)

// TestAdminItemListDTOFromCache exercises the cache-row -> wire DTO
// conversion. The slim DTO drops Genres / Studios / MediaStreams but
// keeps the audio-language tuple so the badge in ItemCard still works.
// HasNonDefaultAudioLanguage is the load-bearing edge case; the rest
// is straight field copying.
func TestAdminItemListDTOFromCache(t *testing.T) {
	visible := curation.StateVisible
	tests := []struct {
		name              string
		row               itemcache.Row
		state             *curation.State
		tags              []curation.Tag
		suggest           *curation.Suggestion
		wantPrimary       string
		wantLangs         []string
		wantHasNonDefault bool
		wantState         *string
		wantTags          []adminItemTagDTO
	}{
		{
			name: "default audio language - badge stays off",
			row: itemcache.Row{
				ID:                         "movie-1",
				Name:                       "Default Audio Movie",
				Type:                       "Movie",
				PrimaryAudioLanguage:       "eng",
				AudioLanguages:             []string{"eng", "spa"},
				HasNonDefaultAudioLanguage: false,
			},
			wantPrimary:       "eng",
			wantLangs:         []string{"eng", "spa"},
			wantHasNonDefault: false,
			wantTags:          []adminItemTagDTO{},
		},
		{
			name: "non-default audio language - badge fires",
			row: itemcache.Row{
				ID:                         "movie-2",
				Name:                       "Foreign Audio Movie",
				Type:                       "Movie",
				PrimaryAudioLanguage:       "jpn",
				AudioLanguages:             []string{"jpn"},
				HasNonDefaultAudioLanguage: true,
			},
			wantPrimary:       "jpn",
			wantLangs:         []string{"jpn"},
			wantHasNonDefault: true,
			wantTags:          []adminItemTagDTO{},
		},
		{
			name: "no audio streams - empty langs, badge off",
			row: itemcache.Row{
				ID:                         "movie-3",
				Name:                       "Silent Movie",
				Type:                       "Movie",
				PrimaryAudioLanguage:       "",
				AudioLanguages:             nil,
				HasNonDefaultAudioLanguage: false,
			},
			wantPrimary:       "",
			wantLangs:         []string{},
			wantHasNonDefault: false,
			wantTags:          []adminItemTagDTO{},
		},
		{
			name: "with state + tags + suggestion",
			row: itemcache.Row{
				ID:                         "series-1",
				Name:                       "Tagged Series",
				Type:                       "Series",
				PrimaryAudioLanguage:       "eng",
				AudioLanguages:             []string{"eng"},
				HasNonDefaultAudioLanguage: false,
			},
			state: &visible,
			tags: []curation.Tag{
				{ID: 1, Name: "Educational"},
				{ID: 2, Name: "Calm"},
			},
			suggest:           &curation.Suggestion{Bucket: "visible", Confidence: 0.8},
			wantPrimary:       "eng",
			wantLangs:         []string{"eng"},
			wantHasNonDefault: false,
			wantState:         stringPtr("visible"),
			wantTags: []adminItemTagDTO{
				{ID: 1, Name: "Educational"},
				{ID: 2, Name: "Calm"},
			},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dto := adminItemListDTOFromCache(tt.row, tt.state, tt.tags, tt.suggest)
			if dto.AudioLanguage != tt.wantPrimary {
				t.Errorf("AudioLanguage = %q, want %q", dto.AudioLanguage, tt.wantPrimary)
			}
			if !reflect.DeepEqual(dto.AudioLanguages, tt.wantLangs) {
				t.Errorf("AudioLanguages = %v, want %v", dto.AudioLanguages, tt.wantLangs)
			}
			if dto.HasNonDefaultAudioLanguage != tt.wantHasNonDefault {
				t.Errorf("HasNonDefaultAudioLanguage = %v, want %v", dto.HasNonDefaultAudioLanguage, tt.wantHasNonDefault)
			}
			if !equalStringPtr(dto.State, tt.wantState) {
				t.Errorf("State = %v, want %v", deref(dto.State), deref(tt.wantState))
			}
			if !reflect.DeepEqual(dto.Tags, tt.wantTags) {
				t.Errorf("Tags = %v, want %v", dto.Tags, tt.wantTags)
			}
			if (dto.Suggestion == nil) != (tt.suggest == nil) {
				t.Errorf("Suggestion presence = %v, want %v", dto.Suggestion != nil, tt.suggest != nil)
			}
			if dto.ID != tt.row.ID {
				t.Errorf("ID = %q, want %q", dto.ID, tt.row.ID)
			}
			if dto.Name != tt.row.Name {
				t.Errorf("Name = %q, want %q", dto.Name, tt.row.Name)
			}
			if dto.Type != tt.row.Type {
				t.Errorf("Type = %q, want %q", dto.Type, tt.row.Type)
			}
		})
	}
}

// TestAdminItemListDTOFromJellyfin covers the cache-miss path. Same
// wire shape; the HasNonDefaultAudioLanguage flag is recomputed from
// the live MediaStreams instead of read out of the cached column.
func TestAdminItemListDTOFromJellyfin(t *testing.T) {
	tests := []struct {
		name              string
		item              jellyfin.Item
		wantPrimary       string
		wantHasNonDefault bool
	}{
		{
			name: "default audio track with language",
			item: jellyfin.Item{
				ID: "j1", Name: "J1", Type: "Movie",
				MediaStreams: []jellyfin.MediaStream{
					{Type: "Audio", Language: "eng", IsDefault: true, Index: 1},
				},
			},
			wantPrimary:       "eng",
			wantHasNonDefault: false,
		},
		{
			name: "no default audio track",
			item: jellyfin.Item{
				ID: "j2", Name: "J2", Type: "Movie",
				MediaStreams: []jellyfin.MediaStream{
					{Type: "Audio", Language: "jpn", IsDefault: false, Index: 1},
				},
			},
			wantPrimary:       "jpn",
			wantHasNonDefault: true,
		},
		{
			name: "no audio streams at all",
			item: jellyfin.Item{
				ID: "j3", Name: "J3", Type: "Movie",
			},
			wantPrimary:       "",
			wantHasNonDefault: false,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dto := adminItemListDTOFromJellyfin(tt.item, nil, nil, nil)
			if dto.AudioLanguage != tt.wantPrimary {
				t.Errorf("AudioLanguage = %q, want %q", dto.AudioLanguage, tt.wantPrimary)
			}
			if dto.HasNonDefaultAudioLanguage != tt.wantHasNonDefault {
				t.Errorf("HasNonDefaultAudioLanguage = %v, want %v", dto.HasNonDefaultAudioLanguage, tt.wantHasNonDefault)
			}
		})
	}
}

func stringPtr(s string) *string { return &s }

func equalStringPtr(a, b *string) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}

func deref(p *string) string {
	if p == nil {
		return "<nil>"
	}
	return *p
}

package jellyfin

// AuthResult is returned by AuthenticateByName.
type AuthResult struct {
	User        AuthUser `json:"User"`
	AccessToken string   `json:"AccessToken"`
	ServerID    string   `json:"ServerId"`
}

type AuthUser struct {
	ID     string     `json:"Id"`
	Name   string     `json:"Name"`
	Policy UserPolicy `json:"Policy"`
}

type UserPolicy struct {
	IsAdministrator bool `json:"IsAdministrator"`
	IsDisabled      bool `json:"IsDisabled"`
}

// Item is the subset of Jellyfin item fields Jellybean uses. Add fields here
// as features need them rather than dragging in the full schema.
type Item struct {
	ID             string    `json:"Id"`
	Name           string    `json:"Name"`
	Type           string    `json:"Type"`
	MediaType      string    `json:"MediaType"`
	OfficialRating string    `json:"OfficialRating"`
	Genres         []string  `json:"Genres"`
	Studios        []Studio  `json:"Studios"`
	ProductionYear int       `json:"ProductionYear"`
	RunTimeTicks   int64     `json:"RunTimeTicks"`
	ImageTags      ImageTags `json:"ImageTags"`
	// UserData is populated only when the request was made with a user
	// token AND Fields=UserData was requested. nil otherwise.
	UserData *ItemUserData `json:"UserData,omitempty"`
	// SeriesId is set on Episode items so the kid client can resolve
	// "what series did this come from" without a second round trip.
	SeriesID   string `json:"SeriesId,omitempty"`
	SeriesName string `json:"SeriesName,omitempty"`
	// ParentIndexNumber + IndexNumber on Episode items: the season
	// number and the episode-within-season number. Drives "S1E2"
	// display in the kid player. Pointers because zero is a real
	// value (specials sometimes use 0, and we want to distinguish
	// "0" from "missing".)
	ParentIndexNumber *int `json:"ParentIndexNumber,omitempty"`
	IndexNumber       *int `json:"IndexNumber,omitempty"`
	// MediaStreams is populated when Fields=MediaStreams is requested.
	// Used to surface the primary audio language for the curation UI.
	MediaStreams []MediaStream `json:"MediaStreams,omitempty"`
}

// MediaStream is the audio/video/subtitle stream metadata Jellyfin
// returns inside an item. We only care about Type=Audio for language
// detection; other types are ignored.
type MediaStream struct {
	Type      string `json:"Type"`
	Language  string `json:"Language"`
	Codec     string `json:"Codec"`
	Index     int    `json:"Index"`
	IsDefault bool   `json:"IsDefault"`
}

// PrimaryAudioLanguage returns the best-effort language code for the
// item's main audio track: the default audio stream if marked, otherwise
// the first audio stream. Empty when no audio metadata is available.
func (i Item) PrimaryAudioLanguage() string {
	var first string
	for _, s := range i.MediaStreams {
		if s.Type != "Audio" {
			continue
		}
		if s.IsDefault && s.Language != "" {
			return s.Language
		}
		if first == "" {
			first = s.Language
		}
	}
	return first
}

// ItemUserData carries the per-user playback metadata: how far through
// the user is, whether they've finished, and so on. Returned by Jellyfin
// when the call is authenticated with a user token AND Fields=UserData
// is requested.
type ItemUserData struct {
	PlaybackPositionTicks int64   `json:"PlaybackPositionTicks"`
	PlayedPercentage      float64 `json:"PlayedPercentage"`
	Played                bool    `json:"Played"`
	PlayCount             int     `json:"PlayCount"`
	IsFavorite            bool    `json:"IsFavorite"`
}

type Studio struct {
	Name string `json:"Name"`
	ID   string `json:"Id"`
}

type ImageTags struct {
	Primary string `json:"Primary"`
	Logo    string `json:"Logo"`
	Thumb   string `json:"Thumb"`
}

// ItemsResult is the shape Jellyfin returns from /Items.
type ItemsResult struct {
	Items            []Item `json:"Items"`
	TotalRecordCount int    `json:"TotalRecordCount"`
	StartIndex       int    `json:"StartIndex"`
}

// ItemsFilter narrows /Items queries. Empty fields are not sent.
type ItemsFilter struct {
	IncludeItemTypes []string
	IDs              []string // explicit Ids filter; bypasses Recursive scan
	Recursive        bool
	Limit            int
	StartIndex       int
	SortBy           string
	SortOrder        string
	SearchTerm       string
}

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

// Per-domain route registrars. The big router-wiring function in
// server.go would be ~80 lines of HandleFunc calls if we stayed flat;
// grouping by domain (items, profiles, tags, ...) keeps each block
// small and adjacent to the handlers that own them.

package server

import (
	"net/http"

	"github.com/gorilla/mux"
)

// ---- admin routes -------------------------------------------------

func (s *Server) adminItemRoutes(r *mux.Router) {
	r.HandleFunc("/items", s.handleAdminItems).Methods(http.MethodGet)
	r.HandleFunc("/items/{id}", s.handleAdminGetItem).Methods(http.MethodGet)
	r.HandleFunc("/items/{id}/tags", s.handleAdminGetItemTags).Methods(http.MethodGet)
	r.HandleFunc("/items/{id}/tags", s.handleAdminSetItemTags).Methods(http.MethodPut)
	r.HandleFunc("/items/{id}/image", s.handleAdminImage).Methods(http.MethodGet)
	r.HandleFunc("/items/{id}/stream", s.handleAdminStream).Methods(http.MethodGet)
	r.HandleFunc("/items/{id}/state", s.handleAdminSetState).Methods(http.MethodPost)
	r.HandleFunc("/items/state/bulk", s.handleAdminBulkState).Methods(http.MethodPost)
	r.HandleFunc("/categorizations/recent", s.handleAdminRecentActivity).Methods(http.MethodGet)
	r.HandleFunc("/maintenance/reconcile", s.handleAdminReconcile).Methods(http.MethodPost)
	r.HandleFunc("/jellyfin/users", s.handleListJellyfinUsers).Methods(http.MethodGet)
}

func (s *Server) adminProfileRoutes(r *mux.Router) {
	r.HandleFunc("/profiles", s.handleListProfiles).Methods(http.MethodGet)
	r.HandleFunc("/profiles", s.handleCreateProfile).Methods(http.MethodPost)
	r.HandleFunc("/profiles/{id}", s.handleUpdateProfile).Methods(http.MethodPatch)
	r.HandleFunc("/profiles/{id}", s.handleDeleteProfile).Methods(http.MethodDelete)
	r.HandleFunc("/profiles/{id}/layout", s.handleAdminSetProfileLayout).Methods(http.MethodPut)
	r.HandleFunc("/kids", s.handleListKids).Methods(http.MethodGet)
	r.HandleFunc("/kids", s.handleCreateKid).Methods(http.MethodPost)
	r.HandleFunc("/kids/{id}", s.handleUpdateKid).Methods(http.MethodPatch)
	r.HandleFunc("/kids/{id}", s.handleDeleteKid).Methods(http.MethodDelete)
	r.HandleFunc("/kids/{id}/favorites", s.handleAdminListKidFavorites).Methods(http.MethodGet)
	r.HandleFunc("/kids/{id}/favorites/{itemId}", s.handleAdminAddKidFavorite).Methods(http.MethodPut)
	r.HandleFunc("/kids/{id}/favorites/{itemId}", s.handleAdminRemoveKidFavorite).Methods(http.MethodDelete)
}

func (s *Server) adminTagRoutes(r *mux.Router) {
	r.HandleFunc("/tags", s.handleListTags).Methods(http.MethodGet)
	r.HandleFunc("/tags", s.handleCreateTag).Methods(http.MethodPost)
	r.HandleFunc("/tags/{id}", s.handleUpdateTag).Methods(http.MethodPatch)
	r.HandleFunc("/tags/{id}", s.handleDeleteTag).Methods(http.MethodDelete)
	r.HandleFunc("/profiles/{id}/tag-filters", s.handleAdminListProfileTagFilters).Methods(http.MethodGet)
	r.HandleFunc("/profiles/{id}/tag-filters", s.handleAdminPutProfileTagFilters).Methods(http.MethodPut)
	r.HandleFunc("/profiles/{id}/tag-filters/{tagId}", s.handleAdminDeleteProfileTagFilter).Methods(http.MethodDelete)
}

func (s *Server) adminLayoutRoutes(r *mux.Router) {
	r.HandleFunc("/layouts", s.handleAdminListLayouts).Methods(http.MethodGet)
	r.HandleFunc("/layouts", s.handleAdminCreateLayout).Methods(http.MethodPost)
	r.HandleFunc("/layouts/{id}", s.handleAdminGetLayout).Methods(http.MethodGet)
	r.HandleFunc("/layouts/{id}", s.handleAdminUpdateLayout).Methods(http.MethodPatch)
	r.HandleFunc("/layouts/{id}", s.handleAdminDeleteLayout).Methods(http.MethodDelete)
	r.HandleFunc("/layouts/{id}/clone", s.handleAdminCloneLayout).Methods(http.MethodPost)
	r.HandleFunc("/layouts/{id}/default", s.handleAdminSetDefaultLayout).Methods(http.MethodPost)
	r.HandleFunc("/layouts/{id}/preview", s.handleAdminLayoutPreview).Methods(http.MethodGet)
	r.HandleFunc("/layouts/{id}/rows", s.handleAdminAppendRow).Methods(http.MethodPost)
	r.HandleFunc("/layouts/{id}/rows/order", s.handleAdminReorderRows).Methods(http.MethodPut)
	r.HandleFunc("/layouts/{id}/rows/{rowId}", s.handleAdminUpdateRow).Methods(http.MethodPatch)
	r.HandleFunc("/layouts/{id}/rows/{rowId}", s.handleAdminDeleteRow).Methods(http.MethodDelete)
	r.HandleFunc("/dev/refresh-layout-cache", s.handleAdminRefreshLayoutCache).Methods(http.MethodPost)
}

func (s *Server) adminAPIKeyRoutes(r *mux.Router) {
	r.HandleFunc("/api-keys", s.handleAdminListAPIKeys).Methods(http.MethodGet)
	r.HandleFunc("/api-keys", s.handleAdminCreateAPIKey).Methods(http.MethodPost)
	r.HandleFunc("/api-keys/{id}", s.handleAdminDeleteAPIKey).Methods(http.MethodDelete)
	r.HandleFunc("/api-keys/{id}/revoke", s.handleAdminRevokeAPIKey).Methods(http.MethodPost)
	r.HandleFunc("/api-keys/{id}/log", s.handleAdminListAccessLog).Methods(http.MethodGet)
	r.HandleFunc("/api-access-log", s.handleAdminListAccessLog).Methods(http.MethodGet)
}

func (s *Server) adminOverrideRoutes(r *mux.Router) {
	r.HandleFunc("/override", s.handleAdminOverrideStatus).Methods(http.MethodGet)
	r.HandleFunc("/override/pin", s.handleAdminSetOverridePIN).Methods(http.MethodPost)
	r.HandleFunc("/override/clear-lockout", s.handleAdminClearOverrideLockout).Methods(http.MethodPost)
	r.HandleFunc("/settings", s.handleAdminListSettings).Methods(http.MethodGet)
	r.HandleFunc("/settings", s.handleAdminSetSetting).Methods(http.MethodPut)
}

func (s *Server) adminTimeLimitRoutes(r *mux.Router) {
	r.HandleFunc("/profiles/{id}/time-limits", s.handleAdminProfileTimeLimits).Methods(http.MethodGet)
	r.HandleFunc("/profiles/{id}/time-limits", s.handleAdminUpdateProfileTimeLimits).Methods(http.MethodPut)
	r.HandleFunc("/profiles/{id}/content-overrides", s.handleAdminListContentOverrides).Methods(http.MethodGet)
	r.HandleFunc("/profiles/{id}/content-overrides/{itemId}", s.handleAdminUpsertContentOverride).Methods(http.MethodPut)
	r.HandleFunc("/kids/{id}/time-status", s.handleAdminKidTimeStatus).Methods(http.MethodGet)
}

func (s *Server) adminBodyBreakRoutes(r *mux.Router) {
	r.HandleFunc("/profiles/{id}/body-breaks", s.handleAdminProfileBodyBreaks).Methods(http.MethodGet)
	r.HandleFunc("/profiles/{id}/body-breaks", s.handleAdminUpdateProfileBodyBreaks).Methods(http.MethodPut)
	r.HandleFunc("/profiles/{id}/body-breaks/reset", s.handleAdminResetProfileBodyBreaks).Methods(http.MethodPost)
}

func (s *Server) adminViewingRoutes(r *mux.Router) {
	r.HandleFunc("/profiles/{id}/viewing-controls", s.handleAdminProfileViewingControls).Methods(http.MethodGet)
	r.HandleFunc("/profiles/{id}/viewing-controls", s.handleAdminUpdateProfileViewingControls).Methods(http.MethodPut)
}

func (s *Server) adminModeRoutes(r *mux.Router) {
	r.HandleFunc("/profiles/{id}/modes", s.handleAdminListModes).Methods(http.MethodGet)
	r.HandleFunc("/profiles/{id}/modes", s.handleAdminCreateMode).Methods(http.MethodPost)
	r.HandleFunc("/modes/{id}", s.handleAdminUpdateMode).Methods(http.MethodPatch)
	r.HandleFunc("/modes/{id}", s.handleAdminDeleteMode).Methods(http.MethodDelete)
}

func (s *Server) adminChannelRoutes(r *mux.Router) {
	r.HandleFunc("/profiles/{id}/channels", s.handleAdminListChannels).Methods(http.MethodGet)
	r.HandleFunc("/profiles/{id}/channels", s.handleAdminCreateChannel).Methods(http.MethodPost)
	r.HandleFunc("/channels/{id}", s.handleAdminUpdateChannel).Methods(http.MethodPatch)
	r.HandleFunc("/channels/{id}", s.handleAdminDeleteChannel).Methods(http.MethodDelete)
}

// ---- kids routes --------------------------------------------------

func (s *Server) kidsLibraryRoutes(r *mux.Router) {
	r.HandleFunc("/library", s.handleKidsLibrary).Methods(http.MethodGet)
	r.HandleFunc("/browse", s.handleKidsBrowse).Methods(http.MethodGet)
	r.HandleFunc("/items/{id}", s.handleKidsItem).Methods(http.MethodGet)
	r.HandleFunc("/items/{id}/image", s.handleKidsImage).Methods(http.MethodGet)
	r.HandleFunc("/items/{id}/next-up", s.handleKidsNextUp).Methods(http.MethodGet)
	r.HandleFunc("/series/{id}/episodes", s.handleKidsSeriesEpisodes).Methods(http.MethodGet)
}

func (s *Server) kidsPlaybackRoutes(r *mux.Router) {
	r.HandleFunc("/items/{id}/stream", s.handleKidsStream).Methods(http.MethodGet)
	r.HandleFunc("/playback/start", s.handleKidsPlaybackStart).Methods(http.MethodPost)
	r.HandleFunc("/playback/progress", s.handleKidsPlaybackProgress).Methods(http.MethodPost)
	r.HandleFunc("/playback/stopped", s.handleKidsPlaybackStopped).Methods(http.MethodPost)
	r.HandleFunc("/playback/stop-encoding", s.handleKidsStopEncoding).Methods(http.MethodPost)
}

func (s *Server) kidsOverrideRoutes(r *mux.Router) {
	r.HandleFunc("/override/verify-pin", s.handleKidsOverrideVerifyPIN).Methods(http.MethodPost)
	r.HandleFunc("/override/refresh", s.handleKidsOverrideRefresh).Methods(http.MethodPost)
	r.HandleFunc("/override/end", s.handleKidsOverrideEnd).Methods(http.MethodPost)
	r.HandleFunc("/override/items/{id}/favorite", s.handleKidsOverrideFavorite).Methods(http.MethodPost)
	r.HandleFunc("/override/items/{id}/tags", s.handleKidsOverrideTagsList).Methods(http.MethodGet)
	r.HandleFunc("/override/items/{id}/tags", s.handleKidsOverrideTags).Methods(http.MethodPut)
	r.HandleFunc("/override/items/{id}/hide", s.handleKidsOverrideHide).Methods(http.MethodPost)
	r.HandleFunc("/override/items/{id}/mark/{state}", s.handleKidsOverrideMarkPlayed).Methods(http.MethodPost)
	r.HandleFunc("/override/items/{id}/qr", s.handleKidsOverrideQR).Methods(http.MethodGet)
	r.HandleFunc("/override/grant-time", s.handleKidsOverrideGrantTime).Methods(http.MethodPost)
	r.HandleFunc("/override/skip-break", s.handleKidsOverrideSkipBreak).Methods(http.MethodPost)
}

func (s *Server) kidsTimeRoutes(r *mux.Router) {
	r.HandleFunc("/time-status", s.handleKidsTimeStatus).Methods(http.MethodGet)
	r.HandleFunc("/items/{id}/can-play", s.handleKidsCanPlay).Methods(http.MethodGet)
	r.HandleFunc("/body-break-status", s.handleKidsBodyBreakStatus).Methods(http.MethodGet)
}

func (s *Server) kidsViewingRoutes(r *mux.Router) {
	r.HandleFunc("/viewing-state", s.handleKidsViewingState).Methods(http.MethodGet)
	r.HandleFunc("/override/viewing/{action}", s.handleKidsOverrideSetViewing).Methods(http.MethodPost)
}

func (s *Server) kidsModeRoutes(r *mux.Router) {
	r.HandleFunc("/active-mode", s.handleKidsActiveMode).Methods(http.MethodGet)
	r.HandleFunc("/override/set-mode", s.handleKidsOverrideSetMode).Methods(http.MethodPost)
}

func (s *Server) kidsChannelRoutes(r *mux.Router) {
	r.HandleFunc("/channels", s.handleKidsChannels).Methods(http.MethodGet)
}

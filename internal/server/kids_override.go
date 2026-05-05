package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/gorilla/mux"

	"github.com/fisherevans/jellybean/internal/curation"
)

// Adult override mode (M9). Auth flow:
//   1. Kid TV holds long-press UP on a tile.
//   2. Kid client posts /api/kids/override/verify-pin {pin}; the
//      server bcrypt-checks against override_config and, on
//      success, mints a per-kid session token (kid_override_sessions).
//   3. Subsequent override-gated POSTs carry the token in the
//      X-Override-Token header. The handler verifies + bumps
//      last_used; refresh extends expires_at by SessionTTL on
//      every call so the menu stays unlocked while the parent
//      navigates inside it.

const overrideTokenHeader = "X-Override-Token"

// requireOverride is a small helper that resolves the kid context +
// validates the override token. Returns the kid id on success;
// writes the appropriate 401/403 + returns 0 on failure.
func (s *Server) requireOverride(w http.ResponseWriter, r *http.Request) (int64, *kidsContext) {
	kc := s.resolveKidsAuth(r)
	if kc == nil {
		http.Error(w, "unauthenticated", http.StatusUnauthorized)
		return 0, nil
	}
	kidID, _ := s.lookupKidID(r.Context(), kc)
	if kidID == 0 {
		http.Error(w, "override requires kid bearer auth", http.StatusForbidden)
		return 0, nil
	}
	tok := r.Header.Get(overrideTokenHeader)
	if tok == "" {
		http.Error(w, "missing override token", http.StatusUnauthorized)
		return 0, nil
	}
	if err := s.curation.ValidateSession(r.Context(), kidID, tok); err != nil {
		http.Error(w, "override session invalid", http.StatusUnauthorized)
		return 0, nil
	}
	return kidID, kc
}

// lookupKidID resolves the kid id from a kidsContext. The bearer-
// auth path doesn't carry the kid record's id directly; we look it
// up from the Jellyfin user id once and stash it on the kc field
// in a future refactor.
func (s *Server) lookupKidID(ctx context.Context, kc *kidsContext) (int64, error) {
	if kc.ProfileID == 0 || kc.JellyfinUserID == "" {
		return 0, nil
	}
	kid, err := s.curation.FindKidByJellyfinUser(ctx, kc.JellyfinUserID)
	if err != nil {
		return 0, err
	}
	return kid.ID, nil
}

// handleKidsOverrideVerifyPIN posts {pin: "1234"} and gets back a
// session token + expiresAt on success. Errors:
//   - 401 unauthenticated when no kid bearer
//   - 412 not configured when no PIN has been set
//   - 423 locked when in the lockout window (Retry-After header
//     carries the seconds-until-unlock so the UI can render a timer)
//   - 401 incorrect on a wrong PIN that didn't trip the lockout
func (s *Server) handleKidsOverrideVerifyPIN(w http.ResponseWriter, r *http.Request) {
	kc := s.resolveKidsAuth(r)
	if kc == nil {
		http.Error(w, "unauthenticated", http.StatusUnauthorized)
		return
	}
	kidID, _ := s.lookupKidID(r.Context(), kc)
	if kidID == 0 {
		http.Error(w, "override requires kid bearer auth", http.StatusForbidden)
		return
	}
	var req struct {
		PIN string `json:"pin"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.PIN == "" {
		http.Error(w, "pin required", http.StatusBadRequest)
		return
	}
	err := s.curation.VerifyPIN(r.Context(), req.PIN)
	switch {
	case err == nil:
		// proceed
	case errors.Is(err, curation.ErrPINNotSet):
		http.Error(w, "override pin not configured", http.StatusPreconditionFailed)
		return
	case errors.Is(err, curation.ErrPINLockedOut):
		st, _ := s.curation.GetOverrideStatus(r.Context())
		if st != nil && st.LockedFor > 0 {
			w.Header().Set("Retry-After",
				intString(int(st.LockedFor.Seconds())+1))
		}
		http.Error(w, "locked out", http.StatusLocked)
		return
	case errors.Is(err, curation.ErrPINIncorrect):
		http.Error(w, "incorrect pin", http.StatusUnauthorized)
		return
	default:
		s.logger.Error().Err(err).Msg("override verify pin")
		http.Error(w, "verify failed", http.StatusInternalServerError)
		return
	}
	sess, err := s.curation.MintSession(r.Context(), kidID)
	if err != nil {
		s.logger.Error().Err(err).Msg("mint override session")
		http.Error(w, "session error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"token":     sess.Token,
		"expiresAt": sess.ExpiresAt.Unix(),
	})
}

func (s *Server) handleKidsOverrideRefresh(w http.ResponseWriter, r *http.Request) {
	kidID, _ := s.requireOverride(w, r)
	if kidID == 0 {
		return
	}
	tok := r.Header.Get(overrideTokenHeader)
	sess, err := s.curation.RefreshSession(r.Context(), kidID, tok)
	if err != nil {
		http.Error(w, "session invalid", http.StatusUnauthorized)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"token":     sess.Token,
		"expiresAt": sess.ExpiresAt.Unix(),
	})
}

func (s *Server) handleKidsOverrideEnd(w http.ResponseWriter, r *http.Request) {
	kc := s.resolveKidsAuth(r)
	if kc == nil {
		http.Error(w, "unauthenticated", http.StatusUnauthorized)
		return
	}
	kidID, _ := s.lookupKidID(r.Context(), kc)
	if kidID > 0 {
		_ = s.curation.EndSession(r.Context(), kidID)
	}
	w.WriteHeader(http.StatusNoContent)
}

// --- gated actions ------------------------------------------------------

func (s *Server) handleKidsOverrideFavorite(w http.ResponseWriter, r *http.Request) {
	kidID, _ := s.requireOverride(w, r)
	if kidID == 0 {
		return
	}
	itemID := mux.Vars(r)["id"]
	if itemID == "" {
		http.Error(w, "item id required", http.StatusBadRequest)
		return
	}
	var req struct {
		State string `json:"state"` // "add" | "remove"
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	switch req.State {
	case "add":
		if err := s.curation.AddKidFavorite(r.Context(), kidID, itemID); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		_ = s.curation.RecordOverrideAction(r.Context(), kidID, "favorite_add", itemID, "")
	case "remove":
		if err := s.curation.RemoveKidFavorite(r.Context(), kidID, itemID); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		_ = s.curation.RecordOverrideAction(r.Context(), kidID, "favorite_remove", itemID, "")
	default:
		http.Error(w, `state must be "add" or "remove"`, http.StatusBadRequest)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleKidsOverrideTags(w http.ResponseWriter, r *http.Request) {
	kidID, _ := s.requireOverride(w, r)
	if kidID == 0 {
		return
	}
	itemID := mux.Vars(r)["id"]
	if itemID == "" {
		http.Error(w, "item id required", http.StatusBadRequest)
		return
	}
	var req struct {
		TagIDs []int64 `json:"tagIds"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if err := s.curation.SetTagsForItem(r.Context(), itemID, req.TagIDs, "override"); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	payload, _ := json.Marshal(req)
	_ = s.curation.RecordOverrideAction(r.Context(), kidID, "tag_set", itemID, string(payload))
	w.WriteHeader(http.StatusNoContent)
}

// handleKidsOverrideTagsList is the GET counterpart to the PUT
// above. Returns the global tag list + the item's currently-
// applied tag ids so the kid client's tag picker can seed
// checkboxes without admin auth.
func (s *Server) handleKidsOverrideTagsList(w http.ResponseWriter, r *http.Request) {
	if kidID, _ := s.requireOverride(w, r); kidID == 0 {
		return
	}
	itemID := mux.Vars(r)["id"]
	if itemID == "" {
		http.Error(w, "item id required", http.StatusBadRequest)
		return
	}
	all, err := s.curation.ListTags(r.Context(), curation.TagSortName)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	current, err := s.curation.GetTagsForItem(r.Context(), itemID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	tagOut := make([]map[string]any, 0, len(all))
	for _, t := range all {
		tagOut = append(tagOut, map[string]any{
			"id":   t.ID,
			"name": t.Name,
		})
	}
	selected := make([]int64, 0, len(current))
	for _, t := range current {
		selected = append(selected, t.ID)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"tags":     tagOut,
		"selected": selected,
	})
}

func (s *Server) handleKidsOverrideHide(w http.ResponseWriter, r *http.Request) {
	kidID, kc := s.requireOverride(w, r)
	if kidID == 0 {
		return
	}
	itemID := mux.Vars(r)["id"]
	if itemID == "" {
		http.Error(w, "item id required", http.StatusBadRequest)
		return
	}
	hidden := curation.StateHidden
	if _, err := s.curation.SetState(r.Context(), itemID, kc.ProfileID, &hidden, "override"); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	_ = s.curation.RecordOverrideAction(r.Context(), kidID, "hide", itemID, "")
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleKidsOverrideMarkPlayed(w http.ResponseWriter, r *http.Request) {
	kidID, kc := s.requireOverride(w, r)
	if kidID == 0 {
		return
	}
	itemID := mux.Vars(r)["id"]
	if itemID == "" {
		http.Error(w, "item id required", http.StatusBadRequest)
		return
	}
	played := mux.Vars(r)["state"] != "unplayed"
	// Jellyfin's PlayState API marks individual items as played or
	// unplayed for the authenticated user. We use the kid's bearer
	// token so the change attributes correctly.
	if err := s.jellyfin.SetPlayedState(r.Context(), kc.JellyfinToken, kc.JellyfinUserID, itemID, played); err != nil {
		s.logger.Error().Err(err).Str("item", itemID).Msg("set played state")
		http.Error(w, "jellyfin update failed", http.StatusBadGateway)
		return
	}
	action := "mark_played"
	if !played {
		action = "mark_unplayed"
	}
	_ = s.curation.RecordOverrideAction(r.Context(), kidID, action, itemID, "")
	w.WriteHeader(http.StatusNoContent)
}

// handleKidsOverrideQR returns a deep-link URL the kid client can
// render as a QR code so the parent can scan it on their phone and
// land on the admin manage-item page.
//
// Public URL is read from app_settings; when not configured we fall
// back to the request's Host header which is fine for local testing
// but produces an unreachable URL across networks.
func (s *Server) handleKidsOverrideQR(w http.ResponseWriter, r *http.Request) {
	kidID, _ := s.requireOverride(w, r)
	if kidID == 0 {
		return
	}
	itemID := mux.Vars(r)["id"]
	if itemID == "" {
		http.Error(w, "item id required", http.StatusBadRequest)
		return
	}
	publicURL, _ := s.curation.AppSettingGet(r.Context(), "public_url")
	if publicURL == "" {
		scheme := "http"
		if r.TLS != nil {
			scheme = "https"
		}
		publicURL = scheme + "://" + r.Host
	}
	deepLink := publicURL + "/manage-item/" + itemID
	_ = s.curation.RecordOverrideAction(r.Context(), kidID, "qr_view", itemID, "")
	writeJSON(w, http.StatusOK, map[string]any{
		"url":        deepLink,
		"itemId":     itemID,
		"publicUrl":  publicURL,
	})
}

// intString is a tiny strconv.Itoa replacement that avoids the
// import in this file. itoa-equivalent for small positive ints.
func intString(n int) string {
	if n < 0 {
		n = 0
	}
	if n == 0 {
		return "0"
	}
	buf := [20]byte{}
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}


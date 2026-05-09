package server

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/gorilla/mux"

	"github.com/fisherevans/jellybean/internal/curation"
)

// HTTP boilerplate helpers shared across admin handlers. These exist
// because every handler was repeating the same five-line dance for
// path-id parsing, body decoding, and domain-error mapping. Centralizing
// it keeps the per-handler bodies focused on actual logic.

// defaultDecodeBodyLimit caps JSON request bodies. 1MB is generous for
// every payload we currently accept (tag mutations, layout rows,
// time-limit configs) and stops a malicious / buggy client from
// streaming an unbounded body into memory.
const defaultDecodeBodyLimit = 1 << 20 // 1MB

// decodeJSON reads up to max bytes from r.Body, JSON-decodes them into
// T, and rejects unknown fields. max <= 0 falls back to the package
// default. Returns the zero value of T on any error so callers can
// surface a 400 cleanly.
//
// Empty bodies surface as io.EOF; callers that treat the body as
// optional should ignore the error and rely on the zero value.
func decodeJSON[T any](r *http.Request, max int64) (T, error) {
	var zero T
	if max <= 0 {
		max = defaultDecodeBodyLimit
	}
	dec := json.NewDecoder(io.LimitReader(r.Body, max))
	dec.DisallowUnknownFields()
	var out T
	if err := dec.Decode(&out); err != nil {
		return zero, err
	}
	return out, nil
}

// pathID parses a positive int64 path parameter from the mux route.
// Returns the same "bad id" sentinel parseIDParam does so the call
// sites stay uniform.
func pathID(r *http.Request, key string) (int64, error) {
	return parseIDParam(mux.Vars(r)[key])
}

// writeDomainError maps known curation sentinel errors to the right
// HTTP status. Returns true when it handled the error (caller should
// return); false means err isn't a known sentinel and the caller
// should fall through to its own 500.
//
// The mapping mirrors what the per-handler ladders used to do:
//   - *NotFound       -> 404
//   - *NameTaken      -> 409 (conflict)
//   - *Protected      -> 403 (forbidden, caller refused to delete)
//   - *InUse          -> 409
//   - PIN sentinels   -> 401/412 (matches the override flow's existing
//     contract; see admin_override.go and kids_override.go)
//   - *UserCollision  -> 409
func writeDomainError(w http.ResponseWriter, err error) bool {
	switch {
	case err == nil:
		return false
	case errors.Is(err, curation.ErrProfileNotFound):
		http.Error(w, "profile not found", http.StatusNotFound)
	case errors.Is(err, curation.ErrProfileProtected):
		http.Error(w, err.Error(), http.StatusForbidden)
	case errors.Is(err, curation.ErrProfileInUse):
		http.Error(w, err.Error(), http.StatusConflict)
	case errors.Is(err, curation.ErrLayoutNotFound):
		http.Error(w, "layout not found", http.StatusNotFound)
	case errors.Is(err, curation.ErrLayoutNameTaken):
		http.Error(w, err.Error(), http.StatusConflict)
	case errors.Is(err, curation.ErrLayoutProtected):
		http.Error(w, err.Error(), http.StatusForbidden)
	case errors.Is(err, curation.ErrLayoutRowNotFound):
		http.Error(w, "row not found", http.StatusNotFound)
	case errors.Is(err, curation.ErrTagNotFound):
		http.Error(w, "tag not found", http.StatusNotFound)
	case errors.Is(err, curation.ErrTagNameTaken):
		http.Error(w, err.Error(), http.StatusConflict)
	case errors.Is(err, curation.ErrKidNotFound):
		http.Error(w, "kid not found", http.StatusNotFound)
	case errors.Is(err, curation.ErrKidUserCollision):
		http.Error(w, err.Error(), http.StatusConflict)
	case errors.Is(err, curation.ErrAPIKeyNotFound):
		http.Error(w, "key not found", http.StatusNotFound)
	case errors.Is(err, curation.ErrPINNotSet):
		http.Error(w, err.Error(), http.StatusPreconditionFailed)
	case errors.Is(err, curation.ErrPINIncorrect):
		http.Error(w, err.Error(), http.StatusUnauthorized)
	case errors.Is(err, curation.ErrPINLockedOut):
		http.Error(w, err.Error(), http.StatusTooManyRequests)
	case errors.Is(err, curation.ErrOverrideSessionInvalid):
		http.Error(w, err.Error(), http.StatusUnauthorized)
	default:
		return false
	}
	return true
}

package server

import (
	"context"
	"net/http"
)

// Kids subrouter middleware. Lifts the five-line preamble that opened
// every handler under /api/kids/* into one place so handlers receive a
// pre-resolved (kidsContext, profileID, deviceId-stamped ctx) and can
// get on with the job.
//
// Failure modes still surface where they used to:
//   - 401 unauthenticated when neither admin cookie nor kid bearer
//     resolves (mirrors auth.SessionFromContext + parseBearer).
//   - 400 with the resolveKidsProfileID error message when an admin
//     caller forgets ?profileId=. Kid bearer auth carries the profile
//     id implicitly, so this branch is only reachable on the admin
//     preview path.
//
// Handlers retrieve the prepared values via KidsContextFromRequest,
// matching the shape of auth.SessionFromContext upstream.

type kidsCtxKey int

const (
	kidsContextKey   kidsCtxKey = 1
	kidsProfileIDKey kidsCtxKey = 2
)

// KidsContextFromRequest returns the kidsContext + profileID stuffed
// onto the request by kidsMiddleware. Both values are guaranteed
// populated when called from a handler under the kids subrouter:
// the middleware short-circuits the request on missing auth or
// profile id, so handlers never see a zero kc here.
func KidsContextFromRequest(r *http.Request) (*kidsContext, int64) {
	kc, _ := r.Context().Value(kidsContextKey).(*kidsContext)
	pid, _ := r.Context().Value(kidsProfileIDKey).(int64)
	return kc, pid
}

// kidsMiddleware is the per-subrouter middleware that runs the
// resolveKidsAuth + resolveKidsProfileID + kidsRequestContext
// preamble once and stashes the results on the request context for
// downstream handlers.
//
// Mounted on the /api/kids subrouter after auth.OptionalMiddleware so
// both auth modes (admin cookie via the auth subrouter; kid bearer
// via parseBearer) coexist. Unauthenticated kid endpoints
// (/kids/auth/login, /kids/auth/quickconnect/*) live OFF the
// subrouter and bypass this middleware by design.
func (s *Server) kidsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		kc := s.resolveKidsAuth(r)
		if kc == nil {
			http.Error(w, "unauthenticated", http.StatusUnauthorized)
			return
		}
		profileID, msg := s.resolveKidsProfileID(r, kc)
		if msg != "" {
			http.Error(w, msg, http.StatusBadRequest)
			return
		}
		ctx, _ := kidsRequestContext(r)
		ctx = context.WithValue(ctx, kidsContextKey, kc)
		ctx = context.WithValue(ctx, kidsProfileIDKey, profileID)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

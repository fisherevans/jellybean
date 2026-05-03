package auth

import (
	"sync"
	"time"
)

// RateLimiter is a simple per-key fixed-window counter, sized for the failed-
// login use case. Not durable across restarts (in-memory map); that is fine
// for an attacker-deterrent of this scale.
type RateLimiter struct {
	mu     sync.Mutex
	window time.Duration
	max    int
	data   map[string]*window
}

type window struct {
	start time.Time
	count int
}

func NewRateLimiter(maxAttempts int, w time.Duration) *RateLimiter {
	return &RateLimiter{
		window: w,
		max:    maxAttempts,
		data:   make(map[string]*window),
	}
}

// Allow records an attempt for the given key. Returns false if the key has
// already exceeded its budget within the current window.
func (r *RateLimiter) Allow(key string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	now := time.Now()
	entry, ok := r.data[key]
	if !ok || now.Sub(entry.start) >= r.window {
		r.data[key] = &window{start: now, count: 1}
		return true
	}
	if entry.count >= r.max {
		return false
	}
	entry.count++
	return true
}

// Reset clears any record for the key. Call after a successful login so a
// long-lived attacker session does not deplete the budget for the legitimate
// user behind the same NAT.
func (r *RateLimiter) Reset(key string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.data, key)
}

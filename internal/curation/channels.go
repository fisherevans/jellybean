package curation

// Cable TV channels (M15). Per-profile named streams that mix tag
// membership + explicit per-item picks; the kid SPA's channel
// playback engine resolves these into a queue.
//
// Storage layer here is plain CRUD; queue resolution (taking a
// channel definition + the kid's visibility state and emitting a
// shuffled / ordered stream) is the kid SPA's job - this layer only
// surfaces the raw inputs.

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

type Channel struct {
	ID          int64     `json:"id"`
	ProfileID   int64     `json:"profileId"`
	Name        string    `json:"name"`
	Description string    `json:"description,omitempty"`
	BadgeText   string    `json:"badgeText,omitempty"`
	BadgeColor  string    `json:"badgeColor,omitempty"`
	SortOrder   string    `json:"sortOrder"`
	TagIDs      []int64   `json:"tagIds"`
	ItemIDs     []string  `json:"itemIds"`
	CreatedAt   time.Time `json:"createdAt"`
	UpdatedAt   time.Time `json:"updatedAt"`
}

var validChannelSortOrders = map[string]bool{
	"random":           true,
	"round_robin_tags": true,
	"in_order":         true,
}

func (s *Store) ListChannels(ctx context.Context, profileID int64) ([]Channel, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, profile_id, name, COALESCE(description, ''),
		       COALESCE(badge_text, ''), COALESCE(badge_color, ''),
		       sort_order, created_at, updated_at
		FROM channels WHERE profile_id = ? ORDER BY name COLLATE NOCASE`, profileID)
	if err != nil {
		return nil, err
	}
	var out []Channel
	for rows.Next() {
		var c Channel
		var ca, ua int64
		if err := rows.Scan(&c.ID, &c.ProfileID, &c.Name, &c.Description,
			&c.BadgeText, &c.BadgeColor, &c.SortOrder, &ca, &ua); err != nil {
			rows.Close()
			return nil, err
		}
		c.CreatedAt = time.Unix(ca, 0).UTC()
		c.UpdatedAt = time.Unix(ua, 0).UTC()
		out = append(out, c)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	// Load tags + items after the outer query closes - needed under
	// the in-memory MaxOpenConns=1 constraint, since per-channel
	// child queries would otherwise contend for the busy connection.
	for i := range out {
		out[i].TagIDs, _ = s.channelTags(ctx, out[i].ID)
		out[i].ItemIDs, _ = s.channelItems(ctx, out[i].ID)
	}
	return out, nil
}

func (s *Store) GetChannel(ctx context.Context, id int64) (*Channel, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT id, profile_id, name, COALESCE(description, ''),
		       COALESCE(badge_text, ''), COALESCE(badge_color, ''),
		       sort_order, created_at, updated_at
		FROM channels WHERE id = ?`, id)
	var c Channel
	var ca, ua int64
	if err := row.Scan(&c.ID, &c.ProfileID, &c.Name, &c.Description,
		&c.BadgeText, &c.BadgeColor, &c.SortOrder, &ca, &ua); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, sql.ErrNoRows
		}
		return nil, err
	}
	c.CreatedAt = time.Unix(ca, 0).UTC()
	c.UpdatedAt = time.Unix(ua, 0).UTC()
	c.TagIDs, _ = s.channelTags(ctx, id)
	c.ItemIDs, _ = s.channelItems(ctx, id)
	return &c, nil
}

func (s *Store) CreateChannel(ctx context.Context, c Channel) (*Channel, error) {
	if c.ProfileID <= 0 || c.Name == "" {
		return nil, errors.New("profileID + name required")
	}
	if c.SortOrder == "" {
		c.SortOrder = "random"
	}
	if !validChannelSortOrders[c.SortOrder] {
		return nil, fmt.Errorf("invalid sort_order %q", c.SortOrder)
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	now := time.Now().UTC().Unix()
	res, err := tx.ExecContext(ctx, `
		INSERT INTO channels (profile_id, name, description, badge_text, badge_color,
		    sort_order, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		c.ProfileID, c.Name, nullableString(c.Description),
		nullableString(c.BadgeText), nullableString(c.BadgeColor),
		c.SortOrder, now, now)
	if err != nil {
		return nil, err
	}
	id, _ := res.LastInsertId()
	if err := writeChannelTagsTx(ctx, tx, id, c.TagIDs); err != nil {
		return nil, err
	}
	if err := writeChannelItemsTx(ctx, tx, id, c.ItemIDs); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return s.GetChannel(ctx, id)
}

func (s *Store) UpdateChannel(ctx context.Context, id int64, c Channel) (*Channel, error) {
	if c.SortOrder == "" {
		c.SortOrder = "random"
	}
	if !validChannelSortOrders[c.SortOrder] {
		return nil, fmt.Errorf("invalid sort_order %q", c.SortOrder)
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	now := time.Now().UTC().Unix()
	if _, err := tx.ExecContext(ctx, `
		UPDATE channels SET name = ?, description = ?, badge_text = ?,
		       badge_color = ?, sort_order = ?, updated_at = ? WHERE id = ?`,
		c.Name, nullableString(c.Description), nullableString(c.BadgeText),
		nullableString(c.BadgeColor), c.SortOrder, now, id); err != nil {
		return nil, err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM channel_tags WHERE channel_id = ?`, id); err != nil {
		return nil, err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM channel_items WHERE channel_id = ?`, id); err != nil {
		return nil, err
	}
	if err := writeChannelTagsTx(ctx, tx, id, c.TagIDs); err != nil {
		return nil, err
	}
	if err := writeChannelItemsTx(ctx, tx, id, c.ItemIDs); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return s.GetChannel(ctx, id)
}

func (s *Store) DeleteChannel(ctx context.Context, id int64) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM channels WHERE id = ?`, id)
	return err
}

func (s *Store) channelTags(ctx context.Context, id int64) ([]int64, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT tag_id FROM channel_tags WHERE channel_id = ?`, id)
	if err != nil {
		return []int64{}, err
	}
	defer rows.Close()
	out := []int64{}
	for rows.Next() {
		var t int64
		if err := rows.Scan(&t); err != nil {
			return out, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

func (s *Store) channelItems(ctx context.Context, id int64) ([]string, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT jellyfin_item_id FROM channel_items WHERE channel_id = ? ORDER BY pinned_position NULLS LAST, jellyfin_item_id`, id)
	if err != nil {
		return []string{}, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var s string
		if err := rows.Scan(&s); err != nil {
			return out, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

func writeChannelTagsTx(ctx context.Context, tx *sql.Tx, channelID int64, tags []int64) error {
	if len(tags) == 0 {
		return nil
	}
	for _, t := range tags {
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO channel_tags (channel_id, tag_id) VALUES (?, ?)`,
			channelID, t); err != nil {
			return err
		}
	}
	return nil
}

func writeChannelItemsTx(ctx context.Context, tx *sql.Tx, channelID int64, items []string) error {
	for _, item := range items {
		item = strings.TrimSpace(item)
		if item == "" {
			continue
		}
		if _, err := tx.ExecContext(ctx,
			`INSERT OR IGNORE INTO channel_items (channel_id, jellyfin_item_id) VALUES (?, ?)`,
			channelID, item); err != nil {
			return err
		}
	}
	return nil
}

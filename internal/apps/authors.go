package apps

import (
	"context"
	"fmt"
	"sort"

	"github.com/21cloud/runtime-web/internal/authz"
	"github.com/21cloud/runtime-web/internal/runtime"
	"github.com/21cloud/runtime-web/internal/store/db"
)

// Author is the user who saved a version through the web.
type Author struct {
	UserID string `json:"user_id"`
	Name   string `json:"name"`
}

// Version is a version of an app as the web shows it. Author is nil for versions made outside the
// web. ETag is set only by calls that changed the live version.
type Version struct {
	Version      int                     `json:"version"`
	BuildState   string                  `json:"build_state"`
	Live         bool                    `json:"live"`
	SourceDigest string                  `json:"source_digest"`
	Failure      *runtime.VersionFailure `json:"failure"`
	Author       *Author                 `json:"author"`
	CreatedAt    int64                   `json:"created_at"`
	ETag         string                  `json:"etag,omitempty"`
}

// viewVersion maps a runtime version; live is the app's live version number.
func viewVersion(v runtime.Version, live int, author *Author) Version {
	return Version{
		Version: v.Version, BuildState: v.BuildState, Live: v.Version == live,
		SourceDigest: v.SourceDigest, Failure: v.Failure, Author: author, CreatedAt: v.CreatedAt,
	}
}

// Versions lists the app's versions, newest first, with their authors.
func (s *Service) Versions(ctx context.Context, sub authz.Subject, orgID, slug string) ([]Version, error) {
	app, cli, err := s.app(ctx, sub, orgID, slug, authz.AppRead)
	if err != nil {
		return nil, err
	}
	svc, _, err := cli.GetService(ctx, app.SvcID)
	if err != nil {
		return nil, mapErr("get app "+slug, err)
	}
	list, err := cli.ListVersions(ctx, app.SvcID)
	if err != nil {
		return nil, mapErr("list versions of "+slug, err)
	}
	rows, err := s.st.Q().ListVersionAuthors(ctx, db.ListVersionAuthorsParams{OrgID: orgID, ServiceID: app.SvcID})
	if err != nil {
		return nil, fmt.Errorf("apps: list version authors of %s: %w", slug, err)
	}
	authors := make(map[int]*Author, len(rows))
	for _, r := range rows {
		authors[int(r.Version)] = &Author{UserID: r.UserID, Name: r.Name}
	}
	live := 0
	if svc.LiveVersion != nil {
		live = *svc.LiveVersion
	}
	sort.SliceStable(list, func(i, j int) bool { return list[i].Version > list[j].Version })
	out := make([]Version, 0, len(list))
	for _, v := range list {
		out = append(out, viewVersion(v, live, authors[v.Version]))
	}
	return out, nil
}

// recordAuthor notes that userID saved version v of svc.
func (s *Service) recordAuthor(ctx context.Context, orgID, svcID string, v int, userID string) error {
	err := s.st.Q().UpsertVersionAuthor(ctx, db.UpsertVersionAuthorParams{
		OrgID: orgID, ServiceID: svcID, Version: int64(v), UserID: userID, CreatedAt: s.now().UnixMilli(),
	})
	if err != nil {
		return fmt.Errorf("apps: record author of v%d: %w", v, err)
	}
	return nil
}

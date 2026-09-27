package search

import (
	"context"

	"google.golang.org/api/customsearch/v1"
	"google.golang.org/api/option"
)

func legacyService(ctx context.Context, key string) (*customsearch.Service, error) {
	return customsearch.NewService(ctx, option.WithAPIKey(key))
}

// Moved to the bridge.

func service(ctx context.Context, key string) (*customsearch.Service, error) {
	return customsearch.NewService(ctx,
		option.WithAPIKey(key),
		option.WithEndpoint("http://localhost:8080/"),
	)
}

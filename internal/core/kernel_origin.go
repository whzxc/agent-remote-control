package core

import "context"

type originKey struct{}

func withOrigin(ctx context.Context, origin object) context.Context {
	return context.WithValue(ctx, originKey{}, origin)
}

func currentOrigin(ctx context.Context) object {
	if origin := obj(ctx.Value(originKey{})); origin != nil {
		return clone(origin)
	}
	return nil
}

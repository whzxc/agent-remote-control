package core

import (
	"context"
	"errors"
)

var injectAcceptanceFault func(context.Context, object) (any, error)
var checkAcceptanceRead func(string, any) error
var applyAcceptanceSnapshot func(string, object) object

func init() {
	registerOperation("acceptance_fault", func(ctx context.Context, request operationRequest) (any, error) {
		if injectAcceptanceFault == nil {
			return nil, acceptanceFaultUnavailable()
		}
		return injectAcceptanceFault(ctx, request.args)
	}, nil)
}

func acceptanceFaultUnavailable() error {
	return errors.New(`{"code":"ACCEPTANCE_FAULT_UNAVAILABLE","message":"Use the local CLI of npm run dev:isolated; production instances cannot inject faults"}`)
}

package core

import (
	"context"
	"errors"
	"fmt"
)

type operationRequest struct {
	name    string
	args    object
	source  requestSource
	service *service
	rpcID   any
}

type operationHandler func(context.Context, operationRequest) (any, error)

type registeredOperation struct {
	handle    operationHandler
	available func(requestSource) bool
}

var registeredOperations = make(map[string]registeredOperation)
var fixtureOperation func(operationRequest) (any, bool, error)

func registerOperation(name string, handler operationHandler, available func(requestSource) bool) {
	if handler == nil {
		panic(fmt.Sprintf("Control operation %s requires a handler", name))
	}
	if _, exists := registeredOperations[name]; exists {
		panic(fmt.Sprintf("Duplicate control operation %s", name))
	}
	registeredOperations[name] = registeredOperation{handler, available}
}

func operationAvailable(source requestSource, name string) bool {
	available := registeredOperations[name].available
	return policyAllows(source.policy, name) && (available == nil || available(source))
}

func executeOperation(ctx context.Context, request operationRequest) (any, error) {
	if fixtureOperation != nil {
		if value, present, err := fixtureOperation(request); present || err != nil {
			return value, err
		}
	}
	handler := registeredOperations[request.name].handle
	if handler == nil {
		return nil, errors.New(PortPending)
	}
	return handler(ctx, request)
}

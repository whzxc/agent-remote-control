package core

import (
	"context"
	"errors"
	"fmt"
	"strings"
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
var fallbackOperations = make(map[string]operationHandler)
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

func registerOperationFallback(name string, handler operationHandler) {
	if handler == nil || fallbackOperations[name] != nil {
		panic(fmt.Sprintf("Invalid or duplicate fallback operation %s", name))
	}
	fallbackOperations[name] = handler
}

type operationObserver func(context.Context, operationRequest, any, error)
type operationProjection func(context.Context, operationRequest, object) error
type operationPreparation func(context.Context, operationRequest) operationProjection

var operationObservers []operationObserver
var operationPreparations = make(map[string][]operationPreparation)
var operationProjections = make(map[string][]operationProjection)

func registerOperationObserver(observe operationObserver) {
	operationObservers = append(operationObservers, observe)
}

func registerOperationPreparation(op string, prepare operationPreparation) {
	operationPreparations[op] = append(operationPreparations[op], prepare)
}

func registerOperationProjection(op string, project operationProjection) {
	operationProjections[op] = append(operationProjections[op], project)
}

func operationAvailable(source requestSource, name string) bool {
	return policyAllows(source.policy, name) && operationFeatureAvailable(source, name)
}

func operationFeatureAvailable(source requestSource, name string) bool {
	if name == "agents" || strings.HasPrefix(name, "agent_") && name != "agent_archive" {
		agents := registeredOperations["agents"]
		if agents.handle == nil && fallbackOperations["agents"] == nil || agents.available != nil && !agents.available(source) {
			return false
		}
		if name == "agents" {
			return true
		}
	}
	available := registeredOperations[name].available
	return available == nil || available(source)
}

func executeOperation(ctx context.Context, request operationRequest) (any, error) {
	if fixtureOperation != nil {
		if value, present, err := fixtureOperation(request); present || err != nil {
			return value, err
		}
	}
	handler := registeredOperations[request.name].handle
	if handler == nil {
		handler = fallbackOperations[request.name]
	}
	if handler == nil {
		return nil, errors.New(PortPending)
	}
	ctx = runtimeOperationCost(ctx, request.name)
	var projections []operationProjection
	for _, prepare := range operationPreparations[request.name] {
		if project := prepare(ctx, request); project != nil {
			projections = append(projections, project)
		}
	}
	value, err := handler(ctx, request)
	for _, observe := range operationObservers {
		observe(ctx, request, value, err)
	}
	if row := obj(value); err == nil && row != nil {
		for _, project := range append(projections, operationProjections[request.name]...) {
			if err := project(ctx, request, row); err != nil {
				return nil, err
			}
		}
	}
	return value, err
}

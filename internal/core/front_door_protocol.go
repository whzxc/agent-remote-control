package core

import (
	"encoding/binary"
	"errors"
	"io"
	"math"
	"time"

	"github.com/whzxc/agent-remote-control/internal/canonjson"
)

const frontDoorVersion = 3
const maxRequestBytes = 36 * 1024 * 1024
const maxFrameBytes = 64 * 1024 * 1024
const maxInFlight = 128
const maxQueued = 64
const maxQueueBytes = 64 * 1024 * 1024
const drainTimeout = 5 * time.Second

const frontDoorFrameTooLarge = "FRONT_DOOR_FRAME_TOO_LARGE: Reduce the request or read a smaller result page."
const frontDoorDeadlineExpired = "FRONT_DOOR_DEADLINE_EXPIRED: Read current state before retrying a write."
const frontDoorStaleGeneration = "FRONT_DOOR_STALE_GENERATION: Response discarded; read current state before retrying a write."

type generation [16]byte

func (g generation) MarshalJSON() ([]byte, error) {
	var values [16]uint16
	for i, v := range g {
		values[i] = uint16(v)
	}
	return canonjson.Marshal(values)
}

func (g *generation) UnmarshalJSON(data []byte) error {
	var values []uint16
	if err := canonjson.Unmarshal(data, &values); err != nil {
		return err
	}
	if len(values) != len(g) || len(data) == 0 || data[0] != '[' {
		return errors.New("FRONT_DOOR_INVALID_GENERATION")
	}
	for i, value := range values {
		if value > 255 {
			return errors.New("FRONT_DOOR_INVALID_GENERATION")
		}
		g[i] = byte(value)
	}
	return nil
}

type frontDoorHello struct {
	Version         uint16     `json:"version"`
	Generation      generation `json:"generation"`
	Readiness       string     `json:"readiness"`
	MaxRequestBytes int        `json:"max_request_bytes"`
	MaxFrameBytes   int        `json:"max_frame_bytes"`
}

type frontDoorDeadline struct {
	UnixMS uint64 `json:"unix_ms"`
}

func afterDeadline(duration time.Duration) frontDoorDeadline {
	return frontDoorDeadline{uint64(time.Now().Add(duration).UnixMilli())}
}

func (d frontDoorDeadline) remaining() (time.Duration, error) {
	nowMS := uint64(time.Now().UnixMilli())
	if d.UnixMS <= nowMS {
		return 0, errors.New(frontDoorDeadlineExpired)
	}
	return time.Duration(min(d.UnixMS-nowMS, math.MaxInt64/uint64(time.Millisecond))) * time.Millisecond, nil
}

type frontDoorContext struct {
	Authority any `json:"authority"`
}

type privatePeerAuthority struct {
	DeviceID string `json:"device_id"`
}

type privateBrowserAuthority struct {
	IngressID string `json:"ingress_id"`
	KeyDigest string `json:"key_digest"`
}

type privateMCPAuthority struct {
	IngressID  string `json:"ingress_id"`
	SourceID   string `json:"source_id"`
	Credential any    `json:"credential"`
	Origin     any    `json:"origin"`
}

type frontDoorRequest struct {
	Version    uint16            `json:"version"`
	Generation generation        `json:"generation"`
	ID         string            `json:"id"`
	Deadline   frontDoorDeadline `json:"deadline"`
	Context    frontDoorContext  `json:"context"`
	Operation  any               `json:"operation"`
	Body       any               `json:"body"`
}

type frontDoorResponse struct {
	Generation generation `json:"generation"`
	RequestID  string     `json:"request_id"`
	Body       object     `json:"body"`
}

type frontDoorStream struct {
	Generation generation `json:"generation"`
	RequestID  string     `json:"request_id"`
	Sequence   uint64     `json:"sequence"`
	Body       any        `json:"body"`
}

type frontDoorCancellation struct {
	Generation generation `json:"generation"`
	RequestID  string     `json:"request_id"`
}

type frontDoorDrainAck struct {
	Generation  generation `json:"generation"`
	Outstanding int        `json:"outstanding"`
}

func generationFence(current, tagged generation) error {
	if current != tagged {
		return errors.New(frontDoorStaleGeneration)
	}
	return nil
}

func boundedPrivateJSON(value any, limit int) ([]byte, error) {
	data, err := canonjson.Marshal(value)
	if err != nil {
		return nil, err
	}
	if len(data) > limit {
		return nil, errors.New(frontDoorFrameTooLarge)
	}
	return data, nil
}

func validatePrivateResponse(request frontDoorRequest, response frontDoorResponse) error {
	if err := generationFence(request.Generation, response.Generation); err != nil {
		return err
	}
	if response.RequestID != request.ID {
		return errors.New("FRONT_DOOR_REQUEST_MISMATCH")
	}
	_, err := request.Deadline.remaining()
	return err
}

func writeFrame(output io.Writer, value any) error {
	data, err := boundedPrivateJSON(value, maxFrameBytes)
	if err != nil {
		return err
	}
	var header [4]byte
	binary.BigEndian.PutUint32(header[:], uint32(len(data)))
	for _, part := range [][]byte{header[:], data} {
		written, err := output.Write(part)
		if err != nil {
			return err
		}
		if written != len(part) {
			return io.ErrShortWrite
		}
	}
	return nil
}

func readFrame(input io.Reader, limit uint32, value any) error {
	var header [4]byte
	if _, err := io.ReadFull(input, header[:]); err != nil {
		return err
	}
	size := binary.BigEndian.Uint32(header[:])
	if size > limit {
		return errors.New(frontDoorFrameTooLarge)
	}
	data := make([]byte, size)
	if _, err := io.ReadFull(input, data); err != nil {
		return err
	}
	return canonjson.Unmarshal(data, value)
}

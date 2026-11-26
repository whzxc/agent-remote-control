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

func writeFrame(output io.Writer, value any) error {
	data, err := canonjson.Marshal(value)
	if err != nil {
		return err
	}
	if len(data) > maxFrameBytes {
		return errors.New(frontDoorFrameTooLarge)
	}
	var header [4]byte
	binary.BigEndian.PutUint32(header[:], uint32(len(data)))
	if _, err := output.Write(header[:]); err != nil {
		return err
	}
	_, err = output.Write(data)
	return err
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

package core

import (
	"errors"
	"maps"
	"os"
	"path/filepath"
	"slices"

	"github.com/whzxc/agent-remote-control/internal/canonjson"
)

const deviceForwardCap = 1024
const deviceTaskCap = 4096

type deviceForwardRecord struct {
	RequestID    string `json:"requestId"`
	DeviceID     string `json:"deviceId"`
	Op           string `json:"op"`
	SourceID     string `json:"sourceId"`
	SentAt       string `json:"sentAt"`
	Outcome      string `json:"outcome"`
	Digest       string `json:"digest"`
	Notification any    `json:"notification"`
}

type deviceTaskAssociation struct {
	DeviceID string `json:"deviceId"`
	TaskID   string `json:"taskId"`
	SourceID string `json:"sourceId"`
}

type deviceRecords struct {
	Forwards  []deviceForwardRecord   `json:"forwards"`
	Tasks     []deviceTaskAssociation `json:"tasks"`
	LastSeen  map[string]string       `json:"lastSeen"`
	Facts     map[string]object       `json:"facts"`
	taskIndex map[[2]string]string
}

func openDeviceRecords(directory string) (deviceRecords, error) {
	records := deviceRecords{
		Forwards: []deviceForwardRecord{}, Tasks: []deviceTaskAssociation{},
		LastSeen: map[string]string{}, Facts: map[string]object{}, taskIndex: map[[2]string]string{},
	}
	data, err := os.ReadFile(filepath.Join(directory, "controller.json"))
	if errors.Is(err, os.ErrNotExist) {
		return records, nil
	}
	if err != nil {
		return records, err
	}
	if err := canonjson.Unmarshal(data, &records); err != nil {
		return records, err
	}
	if records.Forwards == nil || records.Tasks == nil || records.LastSeen == nil || records.Facts == nil {
		return records, errors.New("invalid device controller records")
	}
	for _, item := range records.Tasks {
		records.taskIndex[[2]string{item.DeviceID, item.TaskID}] = item.SourceID
	}
	return records, nil
}

func (records deviceRecords) save(directory string) error {
	var value any
	if err := canonjson.Unmarshal([]byte(wire(records)), &value); err != nil {
		return err
	}
	return save(filepath.Join(directory, "controller.json"), value)
}

func (records deviceRecords) clone() deviceRecords {
	records.Forwards = slices.Clone(records.Forwards)
	records.Tasks = slices.Clone(records.Tasks)
	records.LastSeen = maps.Clone(records.LastSeen)
	records.Facts = maps.Clone(records.Facts)
	records.taskIndex = maps.Clone(records.taskIndex)
	return records
}

func (records *deviceRecords) record(entry deviceForwardRecord) {
	if len(records.Forwards) >= deviceForwardCap {
		records.Forwards = records.Forwards[len(records.Forwards)-deviceForwardCap+1:]
	}
	records.Forwards = append(records.Forwards, entry)
}

func (records *deviceRecords) forward(request string) *deviceForwardRecord {
	for index := range records.Forwards {
		if records.Forwards[index].RequestID == request {
			return &records.Forwards[index]
		}
	}
	return nil
}

func (records *deviceRecords) taskSource(device, task string) (string, bool) {
	source, known := records.taskIndex[[2]string{device, task}]
	return source, known
}

func (records *deviceRecords) associateReceipt(device, request string, value any) bool {
	for _, forward := range records.Forwards {
		if forward.DeviceID == device && forward.RequestID == request {
			return records.associate(device, forward.SourceID, value)
		}
	}
	return false
}

func (records *deviceRecords) associate(device, source string, value any) bool {
	changed := false
	for _, task := range deviceResultTasks(value, 0) {
		if _, known := records.taskSource(device, task); known {
			continue
		}
		for len(records.Tasks) >= deviceTaskCap {
			old := records.Tasks[0]
			delete(records.taskIndex, [2]string{old.DeviceID, old.TaskID})
			records.Tasks = records.Tasks[1:]
		}
		records.Tasks = append(records.Tasks, deviceTaskAssociation{device, task, source})
		records.taskIndex[[2]string{device, task}] = source
		changed = true
	}
	return changed
}

func deviceResultTasks(value any, depth int) []string {
	if depth > 5 {
		return nil
	}
	var tasks []string
	for _, key := range []string{"threadId", "taskId"} {
		if task, ok := field(value, key).(string); ok {
			tasks = append(tasks, task)
		}
	}
	for _, key := range []string{"thread", "task"} {
		if task, ok := field(field(value, key), "id").(string); ok {
			tasks = append(tasks, task)
		}
	}
	for _, key := range []string{"result", "receipt"} {
		if item := obj(field(value, key)); item != nil {
			tasks = append(tasks, deviceResultTasks(item, depth+1)...)
		}
	}
	return tasks
}

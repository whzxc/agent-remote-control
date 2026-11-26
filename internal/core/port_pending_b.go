package core

// Keep discovery for the coordination segment until it registers its handlers.
func init() {
	registerManagementCatalog(func(result object) {
		ops := arr(result["operations"])
		for _, op := range []string{"events", "board", "notice_post", "notice_update", "notice_close", "blocker_open", "blocker_clear", "ax_list"} {
			spec := operation(op)
			ops = append(ops, object{"name": "coordination." + op, "method": "POST", "route": "coordination/" + op, "localOnly": true, "description": spec["description"],
				"inputSchema": object{"type": "object", "required": []any{"body"}, "properties": object{"body": spec["inputSchema"]}, "additionalProperties": false}})
		}
		ops = append(ops, object{"name": "coordination.resources", "method": "GET", "route": "coordination/resources", "localOnly": true,
			"description": "Read cached registered project identities without discovery or upstream requests.",
			"inputSchema": object{"type": "object", "properties": object{}, "additionalProperties": false}})
		result["operations"] = ops
	})
}

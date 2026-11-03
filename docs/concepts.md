# How ARC fits together

**English** | [简体中文](zh-CN/concepts.md)

```text
Claude / ChatGPT / other clients
           │
  ingress A      ingress B       authentication + allowed ops
           └──────┬──────┘
                Core             shared projects and tasks
          ┌───────┴────────┐
    Codex Desktop     background Agents
```

## Control source

The app where you ask for work: Claude, ChatGPT, or another MCP client. Add more than one source, or several connections for the same app. A source name labels a connection; it is not a user account.

## Ingress

One connection into ARC. It has its own transport, authentication, allowed ops, and start/stop controls. Claude normally uses HTTPS + OAuth; ChatGPT defaults to OpenAI Secure Tunnel. Stopping one ingress leaves the others running.

## Core

The local service that reads project facts and dispatches work. All ingresses for the same ARC instance share its projects and task namespace. Closing the ARC window keeps the connection available through the menu bar or tray.

## Agent

The program doing the work on your computer. Codex uses its native task interfaces. Antigravity, Pi, and ACP Agents use their own installed programs, configuration, and login. Enable additional Agents in the home screen's Agent management panel.

## Task ownership

Antigravity and Pi run in ARC-owned native processes, separate from Codex task
ownership. ARC returns its own `taskId` and `turnId`; keep both for
`agent_wait`, then use `agent_read` for the durable task record. Native login,
configuration, and upstream session IDs remain owned by the Agent.

With **Automatically open Codex tasks** enabled, new Codex tasks execute in Codex Desktop. With it disabled, new tasks execute in ARC's background App Server. Existing tasks retain their owner. On Linux, Codex runs in the background. A task receipt confirms dispatch; read or wait for the task to see the outcome.

## Pending requests

The control source handles ARC-side decisions. If you are watching an open task
in the focused ARC window, its request dock waits 15 seconds before handing a new
request to the source. Change the delay in Settings (0–300 seconds). You can answer
on the spot; focusing an input, choosing an option or typing pauses the countdown.
Use Resume or Hand off now when ready. Leaving the task ends a running countdown.

With no verified push path, the dock shows that the source will handle the request
at its next check. The source can read and answer at any time, even during the
countdown. The first answer wins. Restarting ARC cancels remaining routing delays.

## Operation levels

Choose **Default**, **Read-only**, **All**, or **Custom** in the connection editor. Default covers project facts and everyday Codex work. All adds advanced operations. Custom selects individual ops. Read-only supports inspection, with connection verification as its maintenance exception. See [Operations](reference/tools.md).

## Limits

The three MCP tools are always guide / query / act. Operation levels control the guide index and which ops a connection can call, not an Agent's operating-system permissions. Connections share tasks; separate ingresses are not separate user workspaces. Quitting the last Core client stops ARC-owned background processes. Desktop-owned Codex tasks keep their Desktop lifecycle.

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

The program doing the work on your computer. Codex uses its native task interfaces. Pi and ACP Agents use their own installed programs, configuration, and login. Enable additional Agents in the home screen's Agent management panel.

## Task ownership

With **Automatically open Codex tasks** enabled, new Codex tasks execute in Codex Desktop. With it disabled, new tasks execute in ARC's background App Server. Existing tasks retain their owner. On Linux, Codex runs in the background. A task receipt confirms dispatch; read or wait for the task to see the outcome.

## Operation levels

Choose **Default**, **Read-only**, **All**, or **Custom** in the connection editor. Default covers project facts and everyday Codex work. All adds advanced operations. Custom selects individual ops. Read-only supports inspection, with connection verification as its maintenance exception. See [Operations](reference/tools.md).

## Limits

The three MCP tools are always guide / query / act. Operation levels control the guide index and which ops a connection can call, not an Agent's operating-system permissions. Connections share tasks; separate ingresses are not separate user workspaces. Quitting the last Core client stops ARC-owned background processes. Desktop-owned Codex tasks keep their Desktop lifecycle.

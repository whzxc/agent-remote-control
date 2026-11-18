# When Codex got stuck, ARC helped bring the client back

**English** | [简体中文](../zh-CN/stories/codex-client-login-recovery.md)

*November 18, 2026. A client login recovery that started in a browser conversation.*

When something goes wrong on my computer, I usually turn to Codex first. Checking logs, looking through settings, running commands: a lot of the troubleshooting can happen right in the conversation.

This time, the ChatGPT Windows client I normally use to run Codex was the thing that broke.

I opened it and got one message:

> Unable to load account information. Please check your network connection and try again.

Restarting the client and clicking “Retry” changed nothing.

That left me in an awkward spot. The tool I usually relied on to fix computer problems could no longer reach its own main screen.

Fortunately, the web version worked fine on the same computer. I sent the screenshot from there and explained that the browser was working: we were having this conversation on the very machine with the problem.

I originally just wanted help figuring out the cause. As the conversation continued, we actually got the client working again. ARC played a big part in that.

## The client was stuck, but the computer was still reachable

This was the key: even with the desktop login failing, ARC still provided a way to inspect the computer and run commands.

Through ARC, the assistant checked processes and client logs, then found more specific errors in the local log database. It also verified that those records came from the local service started by the desktop client. That kept the results of a separate account check from being mistaken for the cause of this failure.

The vague “check your network” message became two concrete clues:

| Check | Actual result | What it established |
| --- | --- | --- |
| The desktop client's model list request | `401 Unauthorized`, `token_expired` | The current access token had expired |
| The automatic credential refresh request | `400 Bad Request`, `Failed to refresh token` | The client had failed to obtain fresh credentials |

That narrowed things down. The old credentials had expired, the automatic refresh had failed, and the account information could not load.

The working browser session was consistent with that finding. The browser was still signed in, while authentication in the desktop client was stuck.

The available evidence did not establish why the refresh request returned `400`. What it did confirm was this sequence of authentication failures.

ARC also had a brief connection timeout along the way. Once the connection recovered, the investigation continued until there was enough evidence to choose the next step.

## Signing in again, then one last step

The next task was to get valid login credentials back into the client.

The error page offered only a “Retry” button, so the normal account controls were out of reach. The assistant checked the installed client and the native credential storage it used, found the login program bundled with that installation, and ran `codex login` to start the official browser authorization flow.

I then completed the account authorization in the browser through the official sign-in flow. The [Codex authentication documentation](https://learn.chatgpt.com/docs/auth) describes this browser login method, and the [Windows documentation](https://learn.chatgpt.com/docs/windows/windows-app) explains that the desktop app and native Windows Codex share the local Codex home directory by default. This recovery route was chosen after checking the actual configuration on this computer.

The login program then reported:

```text
Successfully logged in
```

Further checks showed that the desktop client had detected the new authentication information. The same model list endpoint that had been failing now returned `200 OK`.

But the window was still showing the old error page.

That detail mattered. Authentication had recovered in the background, but the interface had not caught up. So the desktop client was restarted once more.

This time, the project list, model selector, and input box all came back.

| Recovery check | Observed result |
| --- | --- |
| Official authorization | The login program reported success |
| Protected endpoint | The previously failing model list request returned `200 OK` |
| Actual application window | The normal main interface appeared after the restart |

Only then was the recovery complete. The authorization result, the API response, and the visible interface all agreed.

## This is why I wanted to give ARC some credit

When a tool works well day after day, it is easy to overlook a question: who do I turn to when the tool that helps me troubleshoot gets stuck itself?

This time, I could still talk to the assistant in the browser, and ARC could still reach the computer. Reading logs, carrying out the recovery, restarting the client, and checking the result could all continue.

I explained what I was seeing and completed the account authorization in the browser. The assistant handled the other checks and recovery steps, following the actual processes and logs and using ARC to carry out the necessary operations on the machine. Even after the successful login message, it went back to the endpoint and the application window to check whether the client had really recovered.

That made a practical difference.

There were conditions that made this recovery possible: the computer was still reachable, ARC's reading and execution capabilities could still work, and signing in again was enough to resolve the login problem. When I needed that route, it was there and it helped.

Usually, I ask Codex to help fix something on my computer. This time, ARC helped bring back the client I use to do the fixing.

That deserves some credit.

---

This account was compiled from the conversation and local diagnostic records. Technical evidence has been sanitized. Recovery was verified for sign-in, the protected endpoint, and the desktop client's main interface; no additional test conversation was sent at the time. The recovery route described here applied to this installation and configuration.

To learn how ARC connects a browser conversation to a local computer, start with [Connect to ChatGPT](../guides/chatgpt.md) and [Getting Started](../getting-started.md).

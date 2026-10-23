# kimo-alexa friction log (Alexa+ MCP Toolkit)

## Friction log entry 1: Long-running tool inside a voice turn

* **Task attempted:** Let Alexa+ render a 60-second reel ("make a one-minute reel of Saturday's trip") through an MCP tool call.
* **Steps taken:** Implemented `render` as an MCP tool that calls kimo's `export`; read the Alexa+ MCP QuickStart performance section; added `notifications/progress` streamed over the POST's SSE response; tested from my simulator and curl.
* **Expected:** Guidance on how Alexa+ handles a tool that takes a minute or more (progress, async completion, or a follow-up notification).
* **Actual:** The QuickStart only states "Your MCP server must meet a round-trip query response latency of less than 500 ms." Nothing on progress notifications or async/task results. A real render takes about 90 to 180 s on my machine.
* **Severity:** High (blocks a whole class of media add-ons).
* **Workaround used:** In the simulator the tool call stays open and streams progress over SSE; the planner waits for it. For production I plan to return a job immediately and let a later turn ("is it ready?") or a notification pick up the result.
* **Actionable suggestion:** Document Alexa+'s timeout per tool call, whether it surfaces `notifications/progress`, and support MCP task-style async results, with an example for a long-running media job.

## Friction log entry 2: Which protocol version does Alexa+ really speak?

* **Task attempted:** Make sure my server negotiates the protocol version Alexa+ sends on `initialize`.
* **Steps taken:** Read the MCP Toolkit Overview ("Alexa+ for Builders supports the 2025-11-25 version of the MCP specification") and the Client and App Lifecycle page (sample initialize request/response); configured the server to answer 2025-11-25 and also accept older versions.
* **Expected:** The lifecycle samples to use 2025-11-25, matching the overview and the hackathon rule.
* **Actual:** The lifecycle sample `initialize` response shows `"protocolVersion": "2025-03-26"`, so the docs disagree about the version on the wire.
* **Severity:** Medium (confusing; a server pinned strictly to 2025-11-25 might reject a client that sends an older version).
* **Workaround used:** Kept the SDK's version negotiation (answers 2025-11-25 when asked, falls back to older supported versions) and verified 2025-11-25 end to end with curl and my own client.
* **Actionable suggestion:** Update the lifecycle samples to 2025-11-25 and state explicitly which `protocolVersion` Alexa+ sends in `initialize` and which `MCP-Protocol-Version` header values it sends on later requests.

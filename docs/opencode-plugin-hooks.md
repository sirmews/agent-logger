# OpenCode Plugin Hooks — Canonical Reference

> Source of truth: [`anomalyco/opencode`](https://github.com/anomalyco/opencode) (the active TypeScript monorepo behind `@opencode-ai/plugin`). The older `opencode-ai/opencode` Go repository is a separate, unrelated implementation with no plugin system.
>
> Verified against `@opencode-ai/plugin` v1.14.x. If you bump the dependency, re-verify against the upstream source.

This document captures the complete set of plugin extension points exposed by OpenCode, the difference between the two delivery mechanisms, and the exact payload shapes — including the things that look like hooks but are actually bus events. It exists because several of the names that intuitively look like hooks (`session.created`, `session.idle`, `permission.replied`, …) are **not** trigger hooks at all, and writing handlers for them is dead code.

---

## 1. Two delivery mechanisms

OpenCode delivers extension points to plugins through two strictly separate paths.

### 1a. The `event` hook — passive, read-only bus fan-out

Every event published on OpenCode's internal bus is forwarded to the plugin's `event` hook. The plugin **cannot mutate** anything here; the return value is ignored.

Wired in [`packages/opencode/src/plugin/index.ts` L244–L253](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/plugin/index.ts#L244-L253):

```ts
yield* bus.subscribeAll().pipe(
  Stream.runForEach((input) =>
    Effect.sync(() => {
      for (const hook of hooks) {
        void hook["event"]?.({ event: input as any })
      }
    }),
  ),
  Effect.forkScoped,
)
```

Use this when you want to **observe** what is happening (lifecycle, status changes, file edits, permission replies, …).

### 1b. Named trigger hooks — `(input, output) => Promise<void>`, mutable

Each named hook receives a mutable `output` object. The caller passes it in, every plugin's hook runs and may modify it, then the caller reads it back. This is how plugins **intercept and override** behaviour (e.g. change LLM params, redirect a permission decision, transform tool args).

Defined in [`packages/plugin/src/index.ts` L222–L333](https://github.com/anomalyco/opencode/blob/main/packages/plugin/src/index.ts#L222-L333) and dispatched via `Plugin.trigger()` in [`packages/opencode/src/plugin/index.ts` L259–L272](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/plugin/index.ts#L259-L272).

> **Rule of thumb:** if you only need to *know* something happened, use `event`. If you need to *change* what happens, use the named trigger hook (if one exists for that point).

---

## 2. Complete list of named trigger hooks

These are the only string keys OpenCode looks up on the object returned by your plugin. Anything else you put on that object is ignored.

| Hook name | Purpose |
|---|---|
| `event` | All bus events (read-only fan-out) — see §3 below |
| `config` | Loaded config object |
| `tool` | Register custom tools (an object map, not a function) |
| `auth` | Register auth methods |
| `provider` | Register custom model providers |
| `chat.message` | Incoming **user** message parts (before save) |
| `chat.params` | LLM call parameters (`temperature`, `topP`, `topK`, `maxOutputTokens`, `options`) |
| `chat.headers` | HTTP headers sent to the LLM provider |
| `permission.ask` | Permission decisions — can override `allow` / `deny` / `ask` |
| `command.execute.before` | Parts injected when a slash-command fires |
| `tool.execute.before` | Tool input `args` before execution |
| `shell.env` | Env variables injected into shell calls |
| `tool.execute.after` | Tool `output` / `title` / `metadata` after execution |
| `experimental.chat.messages.transform` | Full message history before LLM call |
| `experimental.chat.system.transform` | System prompt strings before LLM call |
| `experimental.session.compacting` | Compaction prompt / context |
| `experimental.compaction.autocontinue` | Whether to auto-continue after compaction |
| `experimental.text.complete` | Completed text for a specific part |
| `tool.definition` | Tool description / parameters sent to LLM |

The TypeScript interface is in [`packages/plugin/src/index.ts` L222–L333](https://github.com/anomalyco/opencode/blob/main/packages/plugin/src/index.ts#L222-L333).

---

## 3. Bus events (use the `event` hook to observe)

All session-lifecycle, message/turn, file, command, permission, todo, PTY, MCP, LSP, VCS, project, installation, workspace and IDE notifications are **bus events**, not trigger hooks. To react to them, register an `event` handler and switch on `event.type`. Each event payload delivered to your callback has the shape `{ type: string, properties: <schema> }`.

> **`SyncEvent` vs. `BusEvent`.** Several "core" message/session events are declared as `SyncEvent.define(...)`, but `SyncEvent.run()` calls `ProjectBus.publish()` internally and re-registers them as `BusEvent` at init time (see [`sync/index.ts` L71](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/sync/index.ts#L71) and [L163-L168](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/sync/index.ts#L163-L168)). So they all show up in `event` callbacks the same way.

### 3a. Message / turn lifecycle

These are the events you will see during a normal user→assistant turn.

| Event type | Defined in | Properties |
|---|---|---|
| `message.updated` | [`message-v2.ts` L607–612](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/session/message-v2.ts#L607-L612) | `{ sessionID, info: UserMessage \| AssistantMessage }` |
| `message.removed` | [`message-v2.ts` L613–618](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/session/message-v2.ts#L613-L618) | `{ sessionID, messageID }` |
| `message.part.updated` | [`message-v2.ts` L619–624](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/session/message-v2.ts#L619-L624) | `{ sessionID, part: Part, time: number }` |
| `message.part.delta` | [`message-v2.ts` L625–634](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/session/message-v2.ts#L625-L634) | `{ sessionID, messageID, partID, field: string, delta: string }` — high-frequency streaming chunks |
| `message.part.removed` | [`message-v2.ts` L635–640](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/session/message-v2.ts#L635-L640) | `{ sessionID, messageID, partID }` |

**`UserMessage`** carries: `{ id, sessionID, role: "user", time: { created }, format?, summary?, agent, model: { providerID, modelID, variant? }, system?, tools? }`.

**`AssistantMessage`** carries: `{ id, sessionID, role: "assistant", time: { created, completed? }, error?, parentID, modelID, providerID, mode, agent, path: { cwd, root }, summary?, cost, tokens: { total?, input, output, reasoning, cache: { read, write } }, structured?, variant?, finish? }`.

> ⭐ **Assistant turn completion signal.** Watch `message.updated` for `info.role === "assistant"` and `info.finish != null` (and/or `info.time.completed != null`). At that moment all parts have been written and `cost`/`tokens` are final.

**`Part`** is a discriminated union on `type` ([L406-L448](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/session/message-v2.ts#L406-L448)). All parts share `{ id, sessionID, messageID }`. Key variants:

| `type` | Notable extra fields |
|---|---|
| `"text"` | `text`, `synthetic?`, `ignored?`, `time?: { start, end? }`, `metadata?` |
| `"reasoning"` | `text`, `time: { start, end? }`, `metadata?` |
| `"tool"` | `callID`, `tool`, `state: ToolState`, `metadata?` |
| `"step-start"` | `snapshot?` |
| `"step-finish"` | `reason`, `cost`, `tokens`, `snapshot?` |
| `"file"` | `mime`, `url`, `filename?`, `source?` |
| `"agent"` | `name`, `source?` |
| `"subtask"` | `prompt`, `description`, `agent`, `model?`, `command?` |
| `"retry"` | `attempt`, `error`, `time: { created }` |
| `"snapshot"` | `snapshot` |
| `"patch"` | `hash`, `files` |
| `"compaction"` | `auto`, `overflow?`, `tail_start_id?` |

**`ToolState`** is discriminated on `status` ([L310-L325 and around](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/session/message-v2.ts#L310-L325)):

```ts
{ status: "pending",   input, raw }
{ status: "running",   input, title?, metadata?, time: { start } }
{ status: "completed", input, output, title, metadata, time: { start, end, compacted? }, attachments? }
{ status: "error",     input, error: string, metadata?, time: { start, end } }
```

> Use `message.part.updated` with `part.type === "tool"` as the **canonical** trajectory source. The `tool.execute.before` / `tool.execute.after` trigger hooks are still useful for *interception*, but the part stream gives you the authoritative final state.

### 3b. Session lifecycle

| Event type | Defined in | Properties |
|---|---|---|
| `session.created` | [`session.ts` L264–269](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/session/session.ts#L264-L269) | `{ sessionID, info: Session.Info }` |
| `session.updated` | [`session.ts` L270–276](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/session/session.ts#L270-L276) | `{ sessionID, info: Session.Info }` |
| `session.deleted` | [`session.ts` L277–283](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/session/session.ts#L277-L283) | `{ sessionID, info: Session.Info }` |
| `session.diff` | [`session.ts` L283–289](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/session/session.ts#L283-L289) | `{ sessionID, diff: FileDiff[] }` |
| `session.error` | [`session.ts` L290–298](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/session/session.ts#L290-L298) | `{ sessionID?, error?: AssistantError }` |
| `session.status` | [`status.ts` L29–35](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/session/status.ts#L29-L35) | `{ sessionID, status: { type: "idle" } \| { type: "busy" } \| { type: "retry", attempt, message, next } }` |
| `session.idle` | [`status.ts` L37–43](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/session/status.ts#L37-L43) | `{ sessionID }` — **deprecated**, prefer `session.status` with `status.type === "idle"` |
| `session.compacted` | [`compaction.ts` L25–30](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/session/compaction.ts#L25-L30) | `{ sessionID }` |

> `session.compacted` is a notification only — it does **not** carry message counts. If you need before/after metrics, snapshot them yourself around `experimental.session.compacting`.

### 3c. Permissions / questions

| Event type | Defined in | Properties |
|---|---|---|
| `permission.asked` | [`permission/index.ts` L78](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/permission/index.ts#L78) | `{ id, sessionID, permission: string, patterns: string[], metadata, always: string[], tool?: { messageID, callID } }` |
| `permission.replied` | [`permission/index.ts` L79–86](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/permission/index.ts#L79-L86) | `{ sessionID, requestID, reply: "once" \| "always" \| "reject" }` |
| `question.asked` | [`question/index.ts` L97](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/question/index.ts#L97) | `{ id, sessionID, questions: [...], tool?: { messageID, callID } }` |
| `question.replied` | [`question/index.ts` L98](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/question/index.ts#L98) | `{ sessionID, requestID, answers: string[][] }` |
| `question.rejected` | [`question/index.ts` L99](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/question/index.ts#L99) | `{ sessionID, requestID }` |

> The trigger hook **`permission.ask`** (no "ed") *overrides* the decision. Bus events only let you *observe*. There is no `permission.replied` trigger hook.

### 3d. Files

| Event type | Defined in | Properties |
|---|---|---|
| `file.edited` | [`file/index.ts` L71–76](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/file/index.ts#L71-L76) | `{ file: string }` *(relative path; **no `sessionID`** in payload)* |
| `file.watcher.updated` | [`file/watcher.ts` L26–33](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/file/watcher.ts#L26-L33) | `{ file: string, event: "add" \| "change" \| "unlink" }` |

### 3e. Commands

| Event type | Defined in | Properties |
|---|---|---|
| `command.executed` | [`command/index.ts` L21–29](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/command/index.ts#L21-L29) | `{ name, sessionID, arguments: string, messageID }` |

### 3f. Todos

| Event type | Defined in | Properties |
|---|---|---|
| `todo.updated` | [`session/todo.ts` L25–32](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/session/todo.ts#L25-L32) | `{ sessionID, todos: Array<{ content, status, priority }> }` |

### 3g. PTY (shell) events

| Event type | Defined in | Properties |
|---|---|---|
| `pty.created` | [`pty/index.ts` L94–99](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/pty/index.ts#L94-L99) | `{ info: PtyInfo }` |
| `pty.updated` | same | `{ info: PtyInfo }` |
| `pty.exited` | same | `{ id, exitCode }` |
| `pty.deleted` | same | `{ id }` |

`PtyInfo` = `{ id, title, command, args: string[], cwd, status: "running" \| "exited", pid }`.

### 3h. MCP

| Event type | Defined in | Properties |
|---|---|---|
| `mcp.tools.changed` | [`mcp/index.ts` L50–62](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/mcp/index.ts#L50-L62) | `{ server: string }` |
| `mcp.browser.open.failed` | same | `{ mcpName, url }` |

### 3i. Server / instance

| Event type | Defined in | Properties |
|---|---|---|
| `server.connected` | [`server/event.ts`](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/server/event.ts) | `{}` |
| `global.disposed` | [`bus/index.ts` L13–18](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/bus/index.ts#L13-L18) | `{}` |
| `server.instance.disposed` | same | `{ directory: string }` |

### 3j. LSP

| Event type | Defined in | Properties |
|---|---|---|
| `lsp.updated` | [`lsp/lsp.ts` L22](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/lsp/lsp.ts#L22) | `{}` |
| `lsp.client.diagnostics` | [`lsp/client.ts` L43–49](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/lsp/client.ts#L43-L49) | `{ serverID, path }` |

### 3k. VCS / project / installation / workspace / worktree / IDE

| Event type | Defined in | Properties |
|---|---|---|
| `vcs.branch.updated` | [`project/vcs.ts` L109–114](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/project/vcs.ts#L109-L114) | `{ branch?: string }` |
| `project.updated` | [`project/project.ts`](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/project/project.ts) | full project info |
| `installation.updated` | [`installation/index.ts` L23–28](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/installation/index.ts#L23-L28) | `{ version }` |
| `installation.update-available` | [`installation/index.ts` L29–34](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/installation/index.ts#L29-L34) | `{ version }` |
| `workspace.ready` | [`control-plane/workspace.ts` L51–55](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/control-plane/workspace.ts#L51-L55) | `{ name }` |
| `workspace.failed` | [L57–62](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/control-plane/workspace.ts#L57-L62) | `{ message }` |
| `workspace.restore` | [L63](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/control-plane/workspace.ts#L63) | `{ workspaceID, sessionID, total, step }` |
| `workspace.status` | [L64](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/control-plane/workspace.ts#L64) | `{ workspaceID, status: "connected" \| "connecting" \| "disconnected" \| "error" }` |
| `worktree.ready` | [`worktree/index.ts` L30–36](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/worktree/index.ts#L30-L36) | `{ name, branch }` |
| `worktree.failed` | [L37–42](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/worktree/index.ts#L37-L42) | `{ message }` |
| `ide.installed` | [`ide/index.ts` L19–24](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/ide/index.ts#L19-L24) | `{ ide }` |

### 3l. TUI internals (in-process only)

Defined in [`cli/cmd/tui/event.ts`](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/cli/cmd/tui/event.ts). Useful only inside the TUI process; plugins normally do not see these.

| Event type | Properties |
|---|---|
| `tui.prompt.append` | `{ text }` |
| `tui.command.execute` | `{ command }` |
| `tui.toast.show` | `{ title?, message, variant, duration }` |
| `tui.session.select` | `{ sessionID }` |

### 3m. Subscribing example (canonical)

```ts
export const MyPlugin: Plugin = async () => ({
  event: async ({ event }) => {
    switch (event.type) {
      case "session.created":   /* event.properties.info */ break
      case "session.status":    /* event.properties.status.type */ break
      case "session.error":     /* event.properties.error */ break
      case "session.deleted":   /* event.properties.sessionID */ break
      case "session.compacted": /* event.properties.sessionID */ break
      case "message.updated": {
        const info = event.properties.info
        if (info.role === "assistant" && info.finish != null) {
          // assistant turn finished — final cost/tokens available
        }
        break
      }
      case "message.part.updated": {
        const part = event.properties.part
        if (part.type === "tool" && part.state.status === "completed") {
          // canonical tool-call completion
        }
        break
      }
      case "permission.replied": /* event.properties.reply */ break
      case "file.edited":        /* event.properties.file */ break
      case "command.executed":   /* event.properties.{name,arguments,sessionID,messageID} */ break
    }
  },
})
```

---

## 4. Detailed payload shapes for the most-used hooks

### 4a. `chat.message` — fired on **user** message intake

Signature ([`packages/plugin/src/index.ts` L233–L242](https://github.com/anomalyco/opencode/blob/main/packages/plugin/src/index.ts#L233-L242)):

```ts
"chat.message"?: (
  input: {
    sessionID: string
    agent?: string
    model?: { providerID: string; modelID: string }
    messageID?: string
    variant?: string
  },
  output: { message: UserMessage; parts: Part[] },
) => Promise<void>
```

Fires inside `createUserMessage()` at [`prompt.ts` L1199–L1213](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/session/prompt.ts#L1199-L1213) — **after** input parts have been resolved (files read, MCP resources fetched) but **before** the user message is saved and **before** the LLM is called.

> ⚠️ **Common mistake:** treating `output.parts` as the *assistant's* output. They are the parts of the *incoming user message*. Assistant turns and tool calls are not delivered through this hook.

`Part` is the discriminated union from [`message-v2.ts` L406–L448](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/session/message-v2.ts#L406-L448):

```
TextPart | SubtaskPart | ReasoningPart | FilePart | ToolPart |
StepStartPart | StepFinishPart | SnapshotPart | PatchPart |
AgentPart | RetryPart | CompactionPart
```

There is no `"tool-use"` or `"tool-result"` part type. Tool data lives on `ToolPart` (discriminator `"tool"`).

### 4b. `tool.execute.after`

Signature ([`packages/plugin/src/index.ts` L273–L280](https://github.com/anomalyco/opencode/blob/main/packages/plugin/src/index.ts#L273-L280)):

```ts
"tool.execute.after"?: (
  input: { tool: string; sessionID: string; callID: string; args: any },
  output: { title: string; output: string; metadata: any },
) => Promise<void>
```

`metadata` is typed `any` and is **whatever the tool's `execute()` returned**. Built-in tools spread their return value directly into `output` ([`prompt.ts` L415–L438](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/session/prompt.ts#L415-L438)). MCP tools always populate `metadata.truncated` and optionally `metadata.outputPath` ([`prompt.ts` L499–L510](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/session/prompt.ts#L499-L510)).

> ⚠️ **Common mistake:** reading `output.metadata.status` to detect success/error. There is no `status` field on `output.metadata`. The `status` discriminator (`"pending" | "running" | "completed" | "error"`) lives on the *stored* `ToolState` in the session DB, not on the hook's `output`. To detect failure here, rely on whether the tool threw, or inspect tool-specific metadata fields you control.

### 4c. `tool.execute.before`

Signature:

```ts
"tool.execute.before"?: (
  input: { tool: string; sessionID: string; callID: string },
  output: { args: any },
) => Promise<void>
```

Mutating `output.args` changes the arguments that will actually be passed to the tool.

### 4d. `permission.ask`

Signature ([`packages/plugin/src/index.ts` L260](https://github.com/anomalyco/opencode/blob/main/packages/plugin/src/index.ts#L260)):

```ts
"permission.ask"?: (
  input: Permission,
  output: { status: "ask" | "deny" | "allow" },
) => Promise<void>
```

`output.status` already carries the decision — you do not need a separate "replied" hook to know the outcome at this point. You can also overwrite it to override the user prompt.

### 4e. `chat.params`

Signature:

```ts
"chat.params"?: (
  input: {
    sessionID: string
    agent: string
    model: Model
    provider: ProviderContext
    message: UserMessage
  },
  output: {
    temperature: number
    topP: number
    topK: number
    maxOutputTokens: number | undefined
    options: Record<string, any>
  },
) => Promise<void>
```

Mutate `output` to change the parameters actually sent to the LLM.

### 4f. `tool` — registering custom tools

`tool` is **an object map**, not a function:

```ts
import { tool } from "@opencode-ai/plugin"

export const MyPlugin: Plugin = async () => ({
  tool: {
    my_custom_tool: tool({
      description: "...",
      args: { foo: tool.schema.string() },
      async execute(args, ctx) {
        return "result string" // or { output, metadata }
      },
    }),
  },
})
```

The `ToolContext` (`ctx`) shape is in [`packages/plugin/src/tool.ts`](https://github.com/anomalyco/opencode/blob/main/packages/plugin/src/tool.ts) and includes `sessionID`, `messageID`, `agent`, `directory`, `worktree`, `abort`, `metadata()`, and `ask()`.

---

## 5. Common mistakes (and what to do instead)

| ❌ Mistake | ✅ Correct |
|---|---|
| Defining a top-level `"session.created"` handler on the returned object | Subscribe via `event` hook, switch on `event.type === "session.created"` |
| Defining `"session.idle"`, `"session.error"`, `"session.deleted"`, `"session.compacted"` as handlers | All are bus events; route via `event` |
| Defining a `"permission.replied"` handler | Bus event only; route via `event`. (Use `permission.ask` to *override* the decision.) |
| Using `session.idle` for new code | It's deprecated; use `session.status` and check `status.type === "idle"` |
| Reading `input.systemPrompt` in any session-lifecycle handler | No such field; capture system prompt via `experimental.chat.system.transform` |
| Treating `chat.message` `output.parts` as the assistant's reply | They are the **user**'s incoming parts; assistant turns are not delivered here |
| Matching `part.type === "tool-use"` / `"tool-result"` in `chat.message` parts | Those types don't exist; use the `Part` union from `message-v2.ts` (`tool`, `text`, `file`, …) |
| Reading `output.metadata.status` in `tool.execute.after` | No such field; `metadata` is tool-specific. Detect errors via thrown exceptions or your own tool conventions |
| Expecting `originalMessageCount` / `compactedMessageCount` on `session.compacted` | Payload is just `{ sessionID }`. Track counts yourself via message events, or use `experimental.session.compacting` |
| Returning a plain `Plugin` function from `package.json` main | Either is accepted, but the `PluginModule` form `{ id, server: Plugin }` is preferred for forward compatibility |

---

## 6. Source files used to compile this document

All paths are relative to [`anomalyco/opencode`](https://github.com/anomalyco/opencode):

- `packages/plugin/src/index.ts` — `Hooks` interface, all named trigger hook signatures
- `packages/plugin/src/tool.ts` — `tool()` builder, `ToolContext`, `ToolResult`
- `packages/opencode/src/plugin/index.ts` — plugin runner / `trigger()` dispatch / `event` fan-out
- `packages/opencode/src/session/session.ts` — `session.created` / `updated` / `deleted` / `diff` / `error` events
- `packages/opencode/src/session/status.ts` — `session.status`, deprecated `session.idle`
- `packages/opencode/src/session/compaction.ts` — `session.compacted`
- `packages/opencode/src/session/prompt.ts` — `chat.message`, `tool.execute.before` / `after` call sites
- `packages/opencode/src/session/message-v2.ts` — `Part` union, `ToolState` schemas
- `packages/opencode/src/permission/index.ts` — `permission.asked` / `permission.replied` bus events

When the upstream source moves, re-verify these paths and bump the references.

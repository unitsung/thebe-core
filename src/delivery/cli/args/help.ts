export const CLI_HELP = `thebe — headless homelab agent (agent CLI over AgentRuntime)

Usage:
  thebe                          Start interactive TUI
  thebe -p "prompt"              One-shot print mode
  thebe -c                       Continue most recent session in TUI
  thebe --session <id>           Resume session in TUI
  thebe --list-models [search]   List models
  thebe session list|create|resume|fork|compact|export|delete|messages|status
  thebe session interrupt|revert|unrevert|model|thinking
  thebe doctor                   Report the effective isolation posture

Options:
  -p, --print              Print response and exit
  -c, --continue           Use most recent agent session
  -r, --resume <id>        Resume session by id (alias of --session)
  --session <id>           Target session id
  --model <provider/id>    Set model before prompt
  --thinking <level>       off|minimal|low|medium|high|xhigh|max
  --mode prompt|steer|followUp
  --tui-mode <mode>        regular|fullscreen (default: regular or ~/.thebe/config.json)
  --fullscreen             Launch TUI directly in fullscreen alt-screen mode
  -n, --name <title>       Session title
  --format jsonl|html|both Export format (default both)
  -o, --out <path>         Export output path/prefix
  --provider <id>          Filter models by provider
  --all                    Include unavailable models
  -h, --help               Show help

Architecture: embeds Pi via createAgentSession / AgentRuntime. Does not spawn
the Pi CLI. Arcane, auth, AgentStore, and PolicyEngine stay Thebe-owned.
`;

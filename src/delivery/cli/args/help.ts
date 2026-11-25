export const CLI_HELP = `thebe — headless homelab agent (agent CLI over AgentRuntime)

Usage:
  thebe                          Start interactive TUI
  thebe -p "prompt"              One-shot print mode
  thebe -c                       Continue most recent session in TUI
  thebe --session <id>           Resume session in TUI
  thebe --list-models [search]   List models
  thebe session list|create|resume|fork|compact|export|delete|messages|status
  thebe session interrupt|revert|unrevert|model|thinking
  thebe mcp list|tools                Inventory from ~/.thebe / .thebe/mcp.json
  thebe mcp add <name> --url <url|--command <cmd>> [--header K=V]...
  thebe mcp enable|disable|remove <name>
  thebe storage list             File backends in ~/.thebe/config.json
  thebe storage add openlist <id> --url <url> --token <token> [--default]
  thebe storage add local <id> --roots <dir>[,<dir>] [--default]
  thebe storage add webdav <id> --url <url> [--username <u> --password <p>]
  thebe storage add webdav <id> --url <url> --token <token> [--default]
  thebe storage remove|default <id> | test [<id>] | import-env
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
  --url <url>              MCP server URL (mcp add)
  --command <cmd>          MCP server command (mcp add)
  --header K=V             MCP request header; repeatable (mcp add)
  --env K=V                MCP stdio env; repeatable (mcp add)
  --arg <value>            MCP stdio argument; repeatable (mcp add)
  --roots <dirs>           Local storage roots; repeatable or comma-separated
  --token <token>          Storage token (openlist, webdav)
  --username <user>        WebDAV Basic auth user
  --password <password>   WebDAV Basic auth password
  --default                Make the added storage backend the default
  -h, --help               Show help

Architecture: the default AgentRuntime drives the DeepSeek Harness SDK profile;
THEBE_RUNTIME=pi selects the embedded Pi compatibility runtime. Arcane, auth,
AgentStore, PolicyEngine, approvals, and audit stay Thebe-owned.
`;

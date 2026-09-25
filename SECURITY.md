# Security Policy

Please report security issues privately to the repository owner instead of opening a public issue.

The notifier normally reads Codex limits through the official app-server and uses recent local session JSONL files only as a fallback. It sends only rendered usage values through the configured Discord Bot and never exposes the Bot token through the WebUI or its API. It does not read `~/.codex/auth.json`, copy access tokens, or call undocumented OpenAI endpoints. Keep `.env` private and rotate the Discord Bot token immediately if it is exposed.

The WebUI should remain bound to the Mac mini's exact Tailscale address. Do not bind it to a public interface or forward its port to the internet. State-changing API calls enforce same-origin requests, but anyone who can reach the private WebUI can operate notification settings and send test messages.

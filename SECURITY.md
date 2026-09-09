# Security

StandRig is a local, single-owner developer tool. The service binds only to 127.0.0.1 and checks Host and browser Origin. It has no accounts or authentication. Do not expose it with a reverse proxy, public tunnel or LAN binding. Any process running as the same OS user can access local model data and the local API.

Use trusted PSDs and keep backups. AI clients can perform writes through explicitly described tools; a tool response or model metadata must not be treated as authorization for unrelated file or network actions. The service's legacy full-model/part write endpoints have fewer safeguards than the MCP transaction workflow.

When reporting a suspected security issue, avoid publishing credentials, personal source artwork or a working exploit against a live service. Use the repository's private vulnerability reporting channel if the maintainer has enabled it; otherwise request a private contact without disclosing the exploit publicly.

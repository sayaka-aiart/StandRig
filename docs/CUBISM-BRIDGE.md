# Cubism Editor connection

StandRig can connect to a separately running [Cubism API Bridge](https://github.com/sayaka-aiart/cubism-api-bridge) HTTP server (API 1.1.0).
The service adapter has no Cubism SDK dependency and does not require the Bridge source tree.

1. Start the Bridge HTTP server and permit its application in Cubism Editor.
2. Use the session file produced by that server (JSON containing `url` and `token`).
3. Start StandRig:

```powershell
npm start -- --bridge-session-file "C:\private\bridge-session.json"
```

Alternatively set `STANDRIG_BRIDGE_SESSION_FILE`. Restart StandRig after replacing credentials.
Keep the session file outside the repository and distribution. Only loopback HTTP origins
are accepted. The browser and MCP never receive the bearer token.

The preview's **Cubism Bridge** button checks connection status. AI tools:

- `standrig_bridge_status`: connection, API compatibility and Bridge state.
- `standrig_bridge_read`: strict method-specific requests for documents, current UIDs/edit mode,
  parameters/groups/values, parts, deformers, an object or physics information.
- `standrig_bridge_pose`: `SetParameterValues` or `ClearParameterValues` (transient overrides).

Example read: `{"method":"GetCurrentModelUID","data":{}}`.
Then use the returned Cubism ModelUID:

```json
{"method":"SetParameterValues","data":{"ModelUID":"<Cubism UID>","Parameters":[{"Id":"ParamAngleX","Value":10}]}}
```

Clear overrides explicitly using `ClearParameterValues` with that ModelUID. Parameter IDs and
ranges come from `GetParameters`; StandRig IDs are not automatically mapped to Cubism IDs.
HTTP equivalents: `GET /api/bridge/status`, `POST /api/bridge/read`, `POST /api/bridge/pose`.
Calls require an idle compatible Bridge. Editing leases belonging to other clients are never borrowed.
Failures are not automatically retried; after an uncertain write, inspect Cubism and Bridge before acting.

This connection does not provide persistent Cubism editing, automatic parameter streaming,
model conversion, file saving, or motion import. Those require separate explicit workflows.
The Bridge's own HTTP/Python editing API remains independent. Connection status alone does
not demonstrate model appearance or successful parameter application.

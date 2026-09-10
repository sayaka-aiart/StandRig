# MCP connection

The local service and MCP server are separate processes. Start the service once, then let your AI client spawn the stdio MCP process.

```sh
npm ci
npm run build
npm start
```

Open `http://127.0.0.1:5180/`, import a parts-separated PSD or load the geometric sample, and open `/player` to view playback.

## Client configuration

日本語の初回起動手順は [README](../README.md#aiを接続する) を参照してください。設定画面では「コマンド」=`node`、「引数」=`配置先/packages/mcp/src/cli.mjs` の絶対パス、「環境変数」=`STANDRIG_URL=http://127.0.0.1:5180` に相当する値を指定します。これはstdio接続です。サービスのHTTP URLをリモートMCPのURL欄へ入力しても接続できません。

For clients accepting an `mcpServers` JSON configuration, replace the absolute path below:

```json
{
  "mcpServers": {
    "standrig": {
      "command": "node",
      "args": ["C:/path/to/StandRig/packages/mcp/src/cli.mjs"],
      "env": { "STANDRIG_URL": "http://127.0.0.1:5180" }
    }
  }
}
```

Use the equivalent command/args/env fields in other clients. If `node` is not on that client's PATH, use the absolute path to the Node executable. Paths containing spaces remain a single array argument. The MCP process works from any current directory. Use `node .../cli.mjs` directly in client configuration: `npm run mcp` prints npm's own messages and is for terminal inspection, not a clean stdio transport.

After saving, reconnect/restart the MCP connection in your client. Confirm that all 12 `standrig_*` tools are listed, then call `standrig_context`. A successful response contains `context.revision` and model counts. An empty model has zero assets: import your PSD in the browser before asking for modeling. If tools are missing, check the executable/path; if a tool returns `fetch failed`, check the running service and STANDRIG_URL. Tool listing alone does not prove service connectivity.

`STANDRIG_URL` accepts only loopback HTTP origins and does not follow redirects. The process does not start the service, import files, open a browser, buy AI API credits or configure OBS. SDK 2.0.0's `serveStdio` supports the modern protocol and legacy initialization; the installed version is fixed in the lockfile. [Official SDK](https://github.com/modelcontextprotocol/typescript-sdk)

## Tools

| Tool | Purpose |
| --- | --- |
| `standrig_context` | First read: compact current model and revision |
| `standrig_changes` | Poll changes since a known stored revision |
| `standrig_inspect` | Parts/deformers, definitions, validation, modeling audit, poses, techniques, suggested roles, reference sets |
| `standrig_modeling_transaction` | Dry-run or QA-gated commit; automatic pre-commit checkpoint |
| `standrig_qa_check` | Numeric QA on the stored revision |
| `standrig_render` | One 240px snapshot/failure PNG, or a required reference contact sheet after QA |
| `standrig_checkpoint` | Create/list persistent checkpoints |
| `standrig_restore` | Revision-checked restore; first saves the current model as another checkpoint |
| `standrig_export` | Write a self-contained bundle and return its local path |
| `standrig_playback_state` | Transient parameters, play state and output connections |
| `standrig_playback_parameters` | Pose/expression input without editing the model |
| `standrig_playback_control` | play / pause / reset / reload / demo-start / demo-stop / demo-pointer |

動作デモは `{command:"demo-start", mode:"showcase-active"}`（既定）または `{command:"demo-start", mode:"mouse-expression"}`。マウス位置は `{command:"demo-pointer", x:0.5, y:-0.5}` のように -1〜1 の座標を渡します（画面右が+X、下が+Y）。`demo-stop` で開始前の姿勢・再生状態を復元します。通常のパラメータ入力はデモを止め、元の姿勢に入力値を適用します。保存モデルは変更しません。

HTTP and MCP transactions share `@standrig/contracts`: 33 `type`-discriminated action variants with strict nested typed objects, finite numbers and rejection of unknown keys. `expectedRevision` and `qa` are mandatory. Named action types and schemas are generated from `packages/core/src/operationRegistry.ts` and QA types (`npm run generate`); `npm test` rejects stale schemas. Typed parameter-ID maps accept arbitrary keys with declared value types. Tool errors return `isError:true`; successful JSON calls also return `structuredContent`. The service creates rollback checkpoints after commit gates pass, for both HTTP and MCP.

## Resources and workflow

Read `standrig://docs/contract` (AGENTS.md), then `standrig://docs/guide`. Additional resources: `operations`, `architecture`, `adapters`, `api` under the same URI prefix (six resources total). If your client cannot read MCP resources, give it the corresponding local files; do not skip the contract.

1. Read context and confirmed parts. Prepare visual targets under the model's data directory before PSD modeling.
2. Read poses and the operations resource; dry-run a bounded transaction with `expectedRevision`, `commit:false`, and explicit QA.
3. Inspect every operation result and QA failure. A dry-run candidate revision is not the stored revision.
4. Commit the reviewed change, then re-run stored-model QA and compare actual maximum poses visually. The returned rollback checkpoint is persistent; the transaction journal itself is not persistent undo.
5. Set playback parameters and open `/player`. Numeric success and connected outputs alone do not prove the final visual result.

`standrig_render` requires QA evidence for the current revision within that MCP session. Failed QA permits only a reported pose/region failure image. Reference sheets are the explicit image-size exception in AGENTS.md. These images render the stored model; they never show an uncommitted dry-run candidate. Restarting MCP clears its QA evidence.

Failure rendering reuses the QA result's sampled values and physics settings, including custom `poseSamples`. The diagnostic is rendered at 240px per panel. `snapshot` uses explicit `values`; `reference` uses an available sheet `set`; `poseId` and `region` select a `failure` only. Preparing new reference artwork and saving arbitrary files requires separate tools; the MCP renderer only renders the existing model.

For a reproducible sample round trip, load Sample Bot and run `node examples/mcp-demo.mjs`. It changes only transient playback, after numeric QA. The example uses the SDK client installed as a development dependency.

For example, `{type:"artmesh-generate",preset:"face-feature",columns:"five",rows:5}` is rejected at the MCP boundary with `action.columns` identified as a number-type error, before the local HTTP service is called. Unknown action types and extra fields are also rejected. Schema validity does not establish target existence or valid model geometry; application-level validation and QA remain required.

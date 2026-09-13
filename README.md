# StandRig

[日本語](README.md) | [English](README.en.md)

**AIから編集できる2Dモデリングコアと、組み込み可能な再生ランタイム。**

パーツ分け済みPSDを読み込み、MCP対応のAIクライアントからメッシュ・デフォーマー・キーフォームを編集し、数値パラメータで動かせます。PSD読込と動作確認用のブラウザUIも付属します。開発者向け初期版 **0.2.0** です。

![パーツ分け済みキャラクターPSDを読み込んだStandRigの実画面](docs/images/character-preview.jpg)

パーツ分け済みキャラクターPSDを読み込んだ実画面です。掲載キャラクターのPSD・モデルは同梱していません。「サンプルを試す」では図形モデルが開きます。画像は検証用ポート5196で撮影しており、通常の起動先は5180です。[掲載画像の扱い](docs/images/NOTICE.md)

## できること・対応範囲

**このリポジトリに含まれるのはStandRig本体です。ConnectとCubism API Bridgeは別アプリで、必要な用途に応じて導入します。**

### StandRig本体：モデリング・ブラウザ再生

| 機能 | 本体でできること |
| --- | --- |
| 素材の読み込み | パーツ分け済みPSDの画像レイヤー・位置・階層などを取り込む |
| モデリング | MCP / HTTP APIから編集、試行、数値QA、確定、復元。AI操作には別途MCP対応クライアントが必要 |
| AI用変形 | smooth / relax / inflate / pinch / bend / contour-follow。ArtMesh以外のBlend Shapeにも対応（[APIと制限](docs/DEFORM.md)） |
| 再生 | 透過再生ページ、スライダー・数値パラメータ入力、モーションJSON再生、ブラウザへのランタイム組み込み |
| 書き出し | モデルJSON、画像込みモデルJSON。Connectへの持ち出しには画像込みを使用 |
| 外部入力の受信 | 外部ツールが生成した数値を受け取るAPI。カメラでの追跡処理は含まない |
| OBS用の再生ページ | 別途起動したOBSのブラウザソースに指定できる。本体にOBS制御・Spout2送信は含まない |

**PSDを読み込むだけでは、完成した動きは付きません。** AIへ指示して必要な設定を作り、実際の表示を確認します。自動パーツ分け、AIモデル、画像生成サービスは提供しません。

#

### StandRig Connect：カメラ追跡・ネイティブ配信（別アプリ）

| 機能 | Connectでできること |
| --- | --- |
| カメラトラッキング | 顔・目・視線・口の追跡、調整、中立校正。体の動きは顔からの推定 |
| Windowsでの単独再生 | 画像込みモデルJSONを読み込み、StandRig本体やブラウザを起動せずに描画 |
| モーション・待機 | StandRigモーション再生、呼吸・揺れ・ランダム微動 |
| 外部パラメータAPI | ローカルHTTPで一覧・値域取得、一時上書き、解除。Connectへ直接入力でき、本体の起動は不要 |
| モデルスロット | モデルとトラッキング調整をアプリ内に保存 |
| OBS向け出力 | ゲーム／ウィンドウキャプチャ用の出力画面、オプションのSpout2送信。OBSは別途必要 |

### Cubism API Bridge：Cubism Editor連携（別アプリ）

| 機能 | Bridgeとの接続でできること |
| --- | --- |
| 必要なもの | 別途起動したCubism API Bridgeと、対応するCubism Editor・接続許可 |
| StandRigからの情報取得 | Cubism Editorのモデル・パラメータ・パーツ・デフォーマー・物理情報などを取得 |
| StandRigからの一時操作 | Cubismのパラメータ値を一時設定・解除 |
| Bridge単独のAPI | Bridge自身のHTTP / Python APIも利用可能。StandRigの接続機能とは提供範囲が異なる |

StandRig経由のBridge接続は、永続編集・自動同期・モデル変換を提供しません。StandRig本体はcmo3/moc3の作成・変換・再生に対応しません。[Bridge接続の範囲と設定](docs/CUBISM-BRIDGE.md)

## 最初に試す

必要なものは **Node.js 22.12以上の22系、または24以上**とブラウザです。確認済みの環境はWindows / Node.js 24です。初回インストールにはインターネット接続が必要です。サンプルの表示とスライダー操作にはAIの契約やMCP接続は不要です。

### 1. ファイルを入手する

このリポジトリをGitHub DesktopでCloneするか、**Code → Download ZIP**でダウンロードして展開します。Releasesに公開されたソースZIPも使えます。

`README.md`、`package.json`、`start-modeling-tools.cmd` があるフォルダを開きます。ZIPを開いたまま実行せず、先に展開してください。

### 2. 起動する

**Windows:** `start-modeling-tools.cmd` をダブルクリックします。初回インストール、ビルド、サービス起動を行います。コマンド画面は使用中そのまま開いておきます。

**ターミナルから:** リポジトリのフォルダへ移動して実行します。

```sh
npm ci
npm run build
npm start
```

`StandRig local service: http://127.0.0.1:5180` が表示されたら、ブラウザで **http://127.0.0.1:5180/** を開きます。ブラウザは自動では開きません。

### 3. サンプルを動かす

1. **「サンプルを試す」**を押します。現在のモデルは先にチェックポイントへ保存されます。
2. **「再生画面を開く」**を押します。
3. 元の画面を下へスクロールし、**Angle Z**（`ParamAngleZ`、頭の傾き）、**Mouth**（`ParamMouthOpen`、口の開き）などのスライダーを動かします。再生画面にも反映されれば基本動作を確認できています。

サンプルは図形モデルです。設定のないパラメータを動かしても対応する動きは出ません。モーション未読込時の「再生」は時間更新・物理演算を進めます。モーション読込後はそのモーションも再生します。カメラ追跡は始まりません。

### 4. 動作デモを試す

プレビュー上部の **「動作デモ」** で種類を選び、**「デモを開始」**を押します。

- **Showcase — Fast & Wide:** 顔・体・視線・表情を自動で動かします。
- **Mouse + Expressions:** プレビュー上のマウス位置に顔・体・視線が追従し、瞬き・ウィンク・口の開閉を自動で加えます。マウスをプレビュー外へ出すと中央へ戻ります。

両方ともプレビューと再生画面へ反映されます。**「デモを停止」**で開始前の姿勢・再生状態へ戻ります。スライダーや外部パラメータ入力、「再生」「一時停止」「初期値」、モデル変更でもデモを終了します。モデルの保存内容は変更しません。サービスで動くため、ブラウザタブを閉じるだけではデモは止まりません。

設定がある部位だけが動きます。サンプルは頭の傾き・口の開閉などの基本動作を確認するためのもので、全表情の実演ではありません。未設定のPSDへ動きを自動作成する機能ではなく、最大姿勢の品質検査を代替するものでもありません。

## 自分のPSDを使う

1. **「PSDを選択」**で1ファイル選び、**「PSDを読み込む」**を押します。
2. 表示位置・重なり・色・表示/非表示が意図どおりか確認します。
3. AIを接続し、動かしたい部位と範囲を伝えます。

対応素材は **PSDのみ**で、描画内容のある画像レイヤーが2つ以上必要です。PNG直接読込、統合画像・単一レイヤーPSD、PSB、自動パーツ分けは対象外です。レイヤー数だけでは適切なパーツ分けか判定できません。Photoshopの全機能を再現するものではありません。[PSD入力ガイド](docs/PSD.md)を参照してください。

## AIを接続する

stdio MCPに対応したAIクライアントを別途用意します。AIの契約・料金・ツール実行設定は、そのクライアント側で管理します。StandRigのサービスは起動したままにします。

`mcpServers` 形式を受け付けるクライアントでは、次を登録します。`args` を自分の配置先の**絶対パス**へ置き換えてください。

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

設定の保存場所・書式はクライアントによって異なります。[MCP接続ガイド](docs/MCP.md)に確認方法をまとめています。

最初にAIへ渡す文章の例です。

> StandRigのMCPリソース standrig://docs/contract と standrig://docs/guide を読んでください。standrig_contextで現在のモデルを確認し、パーツ構成と設定済みの動きを説明してください。まだモデルは変更しないでください。

モデリング依頼の例です。

> このPSDから、まず目の開閉を設定してください。既存のパーツIDと構造を確認し、操作ルールに従って必要な参照画像とマニフェストを準備してから、dry-run、数値QA、確定、実際の表示確認の順に進めてください。参照画像を用意する手段が足りない場合は、必要な資料を説明してください。

MCPだけでは参照画像の新規作画や任意ファイルの保存はできません。AIクライアントのファイル・画像ツール、または利用者が用意した資料を使います。数値QAの合格だけで見た目の完成を判定しないでください。

## モーションファイルを再生する

サンプルを読み込み、画面の「モーションJSONを選択」で `examples/sample.standrig-motion.json` を選び、「モーション再生」を押してください。一時停止・停止・再生位置・速度・ループ・JSON書き出しを操作できます。AIからは `standrig_motion` を使います。

現在対応するのは独自のStandRigモーションJSONです。Live2Dの `.motion3.json` はまだ読み込めません。将来の変換器を接続するため、ファイル変換と共通の再生処理を分離しています。形式とAPIは [モーション仕様](docs/MOTION.md) を参照してください。

## 保存・復元・受け渡し

- 読み込みと確定した編集はサーバー側へ保存されます。スライダー操作や再生状態は一時的で、モデルの編集にはなりません。
- 既定の保存先は **`workspace/`**。モデルは `workspace/public/rig.json`、復元点は `workspace/checkpoints/`、bundle出力は `workspace/exports/` に入ります。
- PSD/サンプルの読み込み・HTTP/MCPでの編集・復元では、検証に合格してから保存直前にチェックポイントを自動作成します。復元は `standrig_checkpoint` で一覧を取得し、現在のrevisionとIDを使って `standrig_restore` を呼びます。
- 「モデルJSONを書き出す」はJSON単体です。画像込みで渡すには `standrig_export` で **bundle** を作ります。受け取り側の読込方法は[APIガイド](docs/API.md#bundleの再読み込み)を参照してください。
- 元PSD・参照画像も別途バックアップしてください。`workspace/` はGit・配布ZIP対象外なので、pushしても作業データのバックアップにはなりません。

別モデル用の保存先を指定する例です。同じ保存先に複数のサービスを起動しないでください。

```sh
npm start -- --data-dir "C:/Models/My Character"
```

停止はコマンド画面で **Ctrl+C**。次回は起動ファイル、または `npm start` で再開します。ソース更新後は `npm ci` と `npm run build` をやり直します。


画像込みモデルの標準拡張子は `.srig` です。中身は従来と同じJSONで、既存の画像込み `.json` もStandRigとConnectの両方で読み込めます。StandRig本体の「素材を読み込む」→「モデルを選択（.srig / .json）」から再編集用に読み込めます。`.srig` にPSD原本・Connectの設定は含みません。

### 画像込みモデルの書き出し

画面の「素材を読み込む」内にある「画像込みモデルを書き出す（.srig）」を押すと、保存済みモデルとパーツPNGを内包した `model.srig` をダウンロードします。保存先はブラウザの設定に従います。PSDや画像フォルダを別途渡す必要はありません。プレビューで一時的に操作した姿勢や、外部アプリのトラッキング設定は含みません。通常の「モデルJSONを書き出す」は外部画像参照が残る場合があるため、別アプリへの持ち出しには画像込みを使用してください。

### モデルJSONの読み込み

「素材を読み込む」で「モデルを選択（.srig / .json）」→「モデルを読み込む」を押します。rig.json、画像込みモデルJSON、StandRig bundleに対応します。通常のrig.jsonの参照画像は、同じStandRig環境の画像保存先に必要です。別環境へ移す場合は画像込みモデルJSONを使ってください。検証に成功すると、現在のモデルをチェックポイントに保存してから読み込みます。bundleのトラッキング設定は読み込みません。

## 外部アプリとの連携

以下は別アプリを導入する場合の手順です。

### StandRig Connect：トラッキング・配信

[**StandRig Connect**](https://github.com/sayaka-aiart/standrig-connect)は、StandRigで作ったモデルをカメラで動かし、OBSへ出力する別のWindowsアプリです。**0.1.0 開発プレビューのソース公開版**として提供しています。導入にはビルドが必要で、手順と顔推論モデルのセットアップは[ConnectのREADME](https://github.com/sayaka-aiart/standrig-connect#readme)を参照してください。

- 顔の向き・目・視線・口のトラッキングと調整、中立校正。
- モデルとトラッキング調整のアプリ内スロット保存。
- StandRigモーション再生と、呼吸・揺れ・ランダム微動の待機プリセット。
- OBSのゲーム／ウィンドウキャプチャ、オプションのSpout2送信。

StandRig側でモデリングと動作確認を終えたら、**「画像込みモデルを書き出す（.srig）」**を押し、そのJSONをConnectの「モデル」タブで開きます。パーツ画像を含む1ファイルで持ち出せるため、Connectでの再生中にStandRig本体・ブラウザ・PSDは不要です。通常の「モデルJSONを書き出す」で得られる画像なしのJSONとは異なります。

Connectの操作画面は最小化・トレイ格納中も処理を継続します。OBSのゲーム／ウィンドウキャプチャでは出力画面を表示しておきます。Spout2は出力画面を非表示にできますが、対応ビルドとOBS側の別途プラグインが必要です。体の動きは顔からの推定で、全身トラッキングではありません。

Connectの外部パラメータAPIは `http://127.0.0.1:22036` で、パラメータ一覧・値域の取得、一時上書き、個別／全解除に対応します。AIのスクリプトや外部ツールから直接呼び出せるため、StandRig本体の起動は不要です。認証情報は `%LOCALAPPDATA%\StandRigConnect\api-session.json` に保存され、Connectの「API」タブで場所を確認できます。認証ファイルは共有・コミットしないでください。

上書きは指定項目だけに適用し、既定1秒（指定可能範囲100～10000ms）で解除して通常入力へ戻ります。連続操作では期限前に更新します。モデル切替後はセッションIDの再取得が必要です。Stream Deck等からはHTTP呼出しに対応したスクリプトやアクションを利用する想定で、専用プラグイン・表情切替APIは未実装です。

StandRig本体のブラウザ再生・外部数値入力も引き続き使用でき、Connectの導入は任意です。

### Cubism API Bridgeと接続する

別リポジトリの[Cubism API Bridge](https://github.com/sayaka-aiart/cubism-api-bridge)を使うと、StandRigのMCPからCubism Editorの情報取得と一時的な姿勢・表情の操作ができます。Bridgeは別プロセスで起動し、StandRig本体にCubism SDKは追加しません。

1. BridgeのREADMEに従ってビルドし、Cubismで接続を許可します。
2. BridgeのフォルダでHTTPサーバーを起動します。

```powershell
npm run http -- --port 22035 --session-file "$env:LOCALAPPDATA\StandRigCubismBridge\http-session.json"
```

3. 別のターミナルで、ビルド済みStandRigのフォルダから起動します。

```powershell
npm start -- --bridge-session-file "$env:LOCALAPPDATA\StandRigCubismBridge\http-session.json"
```

UIの「Cubism Bridge」で接続状態を確認できます。MCPには `standrig_bridge_status`、`standrig_bridge_read`、`standrig_bridge_pose` を追加しています。認証情報はサーバー内で扱い、セッションファイルは共有・コミットしないでください。Bridge再起動後はStandRigサービスも再起動してください。

この接続はAPI 1.1.0のBridgeが待機中の場合に利用できます。StandRigからのCubism永続編集、自動同期、モデル変換、モーション読込は未対応です。[対応範囲とAPI例](docs/CUBISM-BRIDGE.md)を参照してください。

## 困ったとき

| 症状 | 確認すること |
| --- | --- |
| `node` / `npm` が見つからない | 対応Node.jsをインストールし、ターミナルやAIクライアントを開き直す |
| PowerShellで `npm.ps1` が拒否される | `npm.cmd ci` など `.cmd` を指定するか、Windowsの起動ファイルを使う |
| 画面が開かない / `fetch failed` | サービスが起動中か、URL・ポートが一致しているか確認する |
| `EADDRINUSE` | 起動済みでないか確認。別ポートなら `npm start -- --port 5182` とし、ブラウザとMCPの接続先も5182にする |
| MCPで `node` が見つからない | `command` にNode実行ファイルの絶対パスを指定する |
| MCP接続直後にプロトコルエラー | `npm run mcp` ではなく、上記の `node` と `cli.mjs` を使う |
| PSDは表示されるが動かない | 対象パラメータの設定を確認する。PSD読込だけでは完成しない |
| `empty-image` | PSDまたはサンプルを読み込む。空モデルのQAは失敗する |
| `revision mismatch` | 最新contextを取得し、変更内容を再確認して試行し直す |

## 開発者向け

```text
packages/core/       モデル形式・モデリング・評価・QA
packages/runtime/    ブラウザ再生と外部入力の契約
packages/mcp/        AI操作用stdio MCPサーバー
apps/service/        ローカルAPI・保存・復元・再生状態
apps/preview/        PSD読込・姿勢確認・透過再生画面
examples/            合成サンプルモデルと接続例
```

`core` / `runtime` はMCPなしでも利用できます。npmへは未公開なので、このソースのnpm workspacesで開発します。[構成](docs/ARCHITECTURE.md)、[外部接続・組み込み](docs/ADAPTERS.md)、[API](docs/API.md)、[操作一覧](docs/OPERATIONS.md)を参照してください。

```sh
npm run build
npm test
```

UI開発はサービスを5180番で起動したまま、別ターミナルで `npm run dev` を実行し、http://127.0.0.1:5181/ を開きます。通常起動はViteから独立したNode.jsサービスです。

配布物のハッシュ確認は `npm run verify`。ソース変更後は不一致になるため、通常の開発テストとは区別してください。配布時の生成・検証は[RELEASING.md](docs/RELEASING.md)、検証範囲は[VALIDATION.md](docs/VALIDATION.md)に記載しています。

旧write APIは既定で無効です。読み込み・編集・復元はtransactionへ集約し、revisionはSHA-256、操作schemaはHTTP/MCP共通の厳密な定義を使います。移行方法は [APIリファレンス](docs/API.md) を参照してください。

## License

独自コード・ドキュメント本文・合成サンプルは [Apache-2.0](LICENSE)。[NOTICE](NOTICE)、[第三者ライブラリの表記](THIRD_PARTY_NOTICES.md)も参照してください。持ち込むPSD・キャラクター画像、およびスクリーンショット内のキャラクターには、このリポジトリのライセンスを適用しません。[掲載画像の扱い](docs/images/NOTICE.md)を参照してください。

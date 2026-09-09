# StandRig

**AIから編集できる2Dモデリングコアと、組み込み可能な再生ランタイム。**

Local 2D modeling and playback with an MCP interface. Import a parts-separated PSD, edit and validate its rig through AI tools, then drive the resulting model with numerical parameters. Initial developer release: **0.2.0**.

## できること

- パーツ分け済みPSDから、レイヤー位置・階層を持つモデルを読み込む。
- MCPからArtMesh、Deformer、キーフォームなどを編集し、変更の試行・数値QA・確定・復元を行う。
- 独立した再生画面や、自作アプリへ組み込んだランタイムでモデルを動かす。
- 外部トラッカーから数値パラメータを入力する。透過再生画面を外部OBSのBrowser Sourceへ接続する。

素材入力は**PSDのみ**です。描画内容のある画像レイヤーが2つ以上必要です。PNG直接読み込み、統合画像・単一レイヤーPSD、PSB、自動パーツ分けは対象外です。レイヤー数の検査は、顔や関節のパーツ分けが適切であることまで保証しません。

カメラ追跡・OBS制御は外部接続、Live2D Bridgeは将来拡張です。現時点でCubismのcmo3/moc3を作成・再生するツールではありません。出力はStandRig JSON / bundleです。

## 起動

Node.js **22.12以上の22系、または24以上**が必要です。初回は依存パッケージの取得にインターネット接続を使います。

```sh
npm ci
npm run build
npm start
```

Windowsでは `start-modeling-tools.cmd` でも起動できます。

1. `http://127.0.0.1:5180/` を開く。
2. パーツ分け済みPSDを選んで読み込む。まず動作を見る場合は「サンプルを試す」を使う。
3. [MCP接続設定](docs/MCP.md)をAIクライアントへ登録し、[AI操作ガイド](AI_OPERATING_GUIDE.md)を読ませる。
4. 「再生画面を開く」で結果を確認する。サンプルでは `ParamAngleZ`、`ParamMouthOpen`、目の開き、`ParamBodyAngleZ` を試せる。

MCPはAIクライアントから別プロセスとして起動します。サービスの自動起動やAIモデルの提供は行いません。

停止は Ctrl+C。ポートが使用中なら `npm start -- --port 5182` とし、ブラウザとMCPの接続先も変更してください。

## 構成

```text
packages/core/       モデル形式・モデリング・評価・QA
packages/runtime/    ブラウザ再生と外部入力の契約
packages/mcp/        AI操作用stdio MCPサーバー
apps/service/        ローカルAPI・保存・復元・再生状態
apps/preview/        PSD読込・姿勢確認・透過再生画面
examples/            合成サンプルモデルと接続例
templates/           初回作業フォルダ用の空モデル・スキーマ
```

詳しくは[構成と依存関係](docs/ARCHITECTURE.md)、[トラッキング・OBS・将来Bridgeの接続境界](docs/ADAPTERS.md)を参照してください。`core` / `runtime` はMCPなしでも利用できます。Viteは画面の開発・ビルド用で、通常起動のAPIサーバーは独立しています。

## 作業データ

モデル、チェックポイント、出力は既定で `workspace/` に保存します。このフォルダはGitと配布ZIPから除外します。別モデルは `npm start -- --data-dir /absolute/model-project` で分けてください。同じデータフォルダへ複数のサービスを起動しないでください。

読み込み前とMCPの確定前にチェックポイントを保存します。MCPの `standrig_restore` で復元できます。チェックポイントは画像込みですが、元PSDや外部の参照資料のバックアップも別途保管してください。

プレビューの「モデルJSONを書き出す」はJSON単体です。モデルを別環境へ渡す場合は `standrig_export` または `POST /api/exports/bundle` で画像込みbundleを書き出します。作成物の権利は、元のPSD・画像の条件に従います。

## 開発・検証

```sh
npm run build
npm test
npm run verify
```

UI開発時はサービスを起動したまま `npm run dev` を実行し、5181番へ接続します。検証結果と限界は[VALIDATION.md](docs/VALIDATION.md)を参照してください。数値QAの成功だけでモデルの見た目や配信動作を保証するものではありません。

GitHub向けCI・Issue/PRテンプレートと、作業素材を含めない配布スクリプトを同梱しています。[公開手順](docs/RELEASING.md)を参照してください。GitHubやnpmへの自動公開は設定していません。

## License

独自コードと同梱の合成サンプルは [Apache-2.0](LICENSE)。[NOTICE](NOTICE)、[第三者ライブラリの表記](THIRD_PARTY_NOTICES.md)を参照してください。ユーザーが持ち込むPSD・キャラクター画像には、このリポジトリのライセンスを適用しません。

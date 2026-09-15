# Telemetry

Discordの投稿収集とGoogle Docsのタブ作成を行うTypeScript / pnpm workspaceです。
既定は **Cloudflare Workers + D1 + Queues + 非公開R2** の構成です。本番の収集にPC常駐プロセスは不要です。
Gatewayイベントを使う従来のNode.js collectorも `collector/` に用意しています。

## 機能

- `/auth`：サーバー単位のGoogle OAuth（PKCE、使い捨てstate、暗号化refresh token）。
- `/document`：既存Google Docsの保存先設定。
- `/create`：新しいタブにテンプレートを書き込み。Queue再配信・同時再送の二重作成を防止。
- `/telemetry status` / `/telemetry backfill days:30`：管理者限定の収集状況・履歴取得。
- Workers版：5分ごとのREST取得、公開・参加済み非公開スレッドの探索、D1投稿保存、R2画像・動画保存、JST期間指定JSONL。
- ローカル版：Gatewayの投稿・編集・単独/一括削除、SQLite、ローカル添付保存。

## セットアップ

Node.js 24以上、pnpm 11が必要です。`packageManager` と `pnpm-lock.yaml` にバージョンを固定しています。

```sh
pnpm install --frozen-lockfile
pnpm run setup
pnpm run db:local
pnpm run dev
```

`pnpm setup` はpnpm自身のセットアップコマンドと紛らわしいため、プロジェクトの設定生成には `pnpm run setup` を使います。
`.dev.vars` のGoogleクライアント情報、Discord Application ID・Public Key・Bot Tokenを設定してください。
APIキーと暗号化キーはsetupが生成し、既存のキーは保持します。
秘密ファイル・SQLite・R2ローカルデータ・JSONL・生成された型定義はGitに含めません。

Google側ではDocs APIを有効にし、Webアプリ用OAuthクライアントに
`http://localhost:8787/auth/callback`（本番ではAPP_ORIGIN + `/auth/callback`）を登録します。
Discordへ接続するにはBotのMessage Content Intentと、対象チャンネルの閲覧・履歴閲覧権限が必要です。
DiscordのInteractionsには公開HTTPS URLが必要です。ローカル動作だけなら管理CLIを使えます。

### Workers版の収集設定

`examples/cloud-config.json` をコピーして、対象の親チャンネルIDを変更します。IDは文字列です。

```sh
pnpm run telemetry configure --guild YOUR_GUILD_ID --config examples/cloud-config.json
pnpm run telemetry scan --guild YOUR_GUILD_ID
pnpm run telemetry status --guild YOUR_GUILD_ID
pnpm run telemetry backfill --guild YOUR_GUILD_ID --days 30
pnpm run telemetry export --guild YOUR_GUILD_ID --from 2026-09-14 --to 2026-09-16
pnpm run telemetry retry-attachments --guild YOUR_GUILD_ID
```

リモートは `--base-url https://YOUR_WORKER` を追加し、`DEMO_API_KEY` を環境変数に設定します。
CLIはリモートへローカルの秘密値を自動送信しません。
初回の通常収集は設定登録時刻からです。過去分はbackfillで明示します。
backfillの応答は受付結果です。進行中の履歴取得があると409になり、同じチャンネルを同時スキャンしません。

エクスポートはD1を50件ずつ読み、R2へ分割保存します。完成した出力だけ取得できます。
CLIは完成済みパートを順番にストリーム取得して、ローカル `.part` に書き込み、fsync後に一意な `.jsonl` へ切り替えます。
5分で未完了の場合はジョブIDを使って再取得できます。

```sh
pnpm run telemetry download --guild YOUR_GUILD_ID --id EXPORT_UUID
```

### 設定の意味とREST方式の制約

| 設定 | 既定値 | 意味 |
|---|---:|---|
| `overlap_hours` | 24 | 新着取得時に重ねて読み直す期間。過去編集の一部を取得 |
| `verify_days` | 7 | 保存済み投稿を個別照合する対象期間 |
| `verify_interval_minutes` | 60 | 同じ投稿を再照合できる最短間隔 |
| `max_attachment_mib` | 100 | 画像・動画1件の上限。受信中も検証 |
| `include_bots` / `include_webhooks` | false | 他Bot / Webhook投稿の収集。自分のBotは常に除外 |

Cronは `wrangler.jsonc` の `triggers.crons`（既定5分）で変更できます。
ローカルの `wrangler dev` はCronを自動実行しません。`http://localhost:8787/cdn-cgi/local/scheduled` を開くと、添付ジョブの投入・中断ジョブの回収も含めて手動実行できます。
取得は有限のQueueジョブに分割し、照合は1ジョブ10件です。実際の鮮度・照合周期は投稿数、Queue待ち、Discordのレート制限に依存します。
429では `retry_after` まで待ち、進捗を進めません。
通常の取得開始位置とbackfillの進捗は独立しています。
ジョブはD1のリースと実行世代を照合して保存します。Queue投入失敗・途中終了はCronがD1から再投入します。
添付は5MiB単位でmultipart uploadし、完成直前に投稿の存続と世代を照合します。途中終了したオブジェクトは永続cleanupから回収します。

**REST方式はGatewayと同じイベント検知ではありません。**

- 収集前に削除された短命な投稿は取得できません。
- 重複取得・個別照合の対象期間外の編集や削除は検知できません。
- 削除は個別取得でDiscordの `10008 Unknown Message` が返った場合のみ確定します。403や一覧からの欠落を削除扱いにしません。
- 削除済みの本文と添付参照を消して墓標を残し、古い履歴からの復活を防ぎます。
- 出力はページごとの読み取りです。作成中の更新をまたぐ厳密な時点スナップショットではありません。
- 完成済みJSONL・ダウンロード済みファイル・バックアップは元投稿削除時に自動で消えません。
- Workers版は `schema_version: 2` と添付の `storage_key` を出力します。PCの絶対 `path` は持ちません。
- Durable ObjectsからGatewayへ常時接続する構成は実装・実証対象に含めていません。

## Google Docs CLI

```sh
pnpm run demo auth
pnpm run demo run --doc YOUR_DOCUMENT_ID
pnpm run demo tabs --doc YOUR_DOCUMENT_ID
pnpm run demo preview
pnpm run demo logout
```

`--title`、`--template`、`--data`、`--request-id`、`--base-url`、`--no-open` に対応します。
同じrequest ID・同じ内容の成功済み操作は再利用し、異なる内容や結果不明の操作は409を返します。
Googleへの書き込みは自動リトライしません。本文挿入で失敗した場合は空タブが残る可能性があり、判明しているURLを返します。
Google接続はCLIの `default` と `discord:guild:<ID>` ごとに分離します。

## HTTP API

全 `/api/*` は `Authorization: Bearer <DEMO_API_KEY>` を要求します。
これは**全guildを操作できる共有管理キー**です。guild指定は利用者の認可ではありません。
一般サーバー管理者向けのWeb認証画面は提供せず、Discord操作は署名検証・サーバー管理権限確認を通します。

| Method | パス | 用途 |
|---|---|---|
| GET | `/health` | ヘルスチェック |
| POST | `/discord/interactions` | Discord署名付きコマンド |
| GET | `/auth/start`、`/auth/callback` | Google OAuth |
| POST / DELETE | `/api/auth` | CLI認証開始 / 接続解除 |
| GET | `/api/auth/:id`、`/api/status` | 認証状態 |
| GET / POST | `/api/tabs` | タブ一覧 / 新規タブ作成 |
| PUT | `/api/telemetry/config?guild=ID` | Cloud収集設定 |
| GET | `/api/telemetry/status?guild=ID` | 進捗・試行回数・エラー |
| POST | `/api/telemetry/scan?guild=ID` | 通常スキャン |
| POST | `/api/telemetry/backfill?guild=ID` | `{ "days": 30 }` |
| POST | `/api/telemetry/retry-attachments?guild=ID` | 失敗添付の再取得 |
| POST | `/api/telemetry/exports?guild=ID` | `{ "from": "2026-09-14", "to": "2026-09-16" }` |
| GET | `/api/telemetry/exports/:id?guild=ID` | 出力状態・パート数 |
| GET | `/api/telemetry/exports/:id/parts/:part?guild=ID` | 完成JSONLのパート（0始まり） |
| GET | `/api/telemetry/attachments/:id?guild=ID` | 保存済み添付の認証付き取得 |

ローカルcollector用中継APIは `/api/collector/commands` と `/api/collector/commands/:id/result` に残しています。
Workers完結版はこのpollを使用しません。

## Cloudflareへの展開

このリポジトリの `wrangler.jsonc` は新規環境向けのプレースホルダーです。既存環境のID・URLを引き継ぎません。
本番へのリソース作成・デプロイ・Discord登録は以下の手順で明示実行します。

```sh
pnpm exec wrangler d1 create telemetry
pnpm exec wrangler queues create telemetry-docs
pnpm exec wrangler queues create telemetry-collection
pnpm exec wrangler r2 bucket create telemetry-private
```

既存リソースを利用する場合は新規作成せず、対応する名前・IDに設定を変更します。
`database_id` と本番HTTPSの `APP_ORIGIN`、Discord公開設定を `wrangler.jsonc` に設定してください。
R2はpublic accessを有効化しません。失敗したmultipart uploadの部品を回収するR2 lifecycleルールも設定します。

```sh
pnpm exec wrangler secret put GOOGLE_CLIENT_ID
pnpm exec wrangler secret put GOOGLE_CLIENT_SECRET
pnpm exec wrangler secret put DEMO_API_KEY
pnpm exec wrangler secret put TOKEN_ENCRYPTION_KEY
pnpm exec wrangler secret put DISCORD_BOT_TOKEN
pnpm run db:remote
pnpm run deploy
pnpm run discord:register --dry-run
pnpm run discord:register
```

DiscordのInteractions Endpointを `APP_ORIGIN/discord/interactions` に設定します。
コマンド登録スクリプトは名前ごとに登録・更新し、他のコマンドを一括削除しません。
サーバー内で `/auth` → `/document document:URL` → `/create` を実行してください。
クラウド収集は管理CLIでconfigureしたあとCronから起動します。

## ローカルcollector（代替構成）

`collector/README.md` を参照してください。共有アプリで使う場合はWorkerの `COLLECTION_MODE` を `local` にし、collectorの `control.mode` は `worker` にします。
同じデータを2方式で同時収集してもDBは同期されません。機能差と運用形態を選んで使います。

## 検証

```sh
pnpm run check
pnpm run build
```

`check` はWrangler型生成、TypeScript、Workerのdry-runビルド、Miniflare/workerdでのGoogle・Discord APIモックとD1・Queue・R2統合検証、実SQLiteでのcollector検証を実行します。
`tests/cloud-harness.ts` はテスト専用のWorkerで、本番エントリポイントへ含めません。

2026-09-15の検証結果：Worker 47件、collector 33件、合計80件が成功しました。型チェック、dry-runビルド、ローカルD1初期化、health・API認証拒否・Cron handler、CLI preview・コマンド登録dry-runも確認しました。

実サービスでのGoogle同意・Docs書き込み・Discord登録・公開CloudflareでのPC停止中稼働は、自動検証と別の確認項目です。
今回の実装では本番デプロイや実サービスへの投稿・Docs書き込みは実施していません。指定されたDiscord Bot TokenとApplication IDの一致は、読み取りAPIで確認しました。

### 設計資料

現行機能は `AGENTS.md` 第1〜18章、Workers構成は第19章を基準にしています。
再現元の認証・Docs・ローカルcollectorのコードを引き継ぎ、Cloud収集は別のD1テーブルと追加マイグレーションで実装しています。

- [Cloudflare Queues JavaScript API](https://developers.cloudflare.com/queues/configuration/javascript-apis/)
- [D1 Database / transactions](https://developers.cloudflare.com/d1/worker-api/d1-database/)
- [R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
- [Discord Message API](https://docs.discord.com/developers/resources/message)

# Telemetry

Discordの投稿収集とGoogle Docsのタブ作成を行うTypeScript / pnpm workspaceです。
既定は **Cloudflare Workers + Durable Objects + D1 + Queues + 非公開R2** の構成です。本番の収集にPC常駐プロセスは不要です。
Gatewayイベントを使う従来のNode.js collectorも `collector/` に用意しています。

## 機能

- `/auth`：サーバー単位のGoogle OAuth（PKCE、使い捨てstate、暗号化refresh token）。
- `/document`：既存Google Docsの保存先設定。
- `/telemetry status` / `/telemetry backfill days:30`：管理者限定の収集状況・履歴取得。
- `/mtg schedule` / `status` / `cancel`：Webで空き時間を調整して日時を自動確定し、サーバー内の取得可能な全履歴を収集して1つのDocsタブへ記録。
- `/mtg debug`：直近168時間を即時収集し、Luna・mediumで3部構成のアジェンダを生成してDocsへ出力。日程調整と全員通知は行いません。詳細は [アジェンダの手順](docs/agenda.md)。
- Workers版の手動収集：REST取得、スレッド探索、D1投稿保存、R2画像・動画保存、JST期間指定JSONL。Cronによる定期収集は廃止しています。
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

## DiscordからMTGを予約する

サーバー管理権限を持つ利用者が、`/auth` と `/document document:保存先URL` を実行してから予約します。

```text
/mtg schedule
/mtg status
/mtg status id:予約ID
/mtg cancel id:予約ID
```

- `/mtg schedule` は引数なし。実行チャンネルに `@everyone` 付きの「次回MTGの日時を入力してください！」と「日程調整を開く」ボタンを投稿します。Botに投稿・全員メンション権限が必要です。成功時の本人限定返信は残しません。
- Discordログイン後は直接、空き時間を入力します。最初にページを開いた時点のサーバー全メンバー（Botを除く）を自動で対象にし、募集終了まで固定します。参加者・所要時間・名前の設定は不要。名前は確定した開催日のJST日付で `2026/09/14 定例mtg` の形式にします。
- メンバーの自動取得には、Discord Developer Portal → Bot → Privileged Gateway Intents の **Server Members Intent** が必要です（Application ID: `1548735050646949999`）。OAuthスコープ・招待権限は変更ありません。
- 作成日のJST日付から5〜9日後（7日後の前後2日、合計5日間）の0:00〜24:00を表示。30分単位でクリック・ドラッグ、またはTabとSpaceで空き時間を選択し保存します。招待リンクをコピーして参加者に共有してください。
- 全員が回答し、共通の開始時刻ができたら自動確定。未回答を空き扱いしません。空き時間なしの回答も保存でき、共通枠がなければ修正して調整を続けます。
- 複数候補は7日後に近い日、同距離なら早い日、その日の早い時刻を優先。日付をまたぐ枠、確定時点から1時間以内の枠を除外します。確定後の回答変更はできません。
- 確定日時を元チャンネルへメンションなしで通知し、既存の資料作成予約へ接続します。通知失敗でも予約は維持。結果が不明な通知は自動再送せずWebに確認案内を表示します。
- `/mtg status` は募集状況・リンクと確定済み予約を表示。募集は主催者が `/mtg cancel id:調整ID` で取り消せます。候補期間を過ぎた募集は終了します。

#### Botの招待権限

[必要な権限を含めてBotを招待・再認可する](https://discord.com/oauth2/authorize?client_id=1548735050646949999&scope=bot%20applications.commands&permissions=274878106624)

チャンネル閲覧・履歴閲覧・メッセージ送信・スレッド内送信・全員メンションを要求します。MTG募集の `@everyone` 通知には全員メンション権限が必要です。チャンネル個別の権限で拒否されている場合は、通知先でその設定も変更してください。管理者権限は要求しません。権限やスコープを変更した場合は、新しい招待URLをユーザーへ案内します。

#### 日程調整のDiscordログイン設定

1. Discord Developer Portal → OAuth2 → Redirectsに `APP_ORIGIN + /mtg/login/callback` を登録（本番: `https://telemetry.tange-toshihiro.workers.dev/mtg/login/callback`）。
2. 対象アプリ（本番Application ID: `1548735050646949999`）のOAuth2 Client Secretを、プロジェクトのルートで次のコマンドを実行して登録します。`DISCORD_CLIENT_SECRET` は設定名なので、そのまま入力してください。秘密値はコマンドの引数にせず、実行後の入力欄へ貼り付けます。Bot Tokenとは別の値です。

   ```sh
   pnpm exec wrangler secret put DISCORD_CLIENT_SECRET --name telemetry
   ```

   成功メッセージを確認後、`pnpm exec wrangler secret list --name telemetry` の一覧に `DISCORD_CLIENT_SECRET` があることを確認します。`secret put` は本番へ即時反映されます。ローカルは `.dev.vars` に同名で設定します。このSecretは `wrangler.jsonc` の必須設定にも含め、未登録でのデプロイを防ぎます。

   秘密値を誤って設定名にした場合は、Discord Developer PortalでClient Secretを再発行してから登録し直してください。秘密値をチャットやコマンド引数へ貼り付けないでください。
3. 追加D1マイグレーション `0009` の適用、Workerデプロイ（新しいMeetingPoll Durable Objectを含む）、Discordコマンド定義の更新が必要です。既存予約は保持されます。

認証スコープは `identify` のみ。stateをブラウザCookieに結び付けて使い捨てにします。セッションCookieはHttpOnly・SameSite=Lax・本番Secure、24時間有効。D1にはセッショントークンのハッシュを保存し、Discord access/refresh tokenは保存しません。APIで現在のサーバー所属を確認し、参加者だけが閲覧、本人だけが回答を変更できます。変更APIは同一Originを要求し、主催者の取消時に管理権限を再確認します。

#### 日時確定後の資料作成

- **指定時刻はMTGの開始日時**です。その1時間前に収集・Docs作成を開始します。1時間を切った予約は受付直後に開始します。実行遅延・履歴量・API制限によりMTG開始までの完成は保証されません。
- 各予約はサーバー内でBotが取得できる**全履歴（投稿作成時刻が収集開始予定時刻より前のもの）**を毎回読み直します。前回からの差分方式ではありません。
- テキスト・アナウンス・フォーラム・メディア、ボイス／ステージのテキスト履歴とスレッドが対象です。アクティブ・公開アーカイブ・参加済み非公開アーカイブに加え、権限があれば未参加の非公開アーカイブも取得します。
- 自分自身のBot以外のBot・Webhook投稿も含めます。権限のない取得処理はスキップ数に記録し、通信障害や429では再試行します。Message Content Intentが無効なら本文欠落を避けるため停止します。
- 投稿作成日時順に、投稿者・チャンネル名・本文・返信先・元投稿リンク・添付リンクを記録します。Markdownの記号はそのまま残します。
- PNG/JPEG/GIFはDocsへ画像を埋め込みます。Googleのサイズ・解像度等の制限で拒否された画像、未対応形式、動画はリンクを残します。Google Docs APIに動画プレーヤーの挿入機能はありません。CDNリンクは失効するため元投稿リンクも併記します。
- 本文は最大12,000 UTF-16単位ごとに分割して**同じ新規タブ**へ追記し、50,000文字を超えても省略しません。Google Docs自体の上限や編集権限エラーでは停止し、作成済みURLを表示します。
- 予約者の管理権限を実行時とタブ作成前に再確認します。保存先ドキュメントは予約受付時点のものに固定します。
- 予約IDはDiscord Interaction IDです。再配信で予約やタブを増やしません。結果が不明なGoogle書き込みは自動再送せず`needs_review`で停止します。
- 完成後、予約したチャンネルへBotが `@everyone` 付きでMTG日時（JST）・Docsリンク・議題の3行要約を送信します。Botには送信と全員メンションの権限が必要です。予約の受付返信は本人限定でメンションしません。
- 要約にはWorkerのSecret `OPENAI_API_KEY` と変数 `MTG_SUMMARY_MODEL`（例: `gpt-5-mini`）を設定します。`pnpm exec wrangler secret put OPENAI_API_KEY` で登録し、モデルは `wrangler.jsonc` のvarsに指定してください。収集テキストを分割してOpenAI APIへ送り、前の要約と統合します（API利用料が発生）。画像・動画の内容は解析しません。空履歴では議題がないことを通知します。
- 要約・通知が失敗しても完成済みDocsは保持し、`/mtg status` に失敗とURLを表示します。送信結果が不明な場合は全員メンションの重複を避けて自動再送を止め、通知先の確認を案内します。429は待機して再試行します。
- 取消できるのは未開始の予約だけです。予約・完了・失敗・URLは本人限定の`/mtg status`で確認します。将来の実行に期限切れのInteraction返信tokenを使いません。
- この変更前の予約は旧時刻・旧動作を維持します。新動作にする場合は未開始予約を取り消して再予約してください。本番反映には追加マイグレーション `0008`、Workerデプロイ、Discordコマンド定義の更新が必要です。
- 予約ごとのDurable ObjectのSQLiteに履歴と書き込み進捗を永続化し、アラームで続行します。長期停止は7日で打ち切ります。実行完了後はアラームを解除します。
- 取得後に元投稿を編集・削除しても、作成済みDocsや予約の収集結果は自動更新されません。取得時点の内容であり、過去の編集リビジョンの復元や音声の録音は行いません。

`/mtg`には下記CLIの`configure`は不要です。MTGの収集結果は予約専用ストレージに保存され、既存の`telemetry export`用D1とは別です。

### Workers版の手動収集設定

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

`wrangler.jsonc` の `triggers.crons` は空で、scheduled handlerはありません。`/mtg`の予約またはCLIのscan・backfillを明示的に実行します。
取得は有限のQueueジョブに分割し、照合は1ジョブ10件です。実際の鮮度・照合周期は投稿数、Queue待ち、Discordのレート制限に依存します。
429では `retry_after` まで待ち、進捗を進めません。
通常の取得開始位置とbackfillの進捗は独立しています。
ジョブはD1のリースと実行世代を照合して保存します。Queue投入失敗・途中終了はサーバー単位のCollectionRecoveryアラームがD1から再投入します。新しいスキャンは作らず、処理とcleanupが終わると停止します。
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
認証Cookieもリクエストごとに分離し、同じブラウザで複数サーバーを認証できます。Google画面でエラーになった場合、開始したブラウザであれば10分以内の未完了リンクを再度開けます（古いstateは失効）。完了済み・キャンセル済み・期限切れ、または別ブラウザでは `/auth` を再実行してください。
Google画面の `redirect_uri_mismatch` はGoogle OAuthクライアントの承認済みリダイレクトURIと `APP_ORIGIN + /auth/callback` の不一致です。`access_denied` は同意画面の公開状態・テストユーザー・組織の制限を確認してください。Google側の最初のエラーと、同じリンクを開き直した際の使用済みエラーは別の原因です。

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

このリポジトリの `wrangler.jsonc` は本番Worker `telemetry` 向けに設定しています。
公開URLは `https://telemetry.tange-toshihiro.workers.dev` です。
2026-09-15時点で専用D1の作成・全6件のマイグレーション、`telemetry-docs`・`telemetry-collection` Queueの作成は完了しています。
2026-09-15にMTG予約版を本番デプロイ完了（Version: `a418835f-9c3d-4c72-92c8-d63964fdb79e`）。非公開R2 `telemetry-private`、両QueueのProducer・Consumer、MeetingScheduler・CollectionRecoveryのDurable Objectsを接続し、5分Cronを削除しました。
R2の公開URL・カスタムドメインは無効で、不完全multipart uploadは7日後に自動削除します。
以下の作成コマンドで既存のD1・Queue・R2を重複作成しないでください。

Discordアプリ `1548735050646949999` のInteractions EndpointはこのWorkerの `/discord/interactions` に切替済みです。`/auth`・`/document`・`/telemetry`・`/mtg` をグローバル登録し、Message Content Intentを有効化しました。
Google OAuthクライアントの承認済みリダイレクトURIに `https://telemetry.tange-toshihiro.workers.dev/auth/callback` を2026-09-15に追加しました。旧デモURLだけが登録されていたため発生していた `redirect_uri_mismatch` が解消し、公開Workerの認証開始からGoogleログイン画面へ進むことを確認済みです。実アカウントでの同意・コールバック完了は別途確認が必要です。
新規D1のためGoogle接続・保存先Docs・収集対象チャンネルは別途設定してください。旧デモの接続・収集データは移行していません。
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
サーバー内で `/auth` → `/document document:URL` → `/mtg schedule` を実行してください。
手動のクラウド収集は管理CLIでconfigureしたあとscan・backfillから起動します。MTG予約ではBotの閲覧範囲を実行時に探索するためconfigureは不要です。

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

2026-09-15の統合後検証結果：Worker（既存の議題生成モジュールを含む）73件、collector 33件、合計106件が成功しました。型チェック・dry-runビルドに加え、予約の永続化と再起動・時刻前の実行拒否・取消・サーバー分離・全履歴とスレッドのページ送り・50,000文字超の時系列出力・画像埋め込みとリンク代替・Googleの不明な書き込みを再送しないこと・処理終了後の復旧アラーム解除を検証しました。

実サービスでのGoogle同意・Docs書き込み・Discord登録・公開CloudflareでのPC停止中稼働は、自動検証と別の確認項目です。
本番デプロイ後、health 200、未認証API 401、認証済みstatus 200（D1接続）、不正Discord署名401を確認しました。Discordによる新Endpointの検証とコマンド登録も成功しています。実サービスへの投稿・Docs書き込みは実施していません。指定されたDiscord Bot TokenとApplication IDの一致は、読み取りAPIで確認しました。

### 設計資料

現行機能は `AGENTS.md` 第1〜18章、Workers構成は第19章を基準にしています。
再現元の認証・Docs・ローカルcollectorのコードを引き継ぎ、Cloud収集は別のD1テーブルと追加マイグレーションで実装しています。

- [Cloudflare Queues JavaScript API](https://developers.cloudflare.com/queues/configuration/javascript-apis/)
- [D1 Database / transactions](https://developers.cloudflare.com/d1/worker-api/d1-database/)
- [R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
- [Discord Message API](https://docs.discord.com/developers/resources/message)
- [Durable Objects Alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)
- [Google Docs画像挿入](https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/request#InsertInlineImageRequest)

## Botのサーバープロフィール

サーバー内でBotのプロフィールを開くと、保存先ドキュメントURLと接続Googleメールアドレスを表示します。Google未接続・保存先未設定はそれぞれ「設定されてないです」と表示します。これは登録状況であり、現在の編集権限やトークンの有効性はDocs作成時に確認します。

共通プロフィールの「自己紹介」はDiscordアプリの `description` も同期します。保存先とGoogle接続が揃ったサーバーがない間は「設定されてないです」と表示し、設定済みのサーバーがあれば `/document` の案内に切り替えます。共通欄には各サーバーのURL・メールを掲載しません。共通欄が空になった場合も次回同期で修復します。

- `/auth` 完了と `/document` 設定・照会で自動同期します。接続情報はサーバーごとに分離し、そのサーバーのメンバーに公開されます。
- OAuthに `openid email` を追加しました。既存接続・メール情報の取得失敗時は「接続済み・メール未取得」と表示し、`/auth` の再実行で取得します。
- `0007_discord_profiles.sql` を適用してからデプロイしてください。Workerの `DISCORD_BOT_TOKEN` が必要です。
- 初回表示や更新失敗後の再同期は `pnpm run discord:profile --guild SERVER_ID --base-url https://YOUR_WORKER --env-file .dev.vars`。`--status` で接続情報・最終同期時刻・同期エラーを確認できます。APIは管理用Bearer認証必須です。
- プロフィール更新はDocs Queueで直列実行し、実行時の最新情報を読みます。同じ内容は再送せず、Discordの429では待ち時間を尊重して再試行します。Queueの再試行上限後はコマンドから再同期してください。
- 新しく招待したサーバーでは `/auth`・`/document` または上記CLIの初回実行で表示を初期化します。参加イベントの自動検知は行いません。
- URLとメールが190文字に収まらない場合は、途中で切らず `/document` の確認案内を表示します。

参照: [Discordのサーバープロフィール更新API](https://docs.discord.com/developers/resources/guild#modify-current-member)、[Googleのメール情報取得](https://developers.google.com/identity/openid-connect/openid-connect#obtaininguserprofileinformation)。

2026-09-15検証: プロフィール変更を分離した作業コピーで `pnpm run check` 成功（Worker等76件、collector33件）。本番へマイグレーション0007とWorker版 `ca065131-e7c7-4566-9644-cf6ac0beec04` を反映し、参加中2サーバーのプロフィール同期完了・エラーなしを確認しました。既存接続のメールは未取得のため再認証が必要です。メール取得の実Google同意フローは利用者による確認が残ります。

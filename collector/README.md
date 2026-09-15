# ローカルcollector

Gatewayイベントを受け取るNode.js 24以上の代替収集プロセスです。
Workers完結版を使用する場合、このプロセスは不要です。

```sh
cp collector/config.example.yaml collector/config.yaml
cp collector/.env.example collector/.env
```

`collector/.env` に `DISCORD_BOT_TOKEN`、`DISCORD_GUILD_ID`、共有アプリなら `APP_ORIGIN`・`DEMO_API_KEY` を設定します。
`config.yaml` の対象チャンネルIDは文字列で指定します。パスはYAMLファイルのある場所を基準に解決します。
BotのMessage Content Intent、対象チャンネルの閲覧・履歴閲覧権限が必要です。

```sh
pnpm run collector run
pnpm run collector status
pnpm run collector export --from 2026-09-14 --to 2026-09-16
pnpm run collector retry-attachments
```

`retry-attachments` はcollectorを停止してから実行します。status/exportは別ターミナルから並行利用できます。
終了日は含みません。例はJSTの14日・15日分です。

- 共有Discordアプリ：Workerで `COLLECTION_MODE=local`、YAMLで `control.mode: worker`。
- 専用収集アプリ：`control.mode: gateway`。そのアプリのInteractions Endpointは空にします。
- SQLiteは1guild固定、二重起動はrun-lockで拒否します。Python版DBとの共用はできません。
- 削除済み投稿は墓標を残し、添付の削除は永続cleanupで再試行します。
- 停止中の削除を履歴一覧だけで判断することはできません。
- JSONL・バックアップの作成後に原本を削除しても、出力済みデータは自動では消えません。
- Workers版のR2 `storage_key` に対して、ローカル版の添付はPC内の絶対 `path` を保持します。

```sh
pnpm --filter @telemetry/collector check
```

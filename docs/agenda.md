# アジェンダ生成とBot側の接続契約

収集済み投稿をOpenAI Responses APIで整理し、次の固定ひな型で返します。

1. 今週のまとめ
2. 部門・テーマごとの進捗
3. 今日話し合うこと

Bot・Google Docs出力側はAmpoi担当、投稿整理・アジェンダ生成側は本モジュールが担当します。
既存のDiscordコマンド、収集ジョブ、Docsキュー、DBマイグレーション、公開Worker設定はそのまま使用できます。
この追加だけで `/create` がアジェンダを生成するようにはなりません。Bot側の呼出箇所から以下の関数へ接続してください。

## 呼び出す関数

```ts
import { generateAgenda, type Message } from './agenda/index';

const result = await generateAgenda({
  project: 'プロジェクト名',
  meetingAt: '2026-09-15 18:00 JST',
  guildId: authorizedGuildId,
  from: '2026-09-08',
  to: '2026-09-15',
  messages: collectedRecords as Message[],
  previousMinutes: '', // 任意。前回の予定との比較用
  coverageNotes: [],   // 任意。収集できなかった範囲を冒頭へ注記
}, {
  apiKey: openaiApiKey,
  model: 'gpt-5.6-luna',
  reasoningEffort: 'medium',
});
```

`authorizedGuildId`はBot側で認可済みのサーバーIDです。異なるguildの投稿が混ざると失敗します。
Workers版の`exportRecord()`／JSONLと、ローカルcollectorの`RecordData`を受け取れます。
`from`を含み`to`を含まないJST日付範囲。IDは文字列、`created_at`はタイムゾーン付き日時にしてください。
削除記録を優先して除外し、重複は編集・観測日時で統合します。collectorのマイクロ秒精度を保持します。
部門は収集設定を利用し、欠けていれば「部門未設定」とします。

## 返却形式

`schemaVersion: 1`、`templateVersion: weekly-agenda-v1`。

| フィールド | 内容 |
|---|---|
| title / meetingAt | 文書名・開催日時 |
| agenda.summary | 今週のまとめ |
| agenda.topics | 部門・テーマ別の進捗 |
| agenda.discussions | 今日話し合うこと |
| sources[messageId].url | 入力のIDから組み立てた元投稿URL |
| media[attachmentId] | 添付のstorage_key／path、元投稿、画像送信有無 |
| markdown | 確認用にひな型へ整形した本文 |
| notes | 収集範囲不足などの注記 |
| metadata | 期間、モデル、投稿件数、API呼出数・usage |

文章の単位は `{ text, sourceIds, mediaIds }`。根拠IDの存在を検証します。
進捗は `previous`（前回予定）、`results`（作業・結果）、`insights`（考察）、`blockers`（課題）、`next`（予定・案）。
議題は `question`、`background`、`options`、`people`、`deadline`、`materials`。
情報がない項目は空配列で、Markdownでは「対象ログ内に記載なし」と表示します。
文章の意味が出典と一致するかは実ログ評価も必要です。ID検証だけで要約の正確さを保証するものではありません。

## Docs側との受け渡し

画像やリンクの書式を付ける場合は構造化JSONを使用してください。`mediaIds`の添付は関連する文章の直後へ配置します。
独立の「参考」欄は作りません。非公開R2キー・PC上のpathは公開URLではありません。
動画は元投稿リンクを配置し、画像はDocs側で取得・挿入してください。

現在の `createTab()` / `POST /api/tabs` に文字ベースで渡す場合は、互換アダプターを利用できます。

```ts
import { agendaDocsInput } from './agenda/docs-input';
import { createTab } from './documents';
import { guildOwner } from './discord-guild';

const body = agendaDocsInput(result, {
  document: savedDocumentId,
  requestId: stableAgendaRequestId, // 同じ作成ジョブの再配信でも同じID
  title: '週次会議アジェンダ',
});
// 以下はAmpoi側の認可済みDocsジョブ内で実行する例です。
const response = await createTab(new Request('https://internal.invalid/create', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}), env, guildOwner(authorizedGuildId));
```

アダプターは書き込みを行わず、既存の文字数・入力検証を通したリクエスト本文を作ります。
本文はテンプレートの**データ**として渡し、投稿中の `{{...}}` を再展開しません。
既存の変換は見出し・箇条書きに対応しますが、画像・リンク・太字の完全な書式化には対応していません。
Bot側では生成成功結果を保存してからDocsジョブへ渡し、Docs返信の再試行時にOpenAI生成を繰り返さないようにしてください。
新規HTTP受付・キュー・永続化処理の自動追加は行っていません。

## 画像入力

`images: [{ attachmentId, dataUrl: 'data:image/png;base64,...' }]` で実画像を渡せます。
PNG/JPEG/WebP、最大20枚・Data URL合計16MB。外部URLや未知の添付IDは拒否します。
渡されていない画像・動画・PDFの内容は推測しないよう指示します。
`imageReviewed`は画像をAPIへ渡した記録であり、正確な理解を保証しません。
R2署名付きURL、添付のローカルpath、Google/DiscordトークンはAPIへ渡しません。
投稿本文は要約のためOpenAIへ送信されます。

## CLI

```sh
# examples/agenda.env.exampleを参考に、Git対象外の.env.agendaへOpenAI用設定を用意
pnpm exec tsx --env-file=.env.agenda scripts/agenda.ts examples/agenda-request.json agenda-output

# 既に環境変数が設定されている場合
pnpm exec tsx scripts/agenda.ts examples/agenda-request.json agenda-output
```

JSONLを読むには、入力JSONの `messages` を `"jsonlFile": "telemetry.jsonl"` へ置き換えます。
パスは入力JSONの場所を基準に解決します。秘密値・実ログ・生成物はコミットしないでください。
CLIはJSONLをメモリへ読み込むため、呼出側で対象期間を絞ります。
UUID付きの `.json` / `.md` を生成し、既存ファイルは上書きしません。

## 実行上限と検証

モデルと推論強度はオプションまたは `OPENAI_MODEL` / `OPENAI_REASONING_EFFORT` で変更可能です。
通常は1回のAPI呼出、30,000文字を超えれば投稿単位に分割して整理し、最後に統合します。
既定最大12リクエスト。上限は最初の呼出前に検証し、巨大な単一投稿は切り捨てずエラーにします。
統合入力上限に達した場合、部分整理の料金が発生済みになる場合があります。ドル建て上限ではありません。
APIは `store: false`。自動リトライ・自動モデル切替は行わず、拒否・途中打切り・ネットワークエラーを区別して返します。
プロバイダーの生エラー本文や秘密値はログへ出しません。

`pnpm run check`で、既存Bot・Docs・collectorの検証に加えてアジェンダのテストも実行されます。
Miniflareで実際のD1出力を生成処理へ渡す結合テスト、日時精度、削除、参照・画像ID、分割統合、Docs入力互換性を確認します。
実キーはGitへ含めず、実サービスへのテストは通常の自動テストから分離します。
本番Cloudflareに組み込む際のSecret登録・Botの呼出処理・Docsへの画像配置はAmpoi側の接続作業です。

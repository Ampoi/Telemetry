# アジェンダ生成とBot側の接続契約

## 即時実行するデバッグコマンド

`/mtg debug` をサーバー内で実行すると、日程調整なしで収集→アジェンダ生成→Google Docsの新規タブ出力を実行します。

- サーバー管理権限が必要です。`/auth` と `/document` のサーバー専用設定を使用します。
- 対象はコマンド受付時刻を終了境界とする直近168時間（開始を含み、終了を含まない）。取得時点の投稿作成日時で判定します。
- モデルは `gpt-5.6-luna`、推論は `medium` 固定。Worker Secret `OPENAI_API_KEY` が必要です。`MTG_SUMMARY_MODEL` は通常MTGの通知用で、このコマンドでは使用しません。
- 進捗と完成したタブURLは `/mtg status id:受付ID` で確認します。`/mtg cancel id:受付ID` は収集開始前のみ有効です。チャンネル投稿・全員通知は行いません。
- Botが閲覧できるチャンネル・スレッドをその都度取得し、常設の収集設定は変更しません。収集範囲と取得できなかった処理は生成結果の `notes` に保持します。
- 「今週の要点／部門・テーマ別の進捗／今日話し合うこと」の3部構成です。Docs上では見出し・箇条書き・元投稿リンクを付け、関連する確認済みPNG/JPEG画像を文章のそばへ挿入します。
- 画像入力はPNG/JPEG/WebP、1枚300万バイト、20枚、Data URL合計1600万文字まで。未取得・上限超過・非対応画像と動画は元投稿リンクのみとし、内容を推測しません。WebPはAI入力可能ですがDocsへの画像挿入はPNG/JPEGのみです。
- デバッグ上限は2000投稿、投稿JSON合計150万文字、最大12回のOpenAI呼出。上限超過や投稿ゼロではDocs作成前に停止します。
- 生成結果はDurable Objectへ保存してからDocsに書き込みます。AIの途中失敗・結果不明時は自動再生成しません。Docsの書き込み結果が不明なときも自動再送せず、判明済みURLをstatusに表示します。
- 同じInteraction IDの再送は同一ジョブです。ユーザーがコマンドをもう一度実行すると別ジョブとなり、API料金と新規タブが発生します。

反映手順: `pnpm check` → `pnpm deploy` → `pnpm discord:register`。既存のMeetingSchedulerを使用し、追加D1マイグレーションは不要です。

## 生成モジュール

収集済み投稿をOpenAI Responses APIで整理し、次の固定ひな型で返します。

1. 今週の要点
2. 部門・テーマ別の進捗
3. 今日話し合うこと

表題は「［プロジェクト名］週次会議アジェンダ」、次に開催日時を記載します。デバッグ実行ではサーバー名をプロジェクト名に使い、開催日時は「要確認」とします。
要点は **成果／注意点／会議の焦点** の約3件。進捗は **予定 → 現状／やったこと・結果／分かったこと・考察／課題／次の予定**。議題は優先順に「議題① 具体的な問い」とし、**今回決めたいこと／判断材料／不足情報** を記載します。関係者・判断期限は判明しているものだけ最後に併記します。
空の項目を省略し、各項目1〜2文にします。関連投稿・返信を活動単位で整理し、後の訂正・解決を反映します。必要な数値・単位・条件と元投稿リンクを残し、事実・投稿者の考察・AIの案を区別します。投稿者を自動的に担当者とせず、未合意を決定済みとしません。判断に必要な不足は「要確認」とし、投稿がないことを「活動なし」としません。
確認済み画像は説明の直後に置き、着目点を説明に含めます。動画はリンクです。生成ルール・内部の収集メモは配布本文に載せません。Markdownとデバッグ用Docsは同じレイアウト定義を使います。

Bot・Google Docs出力側はAmpoi担当、投稿整理・アジェンダ生成側は本モジュールが担当します。
既存のDiscordコマンド、収集ジョブ、Docsキュー、DBマイグレーション、公開Worker設定はそのまま使用できます。
`/mtg debug` が以下の生成関数へ接続しています。

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
  coverageNotes: [],   // 任意。生成時の文脈と返却notesに保持。配布本文へは転記しない
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

`schemaVersion: 1`、`templateVersion: weekly-agenda-v2`。

| フィールド | 内容 |
|---|---|
| title / meetingAt | 文書名・開催日時 |
| agenda.summary | 今週の要点 |
| agenda.topics | 部門・テーマ別の進捗 |
| agenda.discussions | 今日話し合うこと |
| sources[messageId].url | 入力のIDから組み立てた元投稿URL |
| media[attachmentId] | 添付のstorage_key／path、元投稿、画像送信有無 |
| markdown | 確認用にひな型へ整形した本文 |
| notes | 収集範囲不足などの注記 |
| metadata | 期間、モデル、投稿件数、API呼出数・usage |

文章の単位は `{ text, sourceIds, mediaIds }`。根拠IDの存在を検証します。
APIとの通信中は投稿・添付IDをリクエスト単位の短い参照番号へ置き換え、返却時に元のDiscord IDへ戻します。未知の参照番号は拒否します。
添付を参照する文章には、その添付を含む実際の元投稿IDも出典として補完します。
部門・テーマはその部門の根拠投稿を必須とし、同じテーマに関連する他部門の課題報告も併記できます。
進捗は `previous`（前回予定）、`results`（作業・結果）、`insights`（考察）、`blockers`（課題）、`next`（予定・案）。
議題は `question`（今回決めたいこと）、`background` と `options`（合わせて判断材料）、`people`（関係者）、`deadline`（判断期限と理由）、`materials`（不足情報）。`materials` はv1の事前資料から意味を変更しています。
情報がない項目は空配列で、Markdown・Docsの両方で項目ごと省略します。要点の `text` は「成果：」「注意点：」「会議の焦点：」で分類し、関係者は根拠のある `@表示名` または `@部門名` を使用します。
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
`/mtg debug` は本番Workerからの呼出処理とDocsへの画像配置を実装済みです。デプロイ・コマンド登録・Secret設定後に利用できます。通常の `/mtg schedule` は従来どおり全履歴の記録と通知用3行要約です。

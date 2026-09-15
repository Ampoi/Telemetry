# アジェンダ生成とBot側の接続契約

## 前回議事録の引き継ぎと2回分のデバッグ

通常のアジェンダ作成時は、同じサーバー・保存先・履歴ソースの直前の通常MTGを探し、作成済みのDocsタブを読み直します。会議中の追記を含む本文から、前回までの決定・担当・期限・持ち越しを「予定 → 現状」へ引き継ぎます。議題や提案は合意として扱わず、今回の投稿に進捗がない作業は「進捗未確認」とします。完了・撤回の報告があれば反映します。根拠には元投稿と**前回議事録へのリンク**を付けます。

前回議事録がある場合、原文からの項目抽出にAIを1回使用し、決定・Todo・未決・取消の根拠原文と担当・期限を検証してから今回の投稿と照合します。生成文から欠落した抽出済み項目は確認事項として保持します。今回の投稿がなくても、前回議事録から引き継ぎ確認を生成できます。

前回のタブIDを使うため、タブの改名・移動後も読めます。他サーバー・別ドキュメント・未来の会議は参照しません。選択したタブが削除済み・空・閲覧不可ならエラーで止めます。新しいGoogle権限は不要です。生成開始時に本文を保存し、同じ処理の再開時に読み直しません。

R-1履歴を取り込んだサーバーでは次の順で試せます。

```text
/mtg debug from:2026-06-14 to:2026-06-21 previous:none
/mtg status
```

完成したタブに会議の決定事項・Todoを追記し、1回目の予約IDを指定します。

```text
/mtg debug from:2026-06-21 to:2026-06-28 previous:1回目の予約ID
```

`from`を含み`to`を含まない日本時間の期間です。両方指定し、1回の範囲は31日分以内。`previous:none`は前回なし、予約IDは対象の固定、省略は直前の通常MTGです。デバッグ結果は通常MTGの自動選択に入りません。`after`・`datetime`を省略したデバッグはチャンネルに投稿しません。

CLIではZIPから2回のAI生成を行い、ローカルのDocs形式に会議内容を追記して同じタブ読み取り関数で2回目へ渡せます。

```sh
pnpm run mtg:replay --zip /path/to/discord-backup.zip \
  --from 2026-06-14 --split 2026-06-21 --to 2026-06-28 \
  --notes examples/replay-meeting-notes.md --out exports/agenda-replay \
  --env-file .dev.vars
```

`OPENAI_API_KEY`が必要で、指定期間の投稿と仮議事録をOpenAI APIへ送信します。Luna・mediumで生成し、Docs実サービス・Discordには書き込みません。画像・動画の実データは送りません。出力は各回の入力・JSON・Markdown、追記後のDocs形式とテキスト、引き継ぎ項目、検証前のAI応答です。`--resume`は同じ入力の保存済み結果を再利用します。実行開始後に結果が保存されなかった回は自動再実行しません。原因を確認して新しい出力先で明示的に再実行してください。生成物には履歴が含まれるためGit管理外の`exports/`を使います。

## 即時実行するデバッグコマンド

```text
/mtg debug after:10
/mtg debug datetime:2026-09-16 20:00
```

`/settings` でMTGのボイスチャンネルを選択してください。開始1時間前に `@everyone`、通話チャンネル、完成したアジェンダのタブURLを投稿します。`datetime` は会議開始日時（JST）、`after:10` は10秒後に事前通知・会議はその1時間後です。アジェンダが未完成の場合は完成まで待ち、残り時間を添えて通知します。開始時刻を過ぎた通知は送りません。通常予約は2時間前にアジェンダ生成を開始します。

`/mtg debug` をサーバー内で実行すると、日程調整なしで収集→アジェンダ生成→Google Docsの新規タブ出力を実行します。

- サーバー管理権限が必要です。`/auth` と `/document` のサーバー専用設定を使用します。
- 指定期間がなければ受付時刻までの直近168時間を読みます。`from`・`to` を指定した場合はそのJST期間だけを読みます。R-1過去ログが設定済みでも、アーカイブ全体の保存期間に広げません。リモートD1の更新・削除も同じ期間に統合します。
- モデルは `gpt-5.6-luna`、推論は `medium` 固定。Worker Secret `OPENAI_API_KEY` が必要です。`MTG_SUMMARY_MODEL` は通常MTGの通知用で、このコマンドでは使用しません。
- 進捗・タブURL・開始通知は `/mtg status id:受付ID` で確認します。会議開始前は `/mtg cancel id:受付ID` で開始通知を取消可能。引数なしのdebugはアジェンダ作成だけで、チャンネル投稿はしません。
- Botが閲覧できるチャンネル・スレッドをその都度取得し、常設の収集設定は変更しません。収集範囲と取得できなかった処理は生成結果の `notes` に保持します。
- 「今週の要点／部門・テーマ別の進捗／今日話し合うこと」の3部構成です。Docs上では見出し・箇条書き・元投稿リンクを付け、関連する確認済みPNG/JPEG画像を文章のそばへ挿入します。
- 画像入力はPNG/JPEG/WebP、1枚300万バイト、20枚、Data URL合計1600万文字まで。未取得・上限超過・非対応画像と動画は元投稿リンクのみとし、内容を推測しません。WebPはAI入力可能ですがDocsへの画像挿入はPNG/JPEGのみです。
- Discord直接取得は2000投稿・投稿JSON150万文字・最大12回のOpenAI呼出。設定済み過去ログは10000投稿・投稿JSON800万文字・最大30回です。上限超過、または投稿も前回議事録もない場合はDocs作成前に停止します。
- 生成結果はDurable Objectへ保存してからDocsに書き込みます。AIの途中失敗・結果不明時は自動再生成しません。Docsの書き込み結果が不明なときも自動再送せず、判明済みURLをstatusに表示します。
- 同じInteraction IDの再送は同一ジョブです。ユーザーがコマンドをもう一度実行すると別ジョブとなり、API料金と新規タブが発生します。

反映手順: `pnpm run check` → `pnpm run db:remote` → `pnpm run deploy --keep-vars` → `pnpm run discord:register`。D1の `0011_meeting_agenda_sources.sql` とMeetingStartバインディングが必要です。

### R-1履歴の取り込み

```sh
pnpm exec tsx scripts/import-meeting-history.ts --zip /path/to/backup.zip --guild 利用先サーバーID --project R-1 --out exports/r1-history.sql
pnpm exec wrangler d1 execute telemetry --remote --file exports/r1-history.sql
```

ZIPは複数指定でき、投稿IDで統合して新しい編集を優先します。SQLと生ログはGitへコミットしません。D1へ全件保存してから利用先サーバーを結び付け、毎回の実行時にD1から読み取ります。元サーバーのcloud_messagesがあれば編集・削除を統合し、元投稿へのリンクは元サーバーIDのままです。同じZIPを再取り込みしても投稿は増えません。

## 生成モジュール

収集済み投稿をOpenAI Responses APIで整理し、次の固定ひな型で返します。

1. 今週の要点
2. 部門・テーマ別の進捗
3. 今日話し合うこと

単体モジュールの表題は「［プロジェクト名］週次会議アジェンダ」です。Discordの通常予約・デバッグでは表題とタブ名を開催日の `YYYY/MM/DD 定例mtg` に揃えます。開催日時・対象期間・過去ログに関する説明行は本文へ追加しません。R-1は本文を生成するプロジェクト名として渡します。
要点は **成果／注意点／会議の焦点** の約3件。進捗は **予定 → 現状／やったこと・結果／分かったこと・考察／課題／次の予定**。議題は優先順に「議題① 具体的な問い」とし、**今回決めたいこと／判断材料／不足情報** を記載します。関係者・判断期限は判明しているものだけ最後に併記します。
「今週の要点」の末尾に **今週の議題** 欄を設け、詳細と同じ順番で議題名だけを箇条書きにします。一覧には「議題①」などの番号を付けません。議題がない場合も見出しを残し、Google Docs上で追記できます。
空の項目を省略し、各項目1〜2文にします。関連投稿・返信を活動単位で整理し、後の訂正・解決を反映します。必要な数値・単位・条件と元投稿リンクを残し、事実・投稿者の考察・AIの案を区別します。投稿者を自動的に担当者とせず、未合意を決定済みとしません。判断に必要な不足は「要確認」とし、投稿がないことを「活動なし」としません。
確認済み画像は説明の直後に置き、着目点を説明に含めます。引用・添付の出典は文書内で共通の上付き番号（¹、²）を使い、同じ出典には同じ番号を付けます。Docsでは番号を小さい上付き文字として出典にリンクし、URL自体は表示しません。Markdownでも上付き数字のリンクです。生成ルール・内部の収集メモは配布本文に載せません。Markdownとデバッグ用Docsは同じレイアウト定義を使います。

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
  previousMinutes: '', // 任意。前回の決定・予定・持ち越しの原文（10万文字以内）
  // previousMinutesUrl: 'https://docs.google.com/document/d/DOCUMENT_ID/edit?tab=TAB_ID',
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
`/mtg debug` と通常の `/mtg schedule` は同じアジェンダ生成・Docs出力を使います。日時指定したデバッグと通常予約は、会議開始通知も独立して予約します。

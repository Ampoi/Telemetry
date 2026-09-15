export const discordCommands = [
  { name: 'settings', type: 1, description: 'このサーバーのMTG候補日・通知先・通話チャンネルを設定します', default_member_permissions: '32' },
  {
    name: 'mtg', type: 1, description: '会議を予約し、アジェンダ作成と開始通知を行います', default_member_permissions: '32',
    options: [
      { name: 'debug', type: 1, description: 'アジェンダを作成し、指定日時や指定秒数後にMTG開始を通知します', options: [
        { name: 'datetime', type: 3, description: '開始日時（日本時間 YYYY-MM-DD HH:mm）。afterとの併用不可', required: false },
        { name: 'after', type: 4, description: '何秒後に事前通知するか・会議はその1時間後（例：10）。datetimeとの併用不可', required: false, min_value: 1, max_value: 86400 },
        { name: 'from', type: 3, description: '投稿の開始日（日本時間 YYYY-MM-DD）。toと一緒に指定', required: false },
        { name: 'to', type: 3, description: '投稿の終了日（この日は含まない）。fromと一緒に指定', required: false },
        { name: 'previous', type: 3, description: '前回の予約ID。初回はnone、省略すると直前の通常MTG', required: false },
      ] },
      { name: 'schedule', type: 1, description: '次回MTGの日程調整ページを作成（Discordログインで空き時間を回答）' },
      { name: 'done', type: 1, description: '議事録の決定事項・メンバー別Todoを投稿し、次回の日程調整を開始', options: [
        { name: 'id', type: 3, description: '対象の予約ID（省略すると直近のMTG）', required: false },
      ] },
      { name: 'status', type: 1, description: '予約・実行状況と作成したタブを確認', options: [
        { name: 'id', type: 3, description: '予約ID（省略すると直近8件）', required: false },
      ] },
      { name: 'cancel', type: 1, description: '未開始の予約を取り消す', options: [
        { name: 'id', type: 3, description: '予約ID', required: true },
      ] },
    ],
  },
  {
    name: 'telemetry', type: 1, description: 'Discord収集Botの管理', default_member_permissions: '32',
    options: [
      { name: 'status', type: 1, description: '収集状況とエラーを確認する' },
      { name: 'backfill', type: 1, description: '指定日数分の履歴を取得する', options: [
        { name: 'days', type: 4, description: '過去何日分を取得するか', required: true, min_value: 1, max_value: 3650 },
      ] },
    ],
  },
  { name: 'auth', type: 1, description: 'このサーバー専用のGoogleアカウントを接続します', default_member_permissions: '32' },
  {
    name: 'document', type: 1, description: 'このサーバーの保存先ドキュメントを設定・確認します', default_member_permissions: '32',
    options: [
      { name: 'document', description: '保存先のGoogleドキュメントURLまたはID（省略で現在の設定を確認）', type: 3, required: false, max_length: 500 },
    ],
  },
];

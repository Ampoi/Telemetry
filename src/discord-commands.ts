export const discordCommands = [
  {
    name: 'mtg', type: 1, description: '日時を予約して全履歴を収集し、Google Docsのタブへ記録', default_member_permissions: '32',
    options: [
      { name: 'schedule', type: 1, description: '予約時刻に全チャンネル・スレッドの履歴収集を開始', options: [
        { name: 'datetime', type: 3, description: '実行日時（日本時間 YYYY-MM-DD HH:mm）', required: true, min_length: 16, max_length: 16 },
        { name: 'title', type: 3, description: '作成するタブ名', required: false, min_length: 1, max_length: 100 },
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
  {
    name: 'create', type: 1, description: 'このサーバーのGoogleドキュメントにデバッグ用タブを作成します', default_member_permissions: '32',
    options: [
      { name: 'document', description: '今回だけ使うURLまたはID（省略時はサーバーの保存先）', type: 3, required: false, max_length: 500 },
      { name: 'title', description: 'タブ名（省略時は作成日時）', type: 3, required: false, min_length: 1, max_length: 100 },
      { name: 'message', description: 'デバッグ用メモ', type: 3, required: false, max_length: 1000 },
    ],
  },
];

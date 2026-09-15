/** Self-contained OAuth result page. No scripts, remote fonts or assets. */
export function connectedPage(owner: string, nonce: string): string {
  const discord = owner.startsWith('discord:guild:');
  const destination = discord ? 'Discord' : 'ターミナル';
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <title>接続完了 — Telemetry</title>
  <style nonce="${nonce}">
    *{box-sizing:border-box}body{margin:0;background:#09090b;color:#fafafa;font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
    .page{min-height:100svh;display:flex;flex-direction:column;position:relative;isolation:isolate;overflow:hidden}
    .page::before{content:"";position:absolute;z-index:-1;inset:0;background:radial-gradient(ellipse at 50% 28%,#ffffff07,transparent 60%);pointer-events:none}
    header{padding:30px 40px;display:flex;align-items:center;gap:11px;font-size:14px;font-weight:600;letter-spacing:-.3px}.brand-icon{display:flex;align-items:center;gap:3px;height:24px}.brand-icon i{display:block;width:3px;background:#fafafa;border-radius:2px}.brand-icon i:nth-child(1),.brand-icon i:nth-child(4){height:10px}.brand-icon i:nth-child(2){height:22px}.brand-icon i:nth-child(3){height:16px}
    main{flex:1;display:grid;place-items:center;padding:36px 24px 68px}.card{width:100%;max-width:520px;border:1px solid #27272a;border-radius:18px;background:linear-gradient(150deg,#18181bcc,#0c0c0ef5);box-shadow:0 24px 90px #0006,0 1px 0 #ffffff05 inset;overflow:hidden}
    .content{padding:36px 36px 30px}.status{display:flex;align-items:center;gap:7px;color:#a1a1aa;font-size:11px;font-weight:500;letter-spacing:1.6px}.dot{height:6px;width:6px;background:#6ee7b7;border-radius:50%;box-shadow:0 0 12px #6ee7b733}.check{width:52px;height:52px;display:grid;place-items:center;margin:28px 0 22px;border:1px solid #3f3f46;border-radius:14px;background:linear-gradient(145deg,#27272a,#18181b);box-shadow:0 1px 0 #ffffff10 inset}.check svg{width:26px;height:26px}
    h1{font-size:26px;line-height:1.5;font-weight:600;letter-spacing:-1px;margin:0 0 12px;text-wrap:balance}.description{color:#a1a1aa;font-size:14px;line-height:1.9;margin:0}.connection{margin-top:26px;padding:15px 16px;display:flex;align-items:center;justify-content:space-between;gap:12px;border:1px solid #27272a;border-radius:10px;background:#09090b66}.service{font-size:13px;font-weight:500;display:flex;align-items:center;gap:10px}.service svg{width:18px;height:18px;color:#a1a1aa}.badge{font-size:11px;white-space:nowrap;color:#a7f3d0;border:1px solid #6ee7b726;background:#6ee7b709;border-radius:6px;padding:4px 8px}
    .next{border-top:1px solid #27272a;padding:26px 36px 30px;background:#09090b44}.label{font-size:11px;letter-spacing:1.4px;color:#71717a;font-weight:600;margin:0 0 18px}.step{display:flex;align-items:flex-start;gap:12px;margin-top:16px}.number{width:22px;height:22px;flex-shrink:0;display:grid;place-items:center;border:1px solid #3f3f46;border-radius:50%;font-size:10px;color:#a1a1aa}.step p{margin:0;color:#d4d4d8;font-size:13px;line-height:1.7}.step small{display:block;color:#71717a;margin-top:4px;font-size:12px}code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:#27272a;border:1px solid #3f3f4670;border-radius:4px;padding:2px 5px;font-size:11px;color:#e4e4e7}.return{display:flex;align-items:center;justify-content:center;gap:8px;margin-top:26px;background:#fafafa;color:#18181b;border:1px solid #fff;border-radius:8px;text-decoration:none;min-height:42px;font-size:13px;font-weight:600;transition:background .15s}.return:hover{background:#d4d4d8}.return:focus-visible{outline:2px solid #a1a1aa;outline-offset:4px}.return svg{width:15px;height:15px}.hint{text-align:center;color:#71717a;font-size:11px;line-height:1.8;margin:16px 0 0}footer{text-align:center;padding:0 24px 25px;color:#52525b;font-size:11px;letter-spacing:.2px}
    @media(max-width:540px){header{padding:24px}.content{padding:28px 24px 24px}.next{padding:24px}h1{font-size:23px}main{padding:20px 16px 40px}.card{border-radius:14px}}
  </style>
</head>
<body><div class="page">
  <header><span class="brand-icon" aria-hidden="true"><i></i><i></i><i></i><i></i></span>Telemetry</header>
  <main><article class="card" aria-labelledby="title">
    <div class="content">
      <div class="status"><span class="dot" aria-hidden="true"></span>CONNECTION COMPLETE</div>
      <div class="check" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="m6 12 4 4 8-8"/></svg></div>
      <h1 id="title">Googleドキュメントに<br>接続しました</h1>
      <p class="description">${discord ? 'このサーバー専用の接続が完了しました。<br>Discordに戻って、ドキュメントの準備を始めましょう。' : 'CLI用の接続が完了しました。<br>ターミナルに戻って、ドキュメントの準備を始めましょう。'}</p>
      <div class="connection"><span class="service"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M8 13h8M8 17h6"/></svg>Google Docs</span><span class="badge">接続済み</span></div>
    </div>
    <section class="next" aria-label="次のステップ"><p class="label">NEXT STEPS</p>
      <div class="step"><span class="number" aria-hidden="true">1</span><p>${destination}に戻る<small>この認証画面は閉じて大丈夫です。</small></p></div>
      <div class="step"><span class="number" aria-hidden="true">2</span><p>${discord ? '保存先を設定して、MTGの日程調整を開始' : '最初のタブを作成'}<small>${discord ? '<code>/document</code> で保存先を設定 → <code>/mtg schedule</code>' : '<code>pnpm run demo run --doc YOUR_DOCUMENT_ID</code>'}</small></p></div>
      ${discord ? '<a class="return" href="https://discord.com/channels/' + owner.slice('discord:guild:'.length) + '">Discordに戻る<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14m-5-5 5 5-5 5"/></svg></a>' : ''}
      <p class="hint">${discord ? 'この接続は、このサーバーの管理者間で共有されます。' : 'この接続はCLI専用です。Discordのサーバー接続とは独立しています。'}</p>
    </section>
  </article></main>
  <footer>Telemetry · Google Docs integration</footer>
</div></body></html>`;
}

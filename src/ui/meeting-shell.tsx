import { renderToStaticMarkup } from 'react-dom/server';
import { CalendarDays, ArrowUpRight, ArrowRight, Users, Check, Link, Globe2, LogOut, ShieldCheck, Orbit, MousePointer2 } from 'lucide-react';
import { Button } from '../components/ui/button';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { Alert } from '../components/ui/alert';
import { Skeleton } from '../components/ui/skeleton';

export function meetingShell() {
  return renderToStaticMarkup(<>
    <header className="site-header">
      <a href="#" className="brand" aria-label="Telemetry"><span className="brand-icon"><Orbit size={21}/></span>Telemetry<span className="brand-divider">/</span><span className="brand-section">Meetings</span></a>
      <div className="header-actions"><Badge variant="outline" className="timezone"><Globe2 size={12}/>Asia / Tokyo</Badge><span id="identity"/><Button variant="ghost" size="sm" id="logout" hidden><LogOut/>ログアウト</Button></div>
    </header>
    <main>
      <section id="intro" className="page-heading">
        <div><Badge variant="secondary" className="eyebrow"><span className="status-dot"/>日程調整</Badge><h1>次の定例、<span>いつにする？</span></h1><p>みんなの空き時間を、ひとつの予定に。<br className="mobile-break"/>全員の回答がそろうと、自動で日程が決まります。</p></div>
        <div className="heading-mark" aria-hidden="true"><CalendarDays size={38}/><span>次の定例mtg</span></div>
      </section>
      <Alert id="error" variant="destructive" hidden role="alert"/>
      <div id="status-line" className="status-line"><span className="status-dot"/><div id="notice" role="status">日程調整を読み込んでいます…</div><Badge variant="outline" id="status-badge">確認中</Badge></div>
      <div id="loading" aria-label="読み込み中"><Skeleton className="h-72 w-full rounded-xl"/><Skeleton className="h-72 w-full rounded-xl"/></div>
      <Card id="auth" hidden className="auth-card">
        <CardHeader className="items-center text-center"><div className="auth-icon"><Users size={26}/></div><Badge variant="outline">定例mtg</Badge><CardTitle className="auth-title">あなたの予定を教えてください</CardTitle><CardDescription>Discordでログインすると、<br/>そのまま空き時間を入力できます。</CardDescription></CardHeader>
        <CardContent><Button asChild className="login-button"><a href="/mtg/login?poll=__POLL_ID__">Discordでログイン<ArrowRight/></a></Button><div className="auth-note"><ShieldCheck size={14}/>同じサーバーのメンバーだけが参加できます</div></CardContent>
        <CardFooter className="auth-footer"><CalendarDays size={15}/>みんなの予定がそろったら、自動で確定</CardFooter>
      </Card>
      <Card id="confirmed" hidden tabIndex={-1} className="confirmed-card">
        <CardHeader className="items-center text-center"><div className="auth-icon"><Check size={28}/></div><Badge variant="secondary">日程確定</Badge><CardTitle className="auth-title">次のMTGが決まりました</CardTitle><CardDescription>みんなで話す時間を、カレンダーへ。</CardDescription></CardHeader>
        <CardContent className="text-center"><div id="confirmed-year"/><time id="confirmed-date"/><div id="confirmed-time"/><Badge variant="outline">日本時間 · JST</Badge><Alert id="confirmed-warning" hidden className="mt-6"/><Button variant="outline" id="copy-meeting" className="mt-8 w-full"><Link/>日時をコピー</Button><p id="copy-result" role="status"/></CardContent>
      </Card>
      <div id="schedule" hidden className="schedule-layout">
        <Card className="calendar-card">
          <CardHeader className="calendar-header"><div className="calendar-title-row"><div className="section-title"><CalendarDays size={19}/><CardTitle id="poll-title">定例mtg</CardTitle></div><Badge variant="outline" id="period">JST</Badge></div><CardDescription id="grid-help">クリック・ドラッグで空き時間を選択。もう一度選ぶと解除できます。</CardDescription></CardHeader>
          <div className="calendar-toolbar"><div className="legend"><span><i className="dot"/>自分の空き時間</span><span><i className="dot light"/>全員の空き時間</span></div><span className="slot-unit">30分単位 · JST</span></div>
          <CardContent className="calendar-content"><div className="scroll"><table aria-label="5日間の空き時間"><thead id="days"/><tbody id="slots"/></table></div></CardContent>
          <CardFooter className="calendar-footer"><span id="selection" aria-live="polite"/><Button id="save"><Check/><span id="save-label">空き時間を保存</span></Button></CardFooter>
        </Card>
        <aside className="sidebar">
          <Card className="participants-card"><CardHeader><div className="section-title"><Users size={18}/><CardTitle>みんなの回答</CardTitle></div><CardDescription>サーバーの全メンバー（Botを除く）が対象です。</CardDescription></CardHeader><CardContent><div className="progress-heading"><strong id="progress"/><span id="progress-percent"/></div><progress id="answer-progress" max="100" value="0" aria-label="回答の進捗"/><ul id="people"/></CardContent><CardFooter><Button variant="outline" id="copy" className="w-full"><Link/><span id="copy-label">招待リンクをコピー</span></Button></CardFooter></Card>
          <div className="schedule-help"><div className="section-title"><MousePointer2 size={15}/><h2>予定が決まるまで</h2></div><p id="rule">全員の回答がそろい、空き時間が重なると日程が決まります。</p><p id="priority-note" className="priority-note">候補が複数あれば、7日後に近い日・早い時刻を優先します。</p><Button variant="outline" id="manual" className="mt-4 w-full" hidden>主催者が日時を確定</Button><Button variant="secondary" id="exit-manual" className="mt-4 w-full" hidden>空き時間の入力に戻る</Button><Button variant="ghost" id="cancel" className="cancel-button" hidden>この日程調整を取り消す<ArrowUpRight/></Button></div>
        </aside>
      </div>
      <footer className="page-footer"><span>Telemetry</span><span>時間を合わせて、話を進めよう。</span></footer>
    </main>
  </>);
}

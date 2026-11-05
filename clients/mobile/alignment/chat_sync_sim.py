#!/usr/bin/env python3
# ══════════════════════════════════════════════
# 聊天增量同步的合并规则模拟：多台设备随机操作（含时钟偏差、同步中断、流式半截写入），
# 全网同步后断言各端一致，且再同步一轮没有任何传输（否则就是来回发送）。
#
#   python3 clients/mobile/alignment/chat_sync_sim.py [轮数，默认 300]
#
# 这里的规则和 desktop db.rs chat_sync_import、手机 SolevupDb.kt importChatPage 是同一套，
# 但没有跑真实代码。改任何一端的合并规则，都要同时改这里并重新跑。
# ══════════════════════════════════════════════
import random, sqlite3, sys

# 分页故意很小，把翻页路径都跑到
ROWS, MAX_BYTES = 3, 40
SKEW = 30

SCHEMA = """
CREATE TABLE chat_sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '新会话', summary TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, meta_updated_at TEXT, deleted_at TEXT);
CREATE TABLE chat_messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL, content TEXT, timestamp TEXT NOT NULL);
CREATE TABLE chat_sync_log (seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, entity_id TEXT NOT NULL, origin TEXT, UNIQUE(kind, entity_id));
CREATE TABLE chat_sync_cursor (peer_device_id TEXT PRIMARY KEY, pull_seq INTEGER NOT NULL DEFAULT 0, push_seq INTEGER NOT NULL DEFAULT 0);
CREATE TRIGGER chat_sessions_log_insert AFTER INSERT ON chat_sessions BEGIN INSERT OR REPLACE INTO chat_sync_log (kind, entity_id) VALUES ('s', NEW.id); END;
CREATE TRIGGER chat_sessions_log_update AFTER UPDATE ON chat_sessions BEGIN INSERT OR REPLACE INTO chat_sync_log (kind, entity_id) VALUES ('s', NEW.id); END;
CREATE TRIGGER chat_sessions_log_delete AFTER DELETE ON chat_sessions BEGIN DELETE FROM chat_sync_log WHERE kind = 's' AND entity_id = OLD.id; END;
CREATE TRIGGER chat_messages_log_insert AFTER INSERT ON chat_messages BEGIN INSERT OR REPLACE INTO chat_sync_log (kind, entity_id) VALUES ('m', NEW.id); END;
CREATE TRIGGER chat_messages_log_delete AFTER DELETE ON chat_messages BEGIN DELETE FROM chat_sync_log WHERE kind = 'm' AND entity_id = OLD.id; END;
"""

# 对应 db.rs 的 CHAT_META_BUMP_SQL：本机时钟慢时也要比已有值新，否则改名会被丢掉
META_BUMP = """CASE WHEN COALESCE(meta_updated_at, created_at) >= ?2
  THEN COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', COALESCE(meta_updated_at, created_at), '+0.001 seconds'), ?2)
  ELSE ?2 END"""


class Device:
    def __init__(self, name):
        self.name = name
        self.db = sqlite3.connect(':memory:', isolation_level=None)
        self.db.executescript(SCHEMA)
        self.db.execute('PRAGMA foreign_keys = ON')

    def cursor(self, peer):
        row = self.db.execute('SELECT pull_seq, push_seq FROM chat_sync_cursor WHERE peer_device_id=?', (peer,)).fetchone()
        return row or (0, 0)

    def save_cursor(self, peer, column, seq):
        self.db.execute(
            f'INSERT INTO chat_sync_cursor (peer_device_id, {column}) VALUES (?, ?) '
            f'ON CONFLICT(peer_device_id) DO UPDATE SET {column}=excluded.{column}', (peer, seq))

    def export_page(self, since, peer):
        d = self.db
        max_seq = d.execute('SELECT COALESCE(MAX(seq),0) FROM chat_sync_log').fetchone()[0]
        entries = d.execute(
            'SELECT seq, kind, entity_id FROM chat_sync_log WHERE seq > ? AND (origin IS NULL OR origin <> ?) ORDER BY seq LIMIT ?',
            (since, peer or '', ROWS)).fetchall()
        session_ids, messages, seen, size, last, truncated = [], [], set(), 0, since, len(entries) >= ROWS
        for seq, kind, entity in entries:
            last = seq
            if kind == 's':
                if entity not in seen:
                    seen.add(entity)
                    session_ids.append(entity)
            else:
                row = d.execute(
                    "SELECT id, session_id, role, content, timestamp FROM chat_messages WHERE id=? AND role IN ('user','assistant','tool')",
                    (entity,)).fetchone()
                if row is None:
                    continue
                size += len(row[3] or '')
                if row[1] not in seen:
                    seen.add(row[1])
                    session_ids.append(row[1])
                messages.append(row)
            if size >= MAX_BYTES:
                truncated = True
                break
        sessions = []
        for sid in session_ids:
            row = d.execute("""SELECT s.id, s.title, s.summary, s.created_at, s.updated_at, COALESCE(s.meta_updated_at, s.created_at), s.deleted_at
                FROM chat_sessions s WHERE s.id=? AND (s.deleted_at IS NOT NULL OR EXISTS (SELECT 1 FROM chat_messages m WHERE m.session_id=s.id))""",
                (sid,)).fetchone()
            if row:
                sessions.append(row)
        return dict(device=self.name, seq=last if truncated else max_seq, more=truncated, sessions=sessions, messages=messages)

    def import_page(self, page):
        d = self.db
        d.execute('BEGIN')
        before = d.execute('SELECT COALESCE(MAX(seq),0) FROM chat_sync_log').fetchone()[0]
        keep_local = []
        for row in page['sessions']:
            sid, title, summary, _created, updated, meta, deleted = row
            local = d.execute(
                "SELECT COALESCE(meta_updated_at, created_at), updated_at, deleted_at, title, COALESCE(summary, '') FROM chat_sessions WHERE id=?",
                (sid,)).fetchone()
            if local is None:
                d.execute('INSERT INTO chat_sessions (id,title,summary,created_at,updated_at,meta_updated_at,deleted_at) VALUES (?,?,?,?,?,?,?)', row)
                continue
            local_meta, local_updated, local_deleted, local_title, local_summary = local
            # 删除优先且不可撤销；其余按 meta_updated_at LWW，时间相同比标题和摘要，两端才会选同一个
            newer = (meta, title, summary or '') > (local_meta, local_title, local_summary)
            if local_deleted is not None:
                apply_meta = deleted is not None and newer
            else:
                apply_meta = deleted is not None or newer
            if apply_meta:
                d.execute('UPDATE chat_sessions SET title=?, summary=?, meta_updated_at=?, deleted_at=? WHERE id=?', (title, summary, meta, deleted, sid))
                if deleted is not None:
                    d.execute('DELETE FROM chat_messages WHERE session_id=?', (sid,))
            if updated > local_updated:
                d.execute('UPDATE chat_sessions SET updated_at=? WHERE id=?', (updated, sid))
            # 合并结果和对方发来的不一样：对方还不知道本地这份，日志不能标成来自对方
            merged = d.execute('SELECT title, summary, updated_at, COALESCE(meta_updated_at, created_at), deleted_at FROM chat_sessions WHERE id=?', (sid,)).fetchone()
            if merged != (title, summary, updated, meta, deleted):
                keep_local.append(sid)
        for mid, sid, role, content, ts in page['messages']:
            if not d.execute('SELECT EXISTS(SELECT 1 FROM chat_sessions WHERE id=? AND deleted_at IS NULL)', (sid,)).fetchone()[0]:
                continue
            local = d.execute('SELECT content FROM chat_messages WHERE id=?', (mid,)).fetchone()
            if local is None:
                d.execute('INSERT INTO chat_messages (id, session_id, role, content, timestamp) VALUES (?,?,?,?,?)', (mid, sid, role, content, ts))
            elif (len(content or ''), content or '') > (len(local[0] or ''), local[0] or ''):
                # 同 id 消息只接受变长版本（流式半截先同步过去的情况）；手动登记日志，第三台设备才收得到
                d.execute('UPDATE chat_messages SET content=? WHERE id=?', (content, mid))
                d.execute("INSERT OR REPLACE INTO chat_sync_log (kind, entity_id) VALUES ('m', ?)", (mid,))
        d.execute('UPDATE chat_sync_log SET origin=? WHERE seq > ?', (page['device'], before))
        for sid in keep_local:
            d.execute("UPDATE chat_sync_log SET origin=NULL WHERE kind='s' AND entity_id=? AND seq > ?", (sid, before))
        d.execute('COMMIT')

    def state(self):
        sessions = self.db.execute("""SELECT id, title, summary, updated_at, COALESCE(meta_updated_at, created_at), deleted_at FROM chat_sessions s
            WHERE deleted_at IS NOT NULL OR EXISTS (SELECT 1 FROM chat_messages m WHERE m.session_id=s.id) ORDER BY id""").fetchall()
        messages = self.db.execute('SELECT id, session_id, content FROM chat_messages ORDER BY id').fetchall()
        return sessions, messages

    # ── 本机写入，对应两端的 CRUD ──

    def rename(self, sid, title, now):
        self.db.execute(f'UPDATE chat_sessions SET title=?1, meta_updated_at={META_BUMP} WHERE id=?3 AND deleted_at IS NULL', (title, now, sid))

    def delete(self, sid, now):
        self.db.execute('DELETE FROM chat_messages WHERE session_id=?', (sid,))
        self.db.execute("UPDATE chat_sessions SET title='', summary=NULL, deleted_at=?, meta_updated_at=? WHERE id=? AND deleted_at IS NULL", (now, now, sid))

    def append(self, mid, sid, role, content, now):
        # 墓碑不写、空占位不写、已有行只在内容变了才写并手动登记日志
        if self.db.execute('SELECT 1 FROM chat_sessions WHERE id=? AND deleted_at IS NOT NULL', (sid,)).fetchone():
            return
        local = self.db.execute('SELECT content FROM chat_messages WHERE id=?', (mid,)).fetchone()
        if local is None:
            if role == 'assistant' and not content:
                return
            self.db.execute('INSERT INTO chat_messages (id, session_id, role, content, timestamp) VALUES (?,?,?,?,?)', (mid, sid, role, content, now))
        else:
            new = content or local[0]
            if new == local[0]:
                return
            self.db.execute('UPDATE chat_messages SET content=? WHERE id=?', (new, mid))
            self.db.execute("INSERT OR REPLACE INTO chat_sync_log (kind, entity_id) VALUES ('m', ?)", (mid,))
        self.db.execute('UPDATE chat_sessions SET updated_at=MAX(updated_at, ?) WHERE id=?', (now, sid))


class Interrupted(Exception):
    pass


sent = [0]


def sync(a, b, rnd=None, fail=0.0):
    """a 主动发起：先拉后推，游标在收到结果后才保存，和两端的 sync_chat 一致"""
    pull, push = a.cursor(b.name)
    since = pull
    while True:
        page = b.export_page(since, a.name)
        sent[0] += len(page['sessions']) + len(page['messages'])
        a.import_page(page)
        if rnd and rnd.random() < fail:
            raise Interrupted()
        a.save_cursor(b.name, 'pull_seq', page['seq'])
        since = page['seq']
        if not page['more']:
            break
    since = push
    while True:
        page = a.export_page(since, b.name)
        sent[0] += len(page['sessions']) + len(page['messages'])
        if page['sessions'] or page['messages']:
            b.import_page(page)
        if rnd and rnd.random() < fail:
            raise Interrupted()
        a.save_cursor(b.name, 'push_seq', page['seq'])
        since = page['seq']
        if not page['more']:
            break


class Clock:
    t = 0

    def now(self, skew=0):
        self.t += 1
        v = self.t + skew
        return f'2026-11-05T{v // 3600:02d}:{(v // 60) % 60:02d}:{v % 60:02d}.000Z'


def run(seed, n=3, ops=120):
    rnd = random.Random(seed)
    clock = Clock()
    devices = [Device(chr(65 + i)) for i in range(n)]
    skews = {d.name: rnd.randint(-SKEW, SKEW) + SKEW + 100 for d in devices}
    streaming = {d.name: [] for d in devices}  # 流式途中的消息：[id, 会话, 内容]
    uid = interrupted = chatter = 0
    for _ in range(ops):
        d = rnd.choice(devices)
        op = rnd.random()
        uid += 1
        now = clock.now(skews[d.name])
        live = [r[0] for r in d.db.execute('SELECT id FROM chat_sessions WHERE deleted_at IS NULL')]
        if op < .15 or not live:
            d.db.execute('INSERT INTO chat_sessions (id, created_at, updated_at, meta_updated_at) VALUES (?,?,?,?)', (f's{uid}', now, now, now))
        elif op < .55:
            d.append(f'm{uid}', rnd.choice(live), rnd.choice(['user', 'assistant', 'tool']), 'x' * rnd.randint(1, 30), now)
        elif op < .62:
            d.rename(rnd.choice(live), f't{uid}', now)
        elif op < .66:
            d.delete(rnd.choice(live), now)
        elif op < .69:
            # 界面还开着已被同步删掉的会话，继续写消息
            every = [r[0] for r in d.db.execute('SELECT id FROM chat_sessions')]
            d.append(f'm{uid}', rnd.choice(every), 'user', 'y' * 5, now)
        elif op < .73:
            sid = rnd.choice(live)
            streaming[d.name].append([f'm{uid}', sid, ''])
            d.append(f'm{uid}', sid, 'assistant', '', now)
        elif op < .78 and streaming[d.name]:
            m = rnd.choice(streaming[d.name])
            m[2] += 'z' * rnd.randint(1, 8)
            d.append(m[0], m[1], 'assistant', m[2], now)
        elif op < .78:
            d.db.execute('DELETE FROM chat_sessions WHERE deleted_at IS NULL AND id NOT IN (SELECT session_id FROM chat_messages)')
        else:
            a, b = rnd.sample(devices, 2)
            try:
                sync(a, b, rnd, 0.15)
            except Interrupted:
                interrupted += 1
    for d in devices:
        for m in streaming[d.name]:
            m[2] += 'END'
            d.append(m[0], m[1], 'assistant', m[2], clock.now(skews[d.name]))
    for _ in range(4):
        for a in devices:
            for b in devices:
                if a is not b:
                    sync(a, b)
    states = [d.state() for d in devices]
    converged = all(s == states[0] for s in states)
    sent[0] = 0
    for a in devices:
        for b in devices:
            if a is not b:
                sync(a, b)
    chatter = sent[0]
    return converged, chatter, interrupted, len(states[0][0]), len(states[0][1])


def main():
    rounds = int(sys.argv[1]) if len(sys.argv) > 1 else 300
    diverged, noisy, interrupted, sessions, messages = [], 0, 0, 0, 0
    for seed in range(rounds):
        ok, chatter, stops, ns, nm = run(seed, n=2 + seed % 3)
        if not ok:
            diverged.append(seed)
        noisy += 1 if chatter else 0
        interrupted += stops
        sessions += ns
        messages += nm
    print(f'{rounds} 轮：不收敛 {len(diverged)}，收敛后仍有传输 {noisy}（注入中断 {interrupted} 次，终态共 {sessions} 会话 {messages} 消息）')
    if diverged:
        print('不收敛的 seed:', diverged[:10])
    sys.exit(1 if diverged or noisy else 0)


if __name__ == '__main__':
    main()

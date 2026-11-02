/* SBP Console —— 一个页面看 N 台服务器
 *
 * 每台机器上跑着 sbp-server（面板用 --bridge 把本机会话上报上去），这里只保存
 * 「服务器地址 + 鉴权」的列表，左上角下拉切机器。所有数据都走 SBP 的 WebSocket：
 *   hello → session.list → session.attach → session.history / output.delta / session.prompt
 * 没有构建步骤，三个文件丢到任意静态目录（或本地 file://）就能跑。
 */
(function () {
  'use strict'

  var V = 'sbp/0.1'
  var LS_SERVERS = 'sbp_console_servers'
  var LS_CURRENT = 'sbp_console_current'
  var HB_INTERVAL = 20          // 心跳间隔（秒）
  var HB_TIMEOUT = 60           // 多久没任何回包就重连（秒）

  // ------------------------------------------------------------------ 工具
  function $(id) { return document.getElementById(id) }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
    })
  }

  /** 极轻量的 markdown：```代码块``` + 行内 `code` + **粗体** + 裸链接。
   *  先整段转义再加标签，所以 agent 输出里的 <script> 永远不会被当 HTML 执行。 */
  function md(text) {
    var blocks = []
    var s = String(text == null ? '' : text)
    // 代码块先摘出来，免得里面的 * 和 ` 被后面的规则误伤
    s = s.replace(/```[a-zA-Z0-9_+-]*\n([\s\S]*?)```/g, function (_, body) {
      blocks.push(body.replace(/\s+$/, ''))
      return '\u0000CB' + (blocks.length - 1) + '\u0000'
    })
    s = esc(s)
    s = s.replace(/`([^`\n]{1,200})`/g, '<code>$1</code>')
    s = s.replace(/\*\*([^*\n]{1,200})\*\*/g, '<b>$1</b>')
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<>"')]+)/g,
      '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>')
    s = s.replace(/\u0000CB(\d+)\u0000/g, function (_, i) {
      return '<pre class="code">' + esc(blocks[+i]) + '</pre>'
    })
    return s
  }

  function ago(ts) {
    if (!ts) return ''
    var d = Math.max(0, Date.now() - ts) / 1000
    if (typeof ts === 'string') return ''      // claude 的 ts 是 ISO 串，不硬转
    if (d < 60) return '刚刚'
    if (d < 3600) return Math.floor(d / 60) + ' 分钟前'
    if (d < 86400) return Math.floor(d / 3600) + ' 小时前'
    return Math.floor(d / 86400) + ' 天前'
  }
  /** ISO / 毫秒时间戳 -> HH:MM；解析不出来就空串（历史消息的 ts 是 ISO 串） */
  function hms(ts) {
    if (!ts) return ''
    var d = typeof ts === 'number' ? new Date(ts) : new Date(String(ts))
    if (isNaN(d.getTime())) return ''
    return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2)
  }
  /** agent id -> 头像字母 / 配色 class（见 console.css 的 .ag.*） */
  function agentKey(agent, kind) {
    if (kind === 'shell') return 'shell'
    var a = String(agent || '').toLowerCase()
    if (!a) return ''
    if (a.indexOf('claude') > -1) return 'claude'
    if (a.indexOf('codex') > -1) return 'codex'
    if (a.indexOf('dsh') > -1) return 'dsh'
    if (a.indexOf('qwen') > -1) return 'qwen'
    return ''
  }
  function agentName(it) {
    if (!it) return ''
    if (it.kind === 'shell') return '空终端'
    return it.agent_display || it.agent || it.kind || ''
  }
  /** 会话「能不能敲字」：term / shell / claude 只要在 tmux 里都行，这里只看 kind */
  function isShell(it) { return !!it && it.kind === 'shell' }
  /** 有没有可翻的落盘历史：claude 一定有；term 要看设备有没有绑上历史文件 */
  function hasHistory(it) {
    if (!it) return false
    if (it.kind === 'claude') return true
    return !!it.has_history
  }
  function isLive(it) {
    if (!it) return false
    // 老设备只报 status（running/idle），新设备报 active；两个都认
    return it.active === true || it.status === 'running'
  }
  function toast(msg, kind) {
    var t = $('toast')
    t.textContent = msg
    t.className = 'toast show' + (kind ? ' ' + kind : '')
    clearTimeout(toast._t)
    toast._t = setTimeout(function () { t.className = 'toast' }, 2600)
  }

  // ------------------------------------------------------------------ 地址
  /** scheme://host:port/path 一律补全成 ws(s) 地址，缺省路径 /ws（E2EE 用 /ws-e2ee） */
  function wsUrl(raw, e2ee) {
    var s = String(raw || '').trim().replace(/\/+$/, '')
    if (!s) return ''
    var scheme = 'wss'
    if (/^ws:\/\//i.test(s)) { scheme = 'ws'; s = s.slice(5) }
    else if (/^wss:\/\//i.test(s)) { s = s.slice(6) }
    else if (/^http:\/\//i.test(s)) { scheme = 'ws'; s = s.slice(7) }
    else if (/^https:\/\//i.test(s)) { s = s.slice(8) }
    var slash = s.indexOf('/')
    var hostport = slash > -1 ? s.slice(0, slash) : s
    var path = slash > -1 ? s.slice(slash) : '/ws'
    if (!path || path === '/') path = e2ee ? '/ws-e2ee' : '/ws'
    // 写成 wss://host/sbp-ecs 时，nginx 的 location 是 /sbp-ecs/，
    // 少了那道斜杠会被 301 —— WebSocket 握手吃不下 301，所以这里补成 /sbp-ecs/ws
    else if (!e2ee && !/\/(ws|sbp)$/.test(path) && !path.endsWith('/ws')) {
      path = path.replace(/\/+$/, '') + '/ws'
    } else if (e2ee && !/\/ws-e2ee$/.test(path) && !path.endsWith('/ws-e2ee')) {
      path = path.replace(/\/+$/, '') + '/ws-e2ee'
    }
    return scheme + '://' + hostport + path
  }
  /** 同一个地址换成 http(s)，用来探 /api/health */
  function httpBase(raw) {
    var w = wsUrl(raw)
    if (!w) return ''
    var i = w.indexOf('://')
    var scheme = w.slice(0, i) === 'ws' ? 'http' : 'https'
    var rest = w.slice(i + 3)
    var j = rest.indexOf('/')
    return scheme + '://' + (j > -1 ? rest.slice(0, j) : rest)
  }

  // ------------------------------------------------------------------ 服务器列表
  function loadServers() {
    try {
      var v = JSON.parse(localStorage.getItem(LS_SERVERS) || '[]')
      return Array.isArray(v) ? v : []
    } catch (e) { return [] }
  }
  function saveServers(list) { localStorage.setItem(LS_SERVERS, JSON.stringify(list)) }
  function blankServer() {
    return { id: 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
             name: '', url: 'wss://', auth: 'hmac', keyId: '', secret: '', token: '',
             e2ee: false, did: '', myKeyId: 'cli', rk: '',
             peerKeyId: 'dev', peerBoxPk: '', peerSignPk: '' }
  }
  function titleOf(s) { return s.name || s.url || '未命名' }

  // ------------------------------------------------------------------ 连接
  function Conn(onFrame, onState) {
    this.onFrame = onFrame
    this.onState = onState
    this.ws = null
    this.cfg = null
    this.n = 0
    this.pending = {}
    this.hbTimer = null
    this.lastRecv = 0
    this.retry = 0
    this.reconnectTimer = null
    this.closedByUser = false
    this.state = 'closed'
  }
  Conn.prototype._setState = function (s, extra) {
    this.state = s
    if (this.onState) this.onState(s, extra)
  }
  Conn.prototype.connect = function (cfg) {
    this.close()
    this.cfg = cfg
    this.closedByUser = false
    this.link = null
    this._e2eeOpen = false
    var that = this
    var url = wsUrl(cfg.url, cfg.e2ee)
    if (!url) { this._setState('error', '地址为空'); return }
    this._setState('connecting', url)
    var ws
    try { ws = new WebSocket(url) } catch (e) { this._setState('error', String(e)); this._retry(); return }
    this.ws = ws
    ws.onopen = function () {
      that.lastRecv = Date.now()
      that.retry = 0
      // ---- E2EE 握手：发签名挑战，等 hello.ok，再订阅设备 tag ----
      if (cfg.e2ee) {
        SbpE2EE.ready.then(function () {
          var link
          try { link = buildLink(cfg) } catch (e) { that._setState('error', 'E2EE 配置错误：' + e.message); ws.close(); return }
          that.link = link
          that.ws.send(JSON.stringify(link.hello()))
        }).catch(function () { that._setState('error', 'libsodium 初始化失败'); ws.close() })
        return
      }
      var hp = { role: 'client' }
      if (cfg.auth === 'hmac') hp.auth = window.SbpHmac.auth(cfg)
      else if ((cfg.auth === 'token' || cfg.auth === 'bearer') && cfg.token) hp.token = cfg.token
      that.req('hello', hp, 8000).then(function (r) {
        that._setState('open', r.payload || {})
      }).catch(function (e) {
        that._setState('error', (e && e.msg) || '握手失败')
        ws.close()
      })
      that._hb()
    }
    ws.onmessage = function (ev) {
      that.lastRecv = Date.now()
      var f
      try { f = JSON.parse(ev.data) } catch (e) { return }
      if (that.link) {
        if (f.ctl) return                                  // 中继控制帧（sub/unsub），本地忽略
        if (f.cipher) {                                    // 信封：解密成内层帧
          try { f = that.link.recv(f) } catch (e) { return }
        }
        // 否则是明文的中继帧（如 hello.ok），原样透传
      }
      if (f.type === 'res' && f.name === 'hello.ok' && that.link && !that._e2eeOpen) {
        that._e2eeOpen = true
        that.ws.send(JSON.stringify(that.link.subscribe(that.link.deviceScope())))
        that._setState('open', (f.payload || {}))
        return
      }
      if (f.type === 'res' && f.ref && that.pending[f.ref]) {
        var p = that.pending[f.ref]
        delete that.pending[f.ref]
        if (f.ok) p.resolve(f); else p.reject(f.err || { code: 'E_FAIL', msg: '请求失败' })
        return
      }
      if (f.type === 'evt') that.onFrame(f)
    }
    ws.onclose = function () {
      that._stopHb()
      if (that.closedByUser) { that._setState('closed'); return }
      that._setState('closed')
      that._retry()
    }
    ws.onerror = function () { /* close 里统一处理重连 */ }
  }
  Conn.prototype._retry = function () {
    var that = this
    if (this.closedByUser) return
    this.retry = Math.min(this.retry + 1, 6)
    var wait = Math.min(30, Math.pow(1.8, this.retry))
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = setTimeout(function () {
      if (that.cfg && !that.closedByUser) that.connect(that.cfg)
    }, wait * 1000)
    this._setState('reconnect', Math.round(wait))
  }
  Conn.prototype._hb = function () {
    var that = this
    this._stopHb()
    this.hbTimer = setInterval(function () {
      if (!that.ws || that.ws.readyState !== 1) return
      if (Date.now() - that.lastRecv > HB_TIMEOUT * 1000) { try { that.ws.close() } catch (e) {} return }
      that.req('ping', { t: Date.now() }, 8000).catch(function () {})
    }, HB_INTERVAL * 1000)
  }
  Conn.prototype._stopHb = function () { if (this.hbTimer) { clearInterval(this.hbTimer); this.hbTimer = null } }
  Conn.prototype.req = function (name, payload, timeout) {
    var that = this
    if (!this.ws || this.ws.readyState !== 1) {
      return Promise.reject({ code: 'E_NOT_OPEN', msg: '未连接' })
    }
    this.n += 1
    var id = 'r' + this.n
    var p = { resolve: null, reject: null }
    var pr = new Promise(function (res, rej) { p.resolve = res; p.reject = rej })
    this.pending[id] = p
    try {
      var frame
      if (this.link) {
        // E2EE：把内层 SBP 帧封进信封（按 tag 路由、对端公钥加密、本机签名）
        var inner = { v: V, id: id, type: 'req', name: name, payload: payload || {} }
        var sid = (payload && payload.sid) || null
        if (sid) inner.sid = sid
        var scope = sid ? this.link.sessionScope(sid) : this.link.deviceScope()
        frame = this.link.send(inner, scope)
      } else {
        frame = { v: V, id: id, type: 'req', name: name, payload: payload || {} }
        var s = (payload && payload.sid) || null
        if (s) frame.sid = s
      }
      this.ws.send(JSON.stringify(frame))
    } catch (e) {
      delete this.pending[id]
      return Promise.reject({ code: 'E_SEND', msg: '发送失败' })
    }
    setTimeout(function () {
      if (that.pending[id]) {
        delete that.pending[id]
        p.reject({ code: 'E_TIMEOUT', msg: '请求超时' })
      }
    }, timeout || 10000)
    return pr
  }
  Conn.prototype.close = function () {
    this.closedByUser = true
    clearTimeout(this.reconnectTimer)
    this._stopHb()
    if (this.ws) { try { this.ws.close() } catch (e) {} }
    this.ws = null
    this.pending = {}
  }
  // ---- E2EE：订阅 / 退订某个会话 tag（让中继把该会话的密文投给我们） ----
  Conn.prototype.subscribeSession = function (sid) {
    if (this.link && this.ws && this.ws.readyState === 1)
      this.ws.send(JSON.stringify(this.link.subscribe(this.link.sessionScope(sid))))
  }
  Conn.prototype.unsubscribeSession = function (sid) {
    if (this.link && this.ws && this.ws.readyState === 1)
      this.ws.send(JSON.stringify(this.link.unsubscribe(this.link.sessionScope(sid))))
  }

  // ------------------------------------------------------------------ 导入
  // sbp1. 连接串的解析放在 e2ee.js 里，控制台和小程序共用一份
  var CONNECT_PREFIX = SbpE2EE.CONNECT_PREFIX
  function newId() {
    return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5)
  }
  function parseImportText(text) { return SbpE2EE.parseConnectText(text) }

  // ------------------------------------------------------------------ E2EE 链路构造
  /** 从服务器配置 + 本地 localStorage 构造 E2EELink。本机私钥只存在 localStorage。 */
  function buildLink(cfg) {
    var storeKey = 'sbp_e2ee_' + cfg.id
    var stored = null
    try { stored = JSON.parse(localStorage.getItem(storeKey) || 'null') } catch (e) {}
    // 导入进来的连接串自带私钥，优先用它（中继那边已经登记过这对公钥了）
    if (cfg.box_sk && cfg.sign_sk && (!stored || stored.box_sk !== cfg.box_sk)) {
      stored = {
        box_sk: cfg.box_sk, sign_sk: cfg.sign_sk,
        box_pk: cfg.box_pk || '', sign_pk: cfg.sign_pk || ''
      }
      try { localStorage.setItem(storeKey, JSON.stringify(stored)) } catch (e) {}
    }
    if (!stored || !stored.box_sk || !stored.sign_sk) {
      var kp = SbpE2EE.generateKeypair()
      stored = {
        box_sk: SbpE2EE.b64u_encode(kp.box_sk), sign_sk: SbpE2EE.b64u_encode(kp.sign_sk),
        box_pk: SbpE2EE.b64u_encode(kp.box_pk), sign_pk: SbpE2EE.b64u_encode(kp.sign_pk)
      }
      localStorage.setItem(storeKey, JSON.stringify(stored))
    }
    var kp = {
      box_sk: SbpE2EE.b64u_decode(stored.box_sk),
      sign_sk: SbpE2EE.b64u_decode(stored.sign_sk)
    }
    var rk = SbpE2EE.deriveRk(cfg.rk)
    return new SbpE2EE.E2EELink({
      kp: kp,
      peerBoxPk: SbpE2EE.b64u_decode(cfg.peerBoxPk),
      peerSignPk: SbpE2EE.b64u_decode(cfg.peerSignPk),
      rk: rk,
      keyId: cfg.myKeyId || 'cli',
      did: cfg.did,
      role: 'client'
    })
  }

  // ------------------------------------------------------------------ App
  var LS_HIST = 'sbp_console_hist'      // 每个会话的「历史折叠」记忆：{sid: 1}
  function histHidden(sid) {
    try { return !!JSON.parse(localStorage.getItem(LS_HIST) || '{}')[sid] } catch (e) { return false }
  }
  function setHistHidden(sid, v) {
    var m = {}
    try { m = JSON.parse(localStorage.getItem(LS_HIST) || '{}') || {} } catch (e) { m = {} }
    if (v) m[sid] = 1; else delete m[sid]
    try { localStorage.setItem(LS_HIST, JSON.stringify(m)) } catch (e) {}
  }

  var App = {
    servers: [], curId: null, conn: null,
    groups: [], sessions: [],
    sid: '', kind: '', tmux: '', meta: {}, msgs: [], before: null, hasMore: false,
    screen: [], prompt: null, editable: false, loadingOlder: false, state: 'idle',

    init: function () {
      var that = this
      this.servers = loadServers()
      this.importFromUrl()
      this.curId = localStorage.getItem(LS_CURRENT)
      if (!this._find(this.curId)) this.curId = this.servers.length ? this.servers[0].id : null
      this.conn = new Conn(function (f) { that.onFrame(f) }, function (s, x) { that.onState(s, x) })
      this.bindUI()
      this.renderServerBar()
      var h = this.parseHash()
      if (h.srv && this._find(h.srv)) this.curId = h.srv
      if (!this.servers.length) this.openMgr()
      else this.switchTo(this.curId, h.sid)
      window.addEventListener('hashchange', function () {
        var hh = that.parseHash()
        if (hh.srv && hh.srv !== that.curId && that._find(hh.srv)) that.switchTo(hh.srv, hh.sid)
        else if (hh.sid && hh.sid !== that.sid) that.openSession(hh.sid)
      })
    },

    /** 支持 ?cfg=<base64 服务器列表> —— 一条链接把配置带到另一台设备（手机）上。 */
    importFromUrl: function () {
      var m = /[?&]cfg=([^&]+)/.exec(location.search || '')
      if (!m) return
      var list = null
      try {
        list = JSON.parse(decodeURIComponent(escape(atob(decodeURIComponent(m[1])))))
      } catch (e) { return }
      if (!Array.isArray(list) || !list.length) return
      var merged = this.servers.slice()
      list.forEach(function (s) {
        if (!s || !s.url) return
        s.id = s.id || ('s' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5))
        if (!merged.some(function (x) { return x.url === s.url && x.keyId === s.keyId })) merged.push(s)
      })
      this.servers = merged
      saveServers(merged)
      // 地址栏里别留着密钥
      history.replaceState(null, '', location.pathname + (location.hash || ''))
    },

    /** 粘贴导入：.copy2client 整段（可含两台客户端）→ 服务器列表 + 私钥播种。 */
    importPaste: function (text) {
      if (text === undefined || text === null) text = $('mgrPaste').value
      var msg = $('mgrImportMsg')
      var items = parseImportText(text)
      if (!items.length) {
        msg.textContent = '没找到连接串（应含 sbp1. 开头的行）'
        return 0
      }
      var merged = this.servers.slice()
      var added = 0
      items.forEach(function (s) {
        if (!s.url) return
        var idx = -1
        for (var i = 0; i < merged.length; i++) {
          if (merged[i].url === s.url && merged[i].myKeyId === s.myKeyId) { idx = i; break }
        }
        if (idx > -1) { s.id = merged[idx].id; merged[idx] = s }
        else { s.id = newId(); merged.push(s); added += 1 }
        if (s.box_sk && s.sign_sk) {
          try {
            localStorage.setItem('sbp_e2ee_' + s.id, JSON.stringify({
              box_sk: s.box_sk, sign_sk: s.sign_sk, box_pk: s.box_pk || '', sign_pk: s.sign_pk || ''
            }))
          } catch (e) {}
        }
      })
      this.servers = merged
      saveServers(merged)
      this.renderServerBar(); this.renderMgr()
      var n = items.length
      msg.textContent = '✓ 导入 ' + n + ' 条' + (added < n ? '（更新 ' + (n - added) + ' 条）' : '')
      toast('已导入 ' + n + ' 条连接信息')
      if (!this.curId) { this.curId = merged.length ? merged[0].id : null; this.switchTo(this.curId) }
      return n
    },

    /** 生成当前配置的分享链接（服务器管理弹层里用） */
    shareLink: function () {
      try {
        var b64 = btoa(unescape(encodeURIComponent(JSON.stringify(this.servers))))
        return location.origin + location.pathname + '?cfg=' + encodeURIComponent(b64)
      } catch (e) { return '' }
    },

    _find: function (id) {
      for (var i = 0; i < this.servers.length; i++) if (this.servers[i].id === id) return this.servers[i]
      return null
    },
    cur: function () { return this._find(this.curId) },

    parseHash: function () {
      var out = {}
      ;(location.hash || '').replace(/^#/, '').split('&').forEach(function (kv) {
        var p = kv.split('=')
        if (p[0]) out[p[0]] = decodeURIComponent(p[1] || '')
      })
      return out
    },
    writeHash: function () {
      var h = ''
      if (this.curId) h += 'srv=' + encodeURIComponent(this.curId)
      if (this.sid) h += (h ? '&' : '') + 'sid=' + encodeURIComponent(this.sid)
      var next = h ? '#' + h : ''
      if (location.hash !== next) {
        history.replaceState(null, '', location.pathname + location.search + next)
      }
    },

    // ------------------------------------------------------------ 切换服务器
    switchTo: function (id, sid) {
      var that = this
      this.curId = id
      localStorage.setItem(LS_CURRENT, id || '')
      this.groups = []; this.sessions = []; this.sid = ''; this.kind = ''; this.tmux = ''
      this.msgs = []; this.screen = []; this.prompt = null
      this.renderServerBar(); this.renderList(); this.renderMain()
      var cfg = this.cur()
      this.writeHash()
      if (!cfg) { this.conn.close(); return }
      this.conn.connect(cfg)
      // 连上后自动重开上次那个会话
      var want = sid || this.parseHash().sid
      if (want) this._autoSid = want
      else this._autoSid = null
    },

    onState: function (s, extra) {
      var dot = $('dot'), txt = $('connState')
      if (s === 'open') {
        dot.className = 'dot on'; txt.textContent = '已连接'
        var that = this
        this.loadList()
      } else if (s === 'connecting') {
        dot.className = 'dot'; txt.textContent = '连接中…'
      } else if (s === 'reconnect') {
        dot.className = 'dot wait'; txt.textContent = extra + 's 后重连'
      } else if (s === 'closed') {
        dot.className = 'dot off'; txt.textContent = '已断开'
      } else if (s === 'error') {
        dot.className = 'dot off'
        txt.textContent = '连接失败'
        toast(typeof extra === 'string' ? extra : ((extra && extra.msg) || '连接失败'), 'err')
      }
    },

    // ------------------------------------------------------------ 收帧
    onFrame: function (f) {
      var name = f.name, p = f.payload || {}, sid = f.sid || p.sid
      if (name === 'session.message' && sid === this.sid) {
        var seq = p.seq || (p.meta && p.meta.seq) || 0
        var m = { seq: seq, role: p.role || 'agent', kind: p.kind || 'text',
                  text: p.text || '', ts: p.ts || (p.meta && p.meta.ts) }
        var dup = this.msgs.some(function (x) {
          return seq ? x.seq === seq : (x.text === m.text && x.role === m.role)
        })
        if (!dup) {
          this.msgs.push(m)
          this.renderMsgs()
        }
        return
      }
      if (name === 'output.delta' && sid === this.sid) {
        this.screen = (p.lines || []).slice(-200)
        this.renderScreen()
        return
      }
      if (name === 'session.prompt' && sid === this.sid) {
        if (p.state === 'open') this.prompt = p
        else if (!this.prompt || this.prompt.pid === p.pid) this.prompt = null
        this.renderPrompt()
        return
      }
      if (name === 'session.state' && sid === this.sid) {
        this.state = p.status || 'idle'
        this.renderStateChip()
        return
      }
      if (name === 'device.state' || name === 'session.index' || name === 'sessions.index') {
        this.loadList()
        return
      }
      if (name === 'pong') return
    },

    // ------------------------------------------------------------ 列表
    loadList: function () {
      var that = this
      // 单飞：连上、心跳、sessions.index 推送可能同时触发，别让它们各发一遍
      if (this._listReq) return this._listReq
      if (!this.groups || !this.groups.length) this.renderList('loading')
      this._listReq = this.conn.req('session.list', {}, 30000).then(function (r) {
        var pl = r.payload || {}
        that.groups = pl.groups || []
        that.sessions = pl.sessions || []
        that.renderList()
        that.afterList()
      }).catch(function (e) {
        that._listErr = e
        $('list').innerHTML = '<div class="list-empty"><b>列表拉取失败</b>'
          + esc((e && (e.msg || e.code)) || '') + '</div>'
          + '<button class="lk-retry" id="listRetry">重试</button>'
        var btn = $('listRetry')
        if (btn) btn.onclick = function () { that.loadList() }
      }).then(function () {
        that._listReq = null
      })
      return this._listReq
    },

    /** 「可见会话」按机器分区：只有 active 的才上侧栏（灰的历史会话不显示）。
     *
     * 两种后端两种形状：面板把每个 tmux 报成一个 group（无 did），中继按设备报
     * group（带 did）。这里统一成「一台机器一个分区」，否则手机上一屏全是重复的
     * 组头。
     */
    visible: function () {
      var secs = []
      var byKey = {}
      var self = this
      ;(this.groups || []).forEach(function (g) {
        var items = (g.items || []).filter(isLive)
        if (!items.length) return
        var isTmux = !g.did
        var key = isTmux ? 'local' : ('did:' + g.did)
        var sec = byKey[key]
        if (!sec) {
          sec = byKey[key] = {
            key: key,
            name: isTmux ? ((self.cur() && titleOf(self.cur())) || '本机') : (g.name || '设备'),
            cwd: isTmux ? '' : (g.cwd || ''),
            live: false,
            items: []
          }
          secs.push(sec)
        }
        sec.live = sec.live || !!g.live
        items.forEach(function (it) {
          // 复制一份：分区要补 tmux 名，别改到原始索引（itemOf 还在用）
          var row = {}
          for (var k in it) row[k] = it[k]
          if (!row.tmux) row.tmux = g.name || ''
          sec.items.push(row)
        })
      })
      return secs
    },

    /** 列表刷新后的自动行为：重开上次的会话 / 没有 agent 时跟随新起的那个 */
    afterList: function () {
      var vis = this.visible()
      var flat = []
      vis.forEach(function (v) { flat = flat.concat(v.items) })

      // 1) 地址栏带了 sid（或上次选中的）：先恢复它
      if (this._autoSid) {
        var want = this._autoSid
        this._autoSid = null
        this.openSession(want)
        return
      }
      // 2) 当前会话已经不在列表里（tmux 关了 / agent 退出了）：换到第一条
      if (this.sid && !flat.some(function (x) { return x.sid === this.sid })) {
        // 但不要打断正在看的会话 —— 只有它彻底消失才切
        if (!flat.length) { this.sid = ''; this.kind = ''; this.renderList(); this.renderMain(); return }
        // 之前是空终端：现在这个 tmux 里起来了 agent，跟过去（这正是「敲完 claude 自动进会话」）
        var mine = this.kind === 'shell' ? flat.filter(function (x) {
          return x.kind !== 'shell' && x.tmux && x.tmux === this._tmuxOf()
        }.bind(this)) : []
        this.openSession((mine[0] || flat[0]).sid)
        return
      }
      // 3) 什么都没选：直接打开第一条活跃会话，别让用户对着空白页
      if (!this.sid && flat.length) {
        this.openSession(flat[0].sid)
        return
      }
      if (this.sid) this.renderMain()
    },

    _tmuxOf: function () {
      var sid = this.sid
      var tmux = ''
      ;(this.groups || []).forEach(function (g) {
        (g.items || []).forEach(function (it) { if (it.sid === sid) tmux = it.tmux || g.name || '' })
      })
      return tmux || this.tmux || ''
    },

    renderServerBar: function () {
      var sel = $('srvSel')
      var that = this
      sel.innerHTML = ''
      this.servers.forEach(function (s) {
        var o = document.createElement('option')
        o.value = s.id
        o.textContent = titleOf(s)
        if (s.id === that.curId) o.selected = true
        sel.appendChild(o)
      })
      if (!this.servers.length) {
        var o2 = document.createElement('option')
        o2.textContent = '（还没有服务器）'
        sel.appendChild(o2)
      }
    },

    renderList: function (mode) {
      var el = $('list')
      var that = this
      // 首次扫描还没回来：给骨架屏，别急着说「没有活跃的 agent」
      if (mode === 'loading') {
        $('sbCount').textContent = ''
        el.innerHTML = '<div class="list-loading"><span class="spin"></span>'
          + '正在扫描机器上的 agent 会话…</div>'
          + '<div class="skel"></div><div class="skel"></div>'
        return
      }
      var vis = this.visible()
      var total = 0
      vis.forEach(function (v) { total += v.items.length })
      $('sbCount').textContent = total ? total + ' 个活跃会话' : ''

      if (!vis.length) {
        el.innerHTML = '<div class="list-empty"><b>没有活跃的 agent</b>'
          + '在电脑上 <code>tmux new -s work</code> 后启动 claude / codex / dsh，'
          + '这里就会出现它的会话。<br>也可以直接点下面任意一台机器的空终端进去敲命令。</div>'
        return
      }

      var html = ''
      vis.forEach(function (v) {
        var hasAgent = v.items.some(function (x) { return x.kind !== 'shell' })
        var nAgent = v.items.filter(function (x) { return x.kind !== 'shell' }).length
        // 只有一台机器时不重复报名字：顶部下拉已经写了
        if (vis.length > 1) {
          html += '<div class="dev">'
            + '<div class="dev-head">'
            + '<span class="dot ' + (hasAgent ? 'on' : '') + '"></span>'
            + '<span class="dev-name">' + esc(v.name) + '</span>'
            + '<span class="dev-n">' + (hasAgent ? nAgent + ' 个 agent' : '空终端') + '</span>'
            + (v.cwd ? '<span class="dev-cwd">' + esc(v.cwd) + '</span>' : '')
            + '</div>'
        } else {
          html += '<div class="dev">'
        }
        v.items.forEach(function (it) {
          var shell = isShell(it)
          var key = agentKey(it.agent, it.kind)
          var label = shell ? '&gt;_' : esc((agentName(it) || it.kind || '?').slice(0, 1).toUpperCase())
          var sub = it.subtitle || ''
          // 标题本身就是 tmux 名（空终端）时不再重复挂个 chip
          var tmux = (it.tmux && it.tmux !== (it.title || '')) ? it.tmux : ''
          var meta = shell ? '<span class="pill shell">待命</span>'
            : (it.count ? '<span class="pill run">' + it.count + ' 条</span>' : '')
          html += '<button class="row' + (it.sid === that.sid ? ' on' : '') + (shell ? ' shell' : '')
            + '" data-sid="' + esc(it.sid) + '" title="' + esc(it.title || it.sid) + '">'
            + '<span class="ag ' + key + '">' + label + '</span>'
            + '<span class="row-main">'
            + '<span class="row-t">' + esc(it.title || it.short || it.sid) + '</span>'
            + '<span class="row-s">'
            + (tmux ? '<span class="rw-tmux">' + esc(tmux) + '</span>' : '')
            + esc(sub) + '</span>'
            + '</span>'
            + '<span class="row-r">' + meta
            + (it.updated_at ? '<span class="tm">' + esc(ago(it.updated_at)) + '</span>' : '')
            + '</span></button>'
        })
        html += '</div>'
      })
      html += '<div class="list-foot">只显示此刻还在跑的会话<br>'
        + '没有 agent 的机器点进去是空终端，敲 claude 就能唤醒</div>'
      el.innerHTML = html
      Array.prototype.forEach.call(el.querySelectorAll('.row'), function (n) {
        n.onclick = function () { that.openSession(n.getAttribute('data-sid')) }
      })
    },

    // ------------------------------------------------------------ 打开会话
    openSession: function (sid) {
      var that = this
      if (!sid) return
      if (this.sid && this.sid !== sid) {
        this.conn.unsubscribeSession(this.sid)
        this.conn.req('session.detach', { sid: this.sid }, 5000).catch(function () {})
      }
      this.sid = sid
      this.msgs = []; this.screen = []; this.prompt = null; this.before = null
      this.hasMore = false; this.state = 'idle'; this.editable = false
      this._noHist = false
      var meta = this.itemOf(sid)
      this.kind = meta ? (meta.kind || (sid.indexOf('shell:') === 0 ? 'shell' : '')) : ''
      this.tmux = (meta && meta.tmux) || ''
      this.conn.subscribeSession(sid)   // 订阅会话 tag，否则收不到设备发来的密文
      this.writeHash()
      // 上一个会话的气泡还留在 DOM 里，先清掉：否则 term 会话会显示别人的历史
      $('msgs').innerHTML = ''
      $('msgCount').textContent = ''
      this.renderList(); this.renderMain()

      $('sessTitle').textContent = (meta && (meta.title || meta.short)) || sid
      $('sessSid').textContent = sid
      $('sessSid').title = sid
      $('sessState').className = 'chip'
      $('sessState').textContent = agentName(meta) || ''
      $('sessState').hidden = !(meta && agentName(meta))

      // 空终端：没有历史可翻，直接把屏幕铺满，让用户敲命令
      if (this.kind === 'shell') {
        this.editable = true
        this.applyStage()
        this.renderMsgs()
        $('composerWrap').hidden = false
        this.updateComposer()
        this.conn.req('pane.snapshot', { sid: sid, lines: 120 }, 10000).then(function (r) {
          that.screen = (r.payload || {}).lines || []
          that.renderScreen()
          var p = (r.payload || {}).prompt
          if (p) { that.prompt = p; that.renderPrompt() }
        }).catch(function () {})
        return
      }

      this.conn.req('session.attach', { sid: sid }, 10000).then(function (r) {
        var pl = r.payload || {}
        that.editable = !!pl.editable
        that.kind = pl.kind || that.kind || 'claude'
        // attach 会顺手推一屏 output.delta；这里只处理历史
        that.prompt = pl.prompt || null
        // dsh / codex 这类没有落盘历史：历史面板没东西可翻，直接收起，屏幕吃满
        that._noHist = !(that.kind === 'claude' || pl.last_seq || hasHistory(meta))
        that.renderMain()
        that.renderPrompt()
        if (!that._noHist) return that.loadHistory()
        that.renderMsgs()
        return null
      }).catch(function (e) {
        $('msgs').innerHTML = '<div class="stream-empty"><span class="ic">⚠</span>'
          + '打不开会话：' + esc((e && e.msg) || '') + '</div>'
      })
    },

    /** sid -> 侧栏里那条索引（含 kind / tmux / title） */
    itemOf: function (sid) {
      var hit = null
      ;(this.groups || []).forEach(function (g) {
        (g.items || []).forEach(function (it) { if (it.sid === sid) hit = it })
      })
      if (hit) return hit
      for (var i = 0; i < (this.sessions || []).length; i++) {
        if (this.sessions[i].sid === sid) return this.sessions[i]
      }
      return null
    },

    loadHistory: function (before) {
      var that = this
      var pl = { sid: this.sid, limit: 20 }
      if (before) pl.before = before
      return this.conn.req('session.history', pl, 10000).then(function (r) {
        var d = r.payload || {}
        var items = d.items || []
        that.hasMore = !!d.has_more
        that.before = d.next_before
        if (before) that.msgs = items.concat(that.msgs)
        else that.msgs = items
        that.renderMsgs(before ? 'keep' : 'bottom')
      }).catch(function (e) {
        $('msgs').innerHTML = '<div class="stream-empty"><span class="ic">⚠</span>'
          + '历史拉取失败：' + esc((e && e.msg) || '') + '</div>'
      })
    },

    // ------------------------------------------------------------ 渲染
    renderMain: function () {
      var empty = !this.sid
      $('empty').hidden = !empty
      $('stage').hidden = empty
      $('composerWrap').hidden = empty || !this.editable
      $('prompts').hidden = true
      if (empty) {
        $('sessTitle').textContent = '未选择会话'
        $('sessSid').textContent = ''
        $('sessState').hidden = true
      }
      this.applyStage()
      this.updateComposer()
    },

    /** 三块面板的显隐/折叠：历史默认展开，空终端只留屏幕 */
    applyStage: function () {
      var stage = $('stage'), stream = $('stream'), wrap = $('screenWrap')
      var shell = this.kind === 'shell'
      var none = shell || this._noHist          // 压根没有历史：整块不要
      var hidden = none || histHidden(this.sid)
      stage.className = 'stage' + (shell ? ' shell' : '') + (none ? ' no-hist' : '')
        + (hidden ? ' hist-off' : '')
      stream.className = 'stream' + (hidden ? ' closed' : '')
      wrap.className = 'screen-wrap' + (this._screenClosed ? ' closed' : '')
      if (shell) {
        $('msgCount').textContent = ''
      }
    },

    renderStateChip: function () {
      var el = $('sessState')
      if (!el || !this.sid) return
      var name = agentName(this.itemOf(this.sid)) || ''
      var st = this.state || 'idle'
      el.className = 'chip' + (st === 'running' ? ' live' : st === 'waiting' ? ' wait' : '')
      el.textContent = name + (st === 'running' ? ' · 运行中' : st === 'waiting' ? ' · 等你选择' : '')
      el.hidden = false
      var s = $('screenState')
      s.className = 'st ' + st
      s.textContent = st === 'running' ? '运行中' : st === 'waiting' ? '等你选择' : '空闲'
      s.hidden = !this.sid
    },

    renderMsgs: function (mode) {
      var el = $('msgs')
      var html = ''
      if (this.hasMore) html += '<div class="more" id="moreBtn">↑ 加载更早的消息</div>'
      var arr = this.msgs || []
      arr.forEach(function (m) {
        var role = (m.role === 'user') ? 'user' : 'agent'
        var who = m.role === 'user' ? '我' : 'agent'
        var when = hms(m.ts)
        html += '<div class="msg ' + role + (m.kind === 'tool' ? ' tool' : '') + '">'
          + '<div class="meta"><span class="who">' + esc(who) + '</span>'
          + (when ? '<span>' + esc(when) + '</span>' : '')
          + (m.kind && m.kind !== 'text' ? '<span class="k">' + esc(m.kind) + '</span>' : '')
          + '</div>'
          + '<div class="bub">' + md(String(m.text || '').replace(/\s+$/, '')) + '</div></div>'
      })
      if (!arr.length) {
        html += '<div class="stream-empty"><span class="ic">◌</span>'
          + '<span>这个会话还没有可展示的历史</span>'
          + '<span class="hint">往下看实时屏幕，或直接在输入框里发指令</span></div>'
      }
      el.innerHTML = html
      $('msgCount').textContent = arr.length ? arr.length + ' 条' : ''
      var that = this
      var more = $('moreBtn')
      if (more) {
        more.onclick = function () {
          if (that.loadingOlder || !that.before) return
          that.loadingOlder = true
          more.textContent = '加载中…'
          var near = el.scrollHeight
          that.loadHistory(that.before).then(function () {
            that.loadingOlder = false
            // 保持视口：插入内容后把滚动位置补回来
            el.scrollTop += el.scrollHeight - near
          })
        }
      }
      if (mode !== 'keep') el.scrollTop = el.scrollHeight
    },

    renderScreen: function () {
      var pre = $('screen')
      pre.textContent = this.screen.join('\n')
      pre.scrollTop = pre.scrollHeight
      this.renderStateChip()
    },

    /** 输入区：空终端多给一排「敲哪个 agent」的快捷命令 */
    updateComposer: function () {
      var shell = this.kind === 'shell'
      var q = $('quick')
      var inp = $('input')
      var narrow = (window.innerWidth || 999) < 560
      if (!shell) {
        q.hidden = true
        inp.placeholder = narrow ? '输入指令，Enter 发送'
          : '输入指令，Enter 发送，Shift+Enter 换行'
        return
      }
      q.hidden = false
      q.innerHTML = '<span class="q-label">启动 agent</span>'
        + ['claude', 'codex', 'dsh', 'hermes'].map(function (c) {
          return '<button class="qcmd" data-cmd="' + c + '">' + c + '</button>'
        }).join('')
      var that = this
      Array.prototype.forEach.call(q.querySelectorAll('.qcmd'), function (b) {
        b.onclick = function () {
          that.conn.req('session.input', { sid: that.sid, text: b.getAttribute('data-cmd'), submit: true }, 10000)
            .then(function () { toast('已发送 ' + b.getAttribute('data-cmd') + '，正在启动…') })
            .catch(function (e) { toast('写入失败：' + ((e && e.msg) || ''), 'err') })
        }
      })
      inp.placeholder = narrow ? '输入命令回车，例如 claude'
        : '输入命令并回车，例如 claude / codex / dsh（会写进这个 tmux 会话）'
    },

    renderPrompt: function () {
      var el = $('prompts')
      var p = this.prompt
      if (!p || p.state === 'answered' || p.state === 'gone') { el.hidden = true; el.innerHTML = ''; return }
      var that = this
      var html = '<div class="pcard ' + (p.risk || 'safe') + '">'
        + '<div class="ptitle">' + esc(p.title || '请选择') + '</div>'
        + (p.detail ? '<div class="pdetail">' + esc(p.detail) + '</div>' : '')
        + '<div class="pops">'
      ;(p.options || []).forEach(function (o) {
        html += '<button class="popt ' + (o.risk || 'safe') + (o.default ? ' def' : '') + '" '
          + 'data-idx="' + o.index + '">' + esc(o.label || '')
          + (o.desc ? '<span class="pdesc">' + esc(o.desc) + '</span>' : '') + '</button>'
      })
      html += '<button class="popt ghost" data-dismiss="1">忽略</button></div></div>'
      el.innerHTML = html
      el.hidden = false
      Array.prototype.forEach.call(el.querySelectorAll('.popt'), function (b) {
        b.onclick = function () {
          if (b.getAttribute('data-dismiss')) return that.answer({ dismiss: true })
          var idx = +b.getAttribute('data-idx')
          var danger = b.className.indexOf('danger') > -1
          if (danger && !confirm('确认选择「' + b.textContent.split('\n')[0] + '」？')) return
          that.answer({ choice: idx })
        }
      })
    },

    answer: function (extra) {
      var that = this
      var pl = { sid: this.sid, pid: this.prompt ? this.prompt.pid : '' }
      for (var k in extra) pl[k] = extra[k]
      return this.conn.req('session.answer', pl, 12000).then(function () {
        that.prompt = null
        that.renderPrompt()
        toast('已作答')
      }).catch(function (e) {
        toast('作答失败：' + ((e && e.msg) || ''), 'err')
        if (e && e.code === 'E_PROMPT_STALE') { that.prompt = null; that.renderPrompt() }
      })
    },

    send: function () {
      var ta = $('input')
      var text = ta.value
      if (!text.trim() || !this.sid) return
      var that = this
      $('send').disabled = true
      this.conn.req('session.input', { sid: this.sid, text: text, submit: true }, 10000).then(function () {
        ta.value = ''
        ta.focus()
        toast('已发送')
      }).catch(function (e) {
        toast('发送失败：' + ((e && e.msg) || ''), 'err')
      }).then(function () { $('send').disabled = false })
    },

    // ------------------------------------------------------------ 服务器管理
    openMgr: function () {
      $('mgr').hidden = false
      this.renderMgr()
    },
    renderMgr: function () {
      var that = this
      var el = $('mgrList')
      if (!this.servers.length) {
        el.innerHTML = '<div class="empty">还没有服务器，先加一台</div>'
      } else {
        var html = ''
        this.servers.forEach(function (s, i) {
          html += '<div class="mrow"><span class="mname">' + esc(titleOf(s)) + '</span>'
            + '<span class="murl">' + esc(s.url) + '</span>'
            + '<span class="mauth">' + esc(s.auth) + (s.auth === 'hmac' ? ' · ' + esc(s.keyId) : '') + '</span>'
            + '<button class="mini" data-act="use" data-i="' + i + '">切换</button>'
            + '<button class="mini" data-act="edit" data-i="' + i + '">编辑</button>'
            + '<button class="mini danger" data-act="del" data-i="' + i + '">删除</button></div>'
        })
        el.innerHTML = html
        Array.prototype.forEach.call(el.querySelectorAll('button'), function (b) {
          b.onclick = function () {
            var i = +b.getAttribute('data-i'), act = b.getAttribute('data-act')
            if (act === 'use') { that.switchTo(that.servers[i].id); $('mgr').hidden = true }
            if (act === 'edit') that.editForm(i)
            if (act === 'del') {
              if (!confirm('删除「' + titleOf(that.servers[i]) + '」？')) return
              that.servers.splice(i, 1)
              saveServers(that.servers)
              if (!that._find(that.curId)) that.curId = that.servers.length ? that.servers[0].id : null
              that.renderServerBar(); that.renderMgr()
            }
          }
        })
      }
    },
    editForm: function (i) {
      var s = i === null || i === undefined ? blankServer() : this.servers[i]
      this._editIdx = (i === null || i === undefined) ? null : i
      $('fName').value = s.name || ''
      $('fUrl').value = s.url || ''
      $('fAuth').value = s.auth || 'hmac'
      $('fKeyId').value = s.keyId || ''
      $('fSecret').value = s.secret || ''
      $('fToken').value = s.token || ''
      $('fE2ee').checked = !!s.e2ee
      $('fDid').value = s.did || ''
      $('fMyKeyId').value = s.myKeyId || 'cli'
      $('fRk').value = s.rk || ''
      $('fPeerKeyId').value = s.peerKeyId || 'dev'
      $('fPeerBoxPk').value = s.peerBoxPk || ''
      $('fPeerSignPk').value = s.peerSignPk || ''
      $('fMyKeys').textContent = ''
      this.syncAuthFields()
      $('fMsg').textContent = ''
      $('form').hidden = false
      $('fUrlHint').textContent = wsUrl(s.url, !!s.e2ee) || ''
    },
    syncAuthFields: function () {
      var a = $('fAuth').value
      var e2ee = $('fE2ee').checked
      $('rowHmac').hidden = e2ee || a !== 'hmac'
      $('rowHmac2').hidden = e2ee || a !== 'hmac'
      $('rowToken').hidden = e2ee || (a !== 'token' && a !== 'bearer')
      $('e2eeBox').hidden = !e2ee
    },
    /** 生成（仅一次）本机密钥对，显示公钥供在 sbp-agent / dispatcher 上登记。 */
    genKeys: function () {
      var that = this
      SbpE2EE.ready.then(function () {
        var id = (that._editIdx === null) ? 'tmp' : that.servers[that._editIdx].id
        var storeKey = 'sbp_e2ee_' + id
        var stored = null
        try { stored = JSON.parse(localStorage.getItem(storeKey) || 'null') } catch (e) {}
        if (!stored || !stored.box_pk) {
          var kp = SbpE2EE.generateKeypair()
          stored = {
            box_sk: SbpE2EE.b64u_encode(kp.box_sk), sign_sk: SbpE2EE.b64u_encode(kp.sign_sk),
            box_pk: SbpE2EE.b64u_encode(kp.box_pk), sign_pk: SbpE2EE.b64u_encode(kp.sign_pk)
          }
          localStorage.setItem(storeKey, JSON.stringify(stored))
        }
        $('fMyKeys').innerHTML = '本机 box 公钥：<code>' + stored.box_pk + '</code><br>'
          + '本机 sign 公钥：<code>' + stored.sign_pk + '</code><br>'
          + '<span class="hint">把这两个公钥分别登记到 sbp-agent 的 SBP_E2EE_PEERS 和 dispatcher 的 SBP_TRUSTED_KEYS（keyId='
          + ($('fMyKeyId').value || 'cli') + '）。</span>'
      }).catch(function () { $('fMyKeys').textContent = 'libsodium 尚未就绪' })
    },
    saveForm: function () {
      var s = {
        id: (this._editIdx === null ? blankServer().id : this.servers[this._editIdx].id),
        name: $('fName').value.trim(),
        url: $('fUrl').value.trim(),
        auth: $('fAuth').value,
        keyId: $('fKeyId').value.trim(),
        secret: $('fSecret').value.trim(),
        token: $('fToken').value.trim(),
        e2ee: $('fE2ee').checked,
        did: $('fDid').value.trim(),
        myKeyId: $('fMyKeyId').value.trim() || 'cli',
        rk: $('fRk').value.trim(),
        peerKeyId: $('fPeerKeyId').value.trim() || 'dev',
        peerBoxPk: $('fPeerBoxPk').value.trim(),
        peerSignPk: $('fPeerSignPk').value.trim()
      }
      var old = this._editIdx === null ? null : this.servers[this._editIdx]
      if (old) {
        // 导入进来的连接串自带私钥，表单里没有这两项，编辑保存时别给冲掉
        var keep = ['box_sk', 'sign_sk', 'box_pk', 'sign_pk']
        for (var ki = 0; ki < keep.length; ki++) {
          if (!s[keep[ki]]) s[keep[ki]] = old[keep[ki]] || ''
        }
      }
      if (!wsUrl(s.url, s.e2ee)) { $('fMsg').textContent = '地址看不懂，示例：wss://host:8787/ws 或 https://host/sbp'; return }
      if (s.auth === 'hmac' && !s.secret && !s.e2ee) { $('fMsg').textContent = 'HMAC 模式要填 secret'; return }
      if (s.e2ee) {
        if (!s.did || !s.rk || !s.peerKeyId || !s.peerBoxPk || !s.peerSignPk)
          { $('fMsg').textContent = 'E2EE 要填：设备 DID、路由密钥 rk、对端 keyId / box 公钥 / sign 公钥'; return }
      }
      if (this._editIdx === null) this.servers.push(s)
      else this.servers[this._editIdx] = s
      saveServers(this.servers)
      $('form').hidden = true
      this.renderServerBar(); this.renderMgr()
      toast('已保存')
    },
    testForm: function () {
      var that = this
      var _old = this._editIdx === null ? null : this.servers[this._editIdx]
      var s = {
        name: $('fName').value.trim(), url: $('fUrl').value.trim(), auth: $('fAuth').value,
        keyId: $('fKeyId').value.trim(), secret: $('fSecret').value.trim(), token: $('fToken').value.trim(),
        e2ee: $('fE2ee').checked, did: $('fDid').value.trim(), myKeyId: $('fMyKeyId').value.trim() || 'cli',
        rk: $('fRk').value.trim(), peerKeyId: $('fPeerKeyId').value.trim() || 'dev',
        peerBoxPk: $('fPeerBoxPk').value.trim(), peerSignPk: $('fPeerSignPk').value.trim(),
        box_sk: (_old && _old.box_sk) || '', sign_sk: (_old && _old.sign_sk) || ''
      }
      s.id = (_old && _old.id) || newId()
      var url = wsUrl(s.url, s.e2ee)
      if (!url) { $('fMsg').textContent = '地址看不懂'; return }
      $('fMsg').textContent = '正在连接 ' + url + ' …'
      var c = new Conn(function () {}, function (st, x) {})
      c.connect(s)
      var done = false
      var t0 = setTimeout(function () {
        if (done) return
        done = true; c.close(); $('fMsg').textContent = '✗ 超时：握手没回来（地址/证书/密钥？）'
      }, 12000)
      c._probe = setInterval(function () {
        if (done) return
        if (c.state === 'open') {
          done = true; clearTimeout(t0); clearInterval(c._probe)
          c.req('session.list', {}, 8000).then(function (r) {
            var n = 0
            ;((r.payload || {}).groups || []).forEach(function (g) { n += (g.items || []).length })
            $('fMsg').textContent = '✓ 已连接 · 设备 ' + ((r.payload || {}).groups || []).length + ' 台 · 会话 ' + n + ' 个'
            c.close()
          }).catch(function (e) {
            $('fMsg').textContent = '✗ ' + ((e && e.msg) || '拉取会话失败')
            c.close()
          })
        } else if (c.state === 'error') {
          done = true; clearTimeout(t0); clearInterval(c._probe)
          $('fMsg').textContent = '✗ ' + (typeof x === 'string' ? '' : '') + (c._lastErr || '连接失败')
          c.close()
        }
      }, 300)
    },

    // ------------------------------------------------------------ UI 绑定
    bindUI: function () {
      var that = this
      $('srvSel').onchange = function () { that.switchTo($('srvSel').value) }
      $('btnMgr').onclick = function () { that.openMgr() }
      $('mgrClose').onclick = function () { $('mgr').hidden = true }
      $('mgrAdd').onclick = function () { that.editForm(null) }
      $('mgrShare').onclick = function () {
        var link = that.shareLink()
        if (!link) { toast('生成链接失败', 'err'); return }
        var done = function () { toast('已复制配置链接（含密钥，别乱发）') }
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(link).then(done, function () { prompt('复制这条链接：', link) })
        } else {
          prompt('复制这条链接：', link)
        }
      }
      $('mgrImport').onclick = function () { that.importPaste() }
      $('mgrPasteClear').onclick = function () { $('mgrPaste').value = ''; $('mgrImportMsg').textContent = '' }
      $('formCancel').onclick = function () { $('form').hidden = true }
      $('formSave').onclick = function () { that.saveForm() }
      $('formTest').onclick = function () { that.testForm() }
      $('fAuth').onchange = function () { that.syncAuthFields() }
      $('fE2ee').onchange = function () { that.syncAuthFields() }
      $('fGenKeys').onclick = function () { that.genKeys() }
      $('fUrl').oninput = function () { $('fUrlHint').textContent = wsUrl($('fUrl').value, $('fE2ee').checked) }
      $('btnRefresh').onclick = function () { that.loadList() }
      $('btnSnap').onclick = function () {
        if (!that.sid) return
        that.conn.req('pane.snapshot', { sid: that.sid, lines: 120 }, 10000).then(function (r) {
          that.screen = (r.payload || {}).lines || []
          that.renderScreen()
          var p = (r.payload || {}).prompt
          if (p) { that.prompt = p; that.renderPrompt() }
        }).catch(function (e) { toast('抓屏失败：' + ((e && e.msg) || ''), 'err') })
      }
      // 会话历史：默认展开，点标题折叠；按会话记住
      $('streamHead').onclick = function () {
        if (that.kind === 'shell' || !that.sid) return
        var now = !histHidden(that.sid)
        setHistHidden(that.sid, now)
        that.applyStage()
      }
      // 实时屏幕：折叠后历史吃满高度
      $('screenHead').onclick = function () {
        that._screenClosed = !that._screenClosed
        that.applyStage()
      }
      $('send').onclick = function () { that.send() }
      $('input').onkeydown = function (e) {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); that.send() }
      }
      $('btnEsc').onclick = function () {
        if (!that.sid) return
        that.conn.req('session.input', { sid: that.sid, kind: 'key', key: 'ESC' }, 8000)
          .then(function () { toast('已发送 Esc') })
          .catch(function (e) { toast('发送失败：' + ((e && e.msg) || ''), 'err') })
      }
      $('btnMenu').onclick = function () {
        document.body.className = document.body.className === 'sb-open' ? '' : 'sb-open'
      }
      $('scrim').onclick = function () { document.body.className = '' }
    }
  }

  window.addEventListener('DOMContentLoaded', function () { App.init() })
  // 调试口子：控制台里 __sbpApp 能直接看当前状态（不影响正常使用）
  window.__sbpApp = App
})()

/* SBP-0.4 E2EE —— 浏览器控制台用的加密内核（libsodium）。
 *
 * 线格式与 sbp_client.crypto（Python / PyNaCl）逐字节一致：
 *   envelope { v:"sbp/0.3e", tag, kid, eph, sig, cipher }
 *   inner    { type:"req|res|evt", name, id, sid?, payload }
 *   scope    "dev|{did}" / "sid|{did}|{sid}"
 *
 * 为什么 HMAC 不用 libsodium：libsodium 的 crypto_auth 是 HMAC-SHA512/256，
 * 而 spec 用的是 HMAC-SHA256(rk, scope)。这里直接带一份纯 JS 的 SHA256/HMAC，
 * 与 sbp_client.crypto.compute_tag 完全一致。
 *
 * 加解密 / 签名用 libsodium-wrappers（WASM，浏览器原生支持）；浏览器里通过
 * <script src="libsodium.js"> 暴露全局 sodium，Node 里 require('libsodium-wrappers')。
 * 所有用到 sodium 的方法都假定 sodium.ready 已 resolved——应用启动先 await SbpE2EE.ready。
 */
(function (global) {
  'use strict'

  var sodium = (typeof require !== 'undefined') ? require('libsodium-wrappers') : global.sodium

  var VERSION = 'sbp/0.3e'
  var NONCE_LEN = 24
  var CHALLENGE_PREFIX = 'sbp1|'
  // Argon2id 派生 rk 时的盐，必须与 sbp_client.crypto.derive_rk 的 salt 一致
  var RK_SALT = utf8('sbp-e2ee-rk-v1')

  // ----------------------------------------------------------------- base64url
  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  function b64u_encode(bytes) {
    var s = ''
    var i, len = bytes.length
    for (i = 0; i + 2 < len; i += 3) {
      var n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]
      s += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63]
    }
    var rem = len - i
    if (rem === 1) {
      var n1 = bytes[i] << 16
      s += B64[(n1 >> 18) & 63] + B64[(n1 >> 12) & 63] + '=='
    } else if (rem === 2) {
      var n2 = (bytes[i] << 16) | (bytes[i + 1] << 8)
      s += B64[(n2 >> 18) & 63] + B64[(n2 >> 12) & 63] + B64[(n2 >> 6) & 63] + '='
    }
    return s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  }
  function b64u_decode(text) {
    text = String(text).replace(/-/g, '+').replace(/_/g, '/')
    while (text.length % 4) text += '='
    var bin = atob(text)
    var out = new Uint8Array(bin.length)
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  }

  // ------------------------------------------------------------------ utf8
  function utf8(str) {
    var out = []
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i)
      if (c < 0x80) out.push(c)
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f))
      else if (c >= 0xd800 && c <= 0xdbff) {
        var c2 = str.charCodeAt(++i)
        var cp = 0x10000 + ((c & 0x3ff) << 10) + (c2 & 0x3ff)
        out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f))
      } else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f))
    }
    return new Uint8Array(out)
  }
  function bytesToUtf8(bytes) {
    var s = ''
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
    try { return decodeURIComponent(escape(s)) } catch (e) { return s }
  }
  function concat() {
    var total = 0, i, a
    for (i = 0; i < arguments.length; i++) total += arguments[i].length
    var r = new Uint8Array(total), off = 0
    for (i = 0; i < arguments.length; i++) { a = arguments[i]; r.set(a, off); off += a.length }
    return r
  }

  // --------------------------------------------------------- 纯 JS SHA256/HMAC
  var K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ]
  function rotr(x, n) { return (x >>> n) | (x << (32 - n)) }
  function sha256(msg) {
    var l = msg.length
    var total = (Math.floor((l + 8) / 64) + 1) * 64
    var buf = new Uint8Array(total)
    buf.set(msg)
    buf[l] = 0x80
    var dv = new DataView(buf.buffer)
    dv.setUint32(total - 8, Math.floor((l * 8) / 4294967296))
    dv.setUint32(total - 4, (l * 8) >>> 0)
    var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
    var w = new Int32Array(64)
    for (var off = 0; off < total; off += 64) {
      var j
      for (j = 0; j < 16; j++) w[j] = dv.getInt32(off + j * 4, false)
      for (j = 16; j < 64; j++) {
        var w15 = w[j - 15], w2 = w[j - 2]
        var s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3)
        var s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10)
        w[j] = (w[j - 16] + s0 + w[j - 7] + s1) >>> 0
      }
      var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7]
      for (j = 0; j < 64; j++) {
        var S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
        var ch = (e & f) ^ (~e & g)
        var t1 = (h + S1 + ch + K[j] + w[j]) >>> 0
        var S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
        var maj = (a & b) ^ (a & c) ^ (b & c)
        var t2 = (S0 + maj) >>> 0
        h = g; g = f; f = e; e = (d + t1) >>> 0
        d = c; c = b; b = a; a = (t1 + t2) >>> 0
      }
      H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0
      H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0
    }
    var out = new Uint8Array(32)
    var odv = new DataView(out.buffer)
    for (var i2 = 0; i2 < 8; i2++) odv.setUint32(i2 * 4, H[i2])
    return out
  }
  function hmac_sha256(keyBytes, msgBytes) {
    var B = 64
    if (keyBytes.length > B) keyBytes = sha256(keyBytes)
    var ik = new Uint8Array(B), ok = new Uint8Array(B)
    var i
    for (i = 0; i < B; i++) { ik[i] = 0x36; ok[i] = 0x5c }
    for (i = 0; i < B; i++) {
      var k = keyBytes[i] || 0
      ik[i] ^= k; ok[i] ^= k
    }
    return sha256(concat(ok, sha256(concat(ik, msgBytes))))
  }

  // ------------------------------------------------------------- 密钥 / 派生
  function generateKeypair() {
    var box = sodium.crypto_box_keypair()
    var sign = sodium.crypto_sign_keypair()
    return {
      box_sk: box.privateKey, box_pk: box.publicKey,
      sign_sk: sign.privateKey, sign_pk: sign.publicKey
    }
  }
  /** 64-hex 直接当原始 32 字节 rk；否则 Argon2id 派生（参数对齐 Python derive_rk）。 */
  function deriveRk(material) {
    if (typeof material === 'string' && /^[0-9a-fA-F]{64}$/.test(material)) {
      var rk = new Uint8Array(32)
      for (var i = 0; i < 32; i++) rk[i] = parseInt(material.substr(i * 2, 2), 16)
      return rk
    }
    return sodium.crypto_pwhash(
      32, utf8(String(material)), RK_SALT,
      sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE,   // 2
      sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE,   // 64 MiB
      sodium.crypto_pwhash_ALG_ARGON2ID13
    )
  }

  // ------------------------------------------------------------- 路由盲化
  function computeTag(rk, scope) {
    return b64u_encode(hmac_sha256(rk, utf8(scope)))
  }

  // ------------------------------------------------------------- 握手挑战
  function signChallenge(sign_sk, keyId, ts, nonce) {
    var msg = utf8(CHALLENGE_PREFIX + keyId + '|' + ts + '|' + nonce)
    return b64u_encode(sodium.crypto_sign_detached(msg, sign_sk))
  }
  function verifyChallenge(sign_pk, keyId, ts, nonce, sig_b64) {
    var msg = utf8(CHALLENGE_PREFIX + keyId + '|' + ts + '|' + nonce)
    try { return sodium.crypto_sign_verify_detached(b64u_decode(sig_b64), msg, sign_pk) } catch (e) { return false }
  }

  // ------------------------------------------------------------- 信封
  function _signedMessage(tag, eph_pk, cipher) {
    return concat(utf8(tag), eph_pk, cipher)
  }
  function wrap(inner, rk, sender_sign_sk, recipient_box_pk, scope, peer_sign_pk) {
    var eph = sodium.crypto_box_keypair()
    var nonce = sodium.randombytes_buf(NONCE_LEN)
    var innerBytes = utf8(JSON.stringify(inner))
    var ct = sodium.crypto_box_easy(innerBytes, nonce, recipient_box_pk, eph.privateKey)
    var cipher = concat(nonce, ct)
    var tag = computeTag(rk, scope)
    var signed = _signedMessage(tag, eph.publicKey, cipher)
    var sig = sodium.crypto_sign_detached(signed, sender_sign_sk)
    return {
      v: VERSION, tag: tag, kid: null,
      eph: b64u_encode(eph.publicKey), sig: b64u_encode(sig), cipher: b64u_encode(cipher)
    }
  }
  function unwrap(envelope, rk, receiver_box_sk, peer_sign_pk) {
    var tag = envelope.tag
    var eph = b64u_decode(envelope.eph)
    var cipher = b64u_decode(envelope.cipher)
    var sig = b64u_decode(envelope.sig)
    if (peer_sign_pk) {
      var signed = _signedMessage(tag, eph, cipher)
      if (!sodium.crypto_sign_verify_detached(sig, signed, peer_sign_pk))
        throw new Error('bad frame signature')
    }
    var nonce = cipher.subarray(0, NONCE_LEN)
    var ct = cipher.subarray(NONCE_LEN)
    var plain = sodium.crypto_box_open_easy(ct, nonce, eph, receiver_box_sk)
    return JSON.parse(bytesToUtf8(plain))
  }
  /** 中继侧：不解密，只验签。JS 端一般不用，留作对称校验。 */
  function verifySig(sign_pk, tag, eph_b64, cipher_b64, sig_b64) {
    var signed = _signedMessage(tag, b64u_decode(eph_b64), b64u_decode(cipher_b64))
    try { return sodium.crypto_sign_verify_detached(b64u_decode(sig_b64), signed, sign_pk) } catch (e) { return false }
  }

  // -------------------------------------------------- 连接串（.copy2client）
  // sbp-agent 生成的 .copy2client 里每台客户端一行：sbp1.<base64url(json)>。
  // 整段粘贴进控制台/小程序即可导入，所以这里就把解析放在加密内核里，
  // 控制台（console.js）与小程序共用同一份实现。
  var CONNECT_PREFIX = 'sbp1.'
  function b64urlDecodeStr(s) {
    var t = String(s).replace(/-/g, '+').replace(/_/g, '/')
    while (t.length % 4) t += '='
    var bin = atob(t)
    try { return decodeURIComponent(escape(bin)) } catch (e) { return bin }
  }
  function decodeConnect(line) {
    var raw = String(line).trim()
    if (raw.indexOf(CONNECT_PREFIX) !== 0) throw new Error('不是 sbp1. 连接串')
    var p = JSON.parse(b64urlDecodeStr(raw.slice(CONNECT_PREFIX.length)))
    return {
      v: p.v || '', name: p.name || p.myKeyId || 'SBP', url: p.url || '',
      auth: 'e2ee', keyId: '', secret: '', token: '',
      e2ee: true, did: p.did || '', myKeyId: p.myKeyId || 'cli', rk: p.rk || '',
      peerKeyId: p.peerKeyId || 'dev', peerBoxPk: p.peerBoxPk || '', peerSignPk: p.peerSignPk || '',
      // 连接串自带私钥：直接播种，省得再生成一对还要去中继登记
      box_sk: p.box_sk || '', sign_sk: p.sign_sk || '',
      box_pk: p.box_pk || '', sign_pk: p.sign_pk || ''
    }
  }
  /** 解析粘贴内容：.copy2client 整段 / ?cfg= 分享链接 / JSON 数组，都吃。 */
  function parseConnectText(text) {
    var out = []
    String(text || '').split(/\r?\n/).forEach(function (line) {
      line = line.trim()
      if (!line || line.indexOf(CONNECT_PREFIX) !== 0) return
      try { out.push(decodeConnect(line)) } catch (e) {}
    })
    if (out.length) return out
    var body = String(text || '').trim()
    var m = /[?&]cfg=([^&]+)/.exec(body)
    if (m) body = decodeURIComponent(m[1])
    try {
      var list = JSON.parse(b64urlDecodeStr(body))
      if (Array.isArray(list)) list.forEach(function (s) { if (s && s.url) out.push(s) })
    } catch (e) {}
    return out
  }

  // ------------------------------------------------------------- 端点链路
  function E2EELink(opts) {
    this.kp = opts.kp                                  // {box_sk,box_pk,sign_sk,sign_pk}
    this.peerBoxPk = opts.peerBoxPk                    // 收件人（设备）box 公钥
    this.peerSignPk = opts.peerSignPk                  // 收件人 sign 公钥（验签用）
    this.peerKeyId = opts.peerKeyId || 'dev'
    this.rk = opts.rk                                  // Uint8Array(32)
    this.kid = opts.keyId || 'cli'
    this.did = opts.did || opts.keyId || 'dev'
    this.role = opts.role || 'client'
  }
  E2EELink.prototype.deviceScope = function () { return 'dev|' + this.did }
  E2EELink.prototype.sessionScope = function (sid) { return 'sid|' + this.did + '|' + sid }
  E2EELink.prototype.hello = function () {
    var ts = Date.now()
    var nonce = Math.random().toString(36).slice(2) + ts.toString(36)
    var sig = signChallenge(this.kp.sign_sk, this.kid, ts, nonce)
    return {
      v: VERSION, id: 'h1', type: 'req', name: 'hello',
      payload: { role: this.role, keyId: this.kid, ts: ts, nonce: nonce, sig: sig, did: this.did }
    }
  }
  E2EELink.prototype._ctl = function (op, scope) {
    var tag = computeTag(this.rk, scope)
    var sig = sodium.crypto_sign_detached(utf8(tag), this.kp.sign_sk)
    return { v: VERSION, ctl: op, tag: tag, kid: this.kid, sig: b64u_encode(sig) }
  }
  E2EELink.prototype.subscribe = function (scope) { return this._ctl('sub', scope) }
  E2EELink.prototype.unsubscribe = function (scope) { return this._ctl('unsub', scope) }
  E2EELink.prototype.send = function (inner, scope) {
    var env = wrap(inner, this.rk, this.kp.sign_sk, this.peerBoxPk, scope, this.peerSignPk)
    env.kid = this.kid
    return env
  }
  E2EELink.prototype.recv = function (envelope) {
    if (envelope.ctl) return envelope
    return unwrap(envelope, this.rk, this.kp.box_sk, this.peerSignPk)
  }

  var SbpE2EE = {
    VERSION: VERSION, NONCE_LEN: NONCE_LEN,
    ready: (sodium && sodium.ready) ? sodium.ready : Promise.resolve(),
    sodium: sodium,
    b64u_encode: b64u_encode, b64u_decode: b64u_decode,
    utf8: utf8, sha256: sha256, hmac_sha256: hmac_sha256,
    generateKeypair: generateKeypair, deriveRk: deriveRk,
    computeTag: computeTag, signChallenge: signChallenge, verifyChallenge: verifyChallenge,
    wrap: wrap, unwrap: unwrap, verifySig: verifySig,
    E2EELink: E2EELink,
    CONNECT_PREFIX: CONNECT_PREFIX, CONNECT_V: 'sbp-connect/1',
    decodeConnect: decodeConnect, parseConnectText: parseConnectText,
    b64urlDecodeStr: b64urlDecodeStr
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = SbpE2EE
  else global.SbpE2EE = SbpE2EE
})(typeof window !== 'undefined' ? window : this)

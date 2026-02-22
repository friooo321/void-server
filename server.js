// ==UserScript==
// @name         Gartic.io - VOID.io 🖌 Custom
// @namespace    http://tampermonkey.net/
// @version      23.0
// @description  Tema VOID — avatares Discord, code blocks, imagens/gif/mp4/mp3 WebSocket, fontes, painel live, reactions, mencoes, link preview rico, typing indicator
// @author       shaz
// @match        https://gartic.io/*
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-start
// ==/UserScript==
(function () {
  'use strict';

  // ── Constantes ─────────────────────────────────────────────────────────────
  const WS_URL = 'wss://void-server-production.up.railway.app';
  const OG_API = 'https://void-server-production.up.railway.app/og?url=';
  const MENTION_SFX = 'https://raw.githubusercontent.com/friooo321/audio/main/alert-sound-87478_1.mp3';
  const CODE_RE = /[{};]|=>|function |const |let |var |def |import |class |\n.{5,}/;
  const CODE_EXTS = /\.(js|ts|jsx|tsx|py|html|htm|css|scss|json|txt|md|php|java|c|cpp|cs|go|rs|rb|sh|yaml|yml|xml|sql)$/i;
  const TEXT_TYPES = /^text\/|javascript|json|xml|x-python|x-sh/i;
  const URL_RE = /https?:\/\/[^\s<>"']+/g;
  const MUSIC_HOSTS = /youtu\.?be|spotify\.com|soundcloud\.com/i;
  const MUSIC_RE = {
    youtube: /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/)([A-Za-z0-9_\-]{11})/,
    spotify: /(?:https?:\/\/)?open\.spotify\.com\/(track|album|playlist|episode)\/([A-Za-z0-9]+)/,
    soundcloud: /(?:https?:\/\/)?(?:www\.)?soundcloud\.com\/([^\/\s]+\/[^\/\s]+)/,
  };

  // ── Helpers ─────────────────────────────────────────────────────────────────
  const esc = s => String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#x27;');
  const safeUrl = url => { try { const u = new URL(url); return (u.protocol==='https:'||u.protocol==='http:') ? url : ''; } catch(_) { return ''; } };
  const getNick = () => document.querySelector('#users .user.me .nick,#users .user.you .nick,#users li.me .nick')?.textContent?.trim() || [...document.querySelectorAll('#chat .history .msg strong')].at(-1)?.textContent?.trim() || 'void_'+Math.random().toString(36).slice(2,6);
  const getScrollEl = () => document.querySelector('#chat .history .scrollElements');
  const chatScroll = () => { const t = getScrollEl()?.closest('.top'); if(t) t.scrollTop = t.scrollHeight; };

  // ── LRU Map ─────────────────────────────────────────────────────────────────
  class LRUMap {
    constructor(max=200) { this.max=max; this.map=new Map(); }
    has(k) { return this.map.has(k); }
    get(k) { if(!this.map.has(k)) return undefined; const v=this.map.get(k); this.map.delete(k); this.map.set(k,v); return v; }
    set(k,v) { if(this.map.has(k)) this.map.delete(k); else if(this.map.size>=this.max) this.map.delete(this.map.keys().next().value); this.map.set(k,v); }
  }

  // ── Typing Indicator State ──────────────────────────────────────────────────
  const typingUsers = new Map(); // nick → timeoutId
  let localTypingTimer = null;
  let localIsTyping = false;

  function isTypingEnabled() {
    return GM_getValue('showTyping', 'true') === 'true';
  }

  function sendTyping(isTyping) {
    if (!isTypingEnabled()) return;
    if (!ws || ws.readyState !== 1) return;
    ws.send(JSON.stringify({ type: 'typing', from: getNick(), isTyping }));
  }

  function handleTypingEvent(m) {
    if (!isTypingEnabled()) return;
    if (!m.from || m.from === getNick()) return;
    if (m.isTyping) {
      // Limpa timer anterior se existia
      if (typingUsers.has(m.from)) clearTimeout(typingUsers.get(m.from));
      // Auto-remove depois de 4s (caso o stop não chegue)
      const tid = setTimeout(() => { typingUsers.delete(m.from); renderTypingBar(); }, 4000);
      typingUsers.set(m.from, tid);
    } else {
      if (typingUsers.has(m.from)) { clearTimeout(typingUsers.get(m.from)); typingUsers.delete(m.from); }
    }
    renderTypingBar();
  }

  function renderTypingBar() {
    const bar = document.getElementById('void-typing-bar');
    if (!bar) return;
    const users = [...typingUsers.keys()];
    if (!users.length) { bar.innerHTML = ''; bar.style.display = 'none'; return; }
    bar.style.display = 'flex';
    let label;
    if (users.length === 1) label = `<span class="vtb-name">${esc(users[0])}</span> está digitando`;
    else if (users.length === 2) label = `<span class="vtb-name">${esc(users[0])}</span> e <span class="vtb-name">${esc(users[1])}</span> estão digitando`;
    else if (users.length === 3) label = `<span class="vtb-name">${esc(users[0])}</span>, <span class="vtb-name">${esc(users[1])}</span> e <span class="vtb-name">${esc(users[2])}</span> estão digitando`;
    else label = `<span class="vtb-many">Várias pessoas estão digitando</span>`;
    bar.innerHTML = `<div class="vtb-dots"><span></span><span></span><span></span></div><div class="vtb-text">${label}</div>`;
  }

  function setupTypingBar() {
    if (document.getElementById('void-typing-bar')) return;
    const chatForm = document.querySelector('#chat form, #chat .form');
    if (!chatForm) return;
    const wrap = chatForm.parentElement || chatForm;
    const bar = document.createElement('div');
    bar.id = 'void-typing-bar';
    bar.style.display = 'none';
    wrap.style.position = 'relative';
    // Insere o bar antes do form
    wrap.insertBefore(bar, chatForm);
  }

  function watchTypingInput() {
    const input = document.querySelector('input[name="chat"]');
    if (!input || input.dataset.voidTypingHooked) return;
    input.dataset.voidTypingHooked = '1';

    input.addEventListener('input', () => {
      if (!isTypingEnabled()) return;
      if (input.value.length > 0) {
        if (!localIsTyping) { localIsTyping = true; sendTyping(true); }
        clearTimeout(localTypingTimer);
        localTypingTimer = setTimeout(() => { localIsTyping = false; sendTyping(false); }, 2500);
      } else {
        clearTimeout(localTypingTimer);
        if (localIsTyping) { localIsTyping = false; sendTyping(false); }
      }
    });

    // Para ao enviar
    const form = input.closest('form');
    if (form) {
      form.addEventListener('submit', () => {
        clearTimeout(localTypingTimer);
        if (localIsTyping) { localIsTyping = false; sendTyping(false); }
      });
    }

    // Para quando perde foco
    input.addEventListener('blur', () => {
      clearTimeout(localTypingTimer);
      if (localIsTyping) { localIsTyping = false; sendTyping(false); }
    });
  }

  // ── WebSocket ───────────────────────────────────────────────────────────────
  let ws=null, wsRetryDelay=1000;
  function wsConnect() {
    ws = new WebSocket(WS_URL);
    ws.onopen = () => { wsRetryDelay=1000; ws.send(JSON.stringify({type:'join',room:location.href.match(/\d{6,}/)?.[0]||'sala'})); };
    ws.onmessage = e => {
      try {
        const m = JSON.parse(e.data);
        if (m.type === 'image') injectMedia(m.from, m.img, m.mime || 'image');
        if (m.type === 'typing') handleTypingEvent(m);
      } catch(_) {}
    };
    ws.onclose = () => { setTimeout(wsConnect,wsRetryDelay); wsRetryDelay=Math.min(wsRetryDelay*2,30000); };
  }

  // ── Media ───────────────────────────────────────────────────────────────────
  function injectMedia(from, src, mime) {
    const el = getScrollEl(); if(!el) return;
    const safeSrc = safeUrl(src)||(src?.startsWith('data:') ? src : '');
    if(!safeSrc) return;
    const d = document.createElement('div');
    d.className = 'msg void-img-msg';
    let mediaEl = mime==='video'||/^data:video\/mp4/.test(src)
      ? `<video class="void-media-video" src="${safeSrc}" controls playsinline preload="metadata"></video>`
      : mime==='audio'||/^data:audio\//.test(src)
      ? `<audio class="void-media-audio" src="${safeSrc}" controls preload="metadata"></audio>`
      : `<img class="void-media-img" src="${safeSrc}" onclick="window.open(this.src,'_blank')">`;
    d.innerHTML = `<div><strong>${esc(from)}</strong></div><div>${mediaEl}</div>`;
    el.appendChild(d); chatScroll();
  }

  function sendMedia(b64, mime) {
    if(!ws||ws.readyState!==1) return;
    ws.send(JSON.stringify({type:'image',from:getNick(),img:b64,mime}));
    injectMedia('Você',b64,mime);
  }

  // ── Syntax Highlight ────────────────────────────────────────────────────────
  function detectLang(code) {
    const s = {js:0,python:0,rust:0,go:0,java:0,cpp:0,css:0,html:0,sql:0};
    if(/<\/?[a-z][a-z0-9-]*[\s>\/]/i.test(code)&&/[<>]/.test(code)) s.html+=5;
    if(/<!DOCTYPE/i.test(code)) s.html+=10;
    if(/^\s*[\.\#][a-z][\w-]*\s*\{/im.test(code)) s.css+=8;
    if(/@media|@keyframes|:root\s*\{/.test(code)) s.css+=6;
    if(/\{\s*[\w-]+\s*:/m.test(code)&&!/function|def |fn |class /.test(code)) s.css+=3;
    if(/^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)\b/im.test(code)) s.sql+=10;
    if(/\bFROM\b.*\bWHERE\b/i.test(code)) s.sql+=5;
    if(/\bdef\s+\w+\s*\(/.test(code)) s.python+=8;
    if(/\belif\b/.test(code)) s.python+=8;
    if(/\bprint\s*\(/.test(code)) s.python+=4;
    if(/:\s*$|:\s*\n/m.test(code)) s.python+=3;
    if(/\bTrue\b|\bFalse\b|\bNone\b/.test(code)) s.python+=5;
    if(/\bfn\s+\w+/.test(code)) s.rust+=8;
    if(/\blet\s+mut\b/.test(code)) s.rust+=10;
    if(/\bimpl\b|\btrait\b/.test(code)) s.rust+=8;
    if(/println!\s*\(/.test(code)) s.rust+=10;
    if(/\bpub\s+fn\b/.test(code)) s.rust+=8;
    if(/\bfunc\s+\w+/.test(code)) s.go+=8;
    if(/\bpackage\s+\w/.test(code)) s.go+=10;
    if(/\bfmt\./.test(code)) s.go+=8;
    if(/:=/.test(code)) s.go+=8;
    if(/\bgoroutine\b|\bchan\b|\bdefer\b/.test(code)) s.go+=6;
    if(/\bSystem\.out\.print/.test(code)) { s.java+=10; s.cpp-=5; }
    if(/\bpublic\s+(class|interface|static)\b/.test(code)) { s.java+=8; s.cpp+=1; }
    if(/#include\b/.test(code)) { s.cpp+=10; s.java-=5; }
    if(/\bstd::|cout\s*<<|cin\s*>>/.test(code)) { s.cpp+=10; s.java-=5; }
    if(/\bnamespace\b/.test(code)) s.cpp+=5;
    if(/\bimport\s+java\./.test(code)) s.java+=10;
    if(/\bconst\s+\w/.test(code)||/\blet\s+\w/.test(code)) s.js+=3;
    if(/=>\s*[\{\(]|=>\s*\w/.test(code)) s.js+=5;
    if(/\bconsole\.\w/.test(code)) s.js+=6;
    if(/\basync\s+function|\bawait\s+/.test(code)) s.js+=4;
    if(/`[^`]*\$\{/.test(code)) s.js+=5;
    if(/require\s*\(|module\.exports/.test(code)) s.js+=5;
    return Object.entries(s).sort((a,b)=>b[1]-a[1])[0][0];
  }

  function highlight(raw) {
    const lang = detectLang(raw);
    const e2 = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const SL=[/^\/\/[^\n]*/,'vcc'], ML=[/^\/\*[\s\S]*?\*\//,'vcc'];
    const DQ=[/^"(?:\\[\s\S]|[^"])*"/,'vcs'], SQ=[/^'(?:\\[\s\S]|[^'])*'/,'vcs'];
    const TQ=[/^`(?:\\[\s\S]|[^`])*`/,'vctem'];
    const NUM=[/^0x[0-9a-fA-F]+|\d+\.?\d*(?:[eE][+-]?\d+)?/,'vcn'];
    const FC=cls=>[/^[a-zA-Z_$][\w$]*(?=\s*\()/,cls];
    const KW=(re,c)=>[re,c];
    const rules = {
      js:     [SL,ML,TQ,DQ,SQ,KW(/^(function|const|let|var|return|if|else|for|while|do|class|extends|import|export|from|of|in|new|this|async|await|try|catch|finally|throw|typeof|instanceof|delete|void|switch|case|default|break|continue|yield|static|get|set|super)\b/,'vck'),KW(/^(true|false|null|undefined|NaN|Infinity)\b/,'vkc'),KW(/^(Array|Object|Promise|Map|Set|Error|Function|RegExp|Date|Math|JSON|console|window|document|process|module|require|parseInt|parseFloat|setTimeout|setInterval|fetch|URL|Symbol)\b/,'vcbi'),KW(/^[A-Z][a-zA-Z0-9_]*/,'vctype'),FC('vcf'),[/^=>/,'vco'],NUM],
      python: [[/^#[^\n]*/,'vcc'],[/^"""[\s\S]*?"""|^'''[\s\S]*?'''/,'vcs'],DQ,SQ,KW(/^(def|class|import|from|return|if|elif|else|for|while|with|as|try|except|finally|raise|pass|break|continue|lambda|yield|in|not|and|or|is|del|global|nonlocal|assert|async|await)\b/,'vck'),KW(/^(True|False|None|self|cls|super)\b/,'vkc'),KW(/^(int|float|str|bool|list|dict|set|tuple|range|len|print|input|open|zip|map|filter|enumerate|sorted|reversed|any|all|sum|min|max|abs|round|isinstance|hasattr|getattr|type|repr|format)\b/,'vcbi'),KW(/^[A-Z][a-zA-Z0-9_]*/,'vctype'),FC('vcf'),NUM],
      rust:   [SL,ML,DQ,SQ,KW(/^(fn|let|mut|const|static|struct|enum|impl|trait|use|pub|mod|crate|self|type|where|for|while|loop|if|else|match|return|break|continue|move|ref|in|as|dyn|async|await|unsafe|extern)\b/,'vck'),KW(/^(i8|i16|i32|i64|i128|u8|u16|u32|u64|u128|f32|f64|bool|char|str|String|Vec|Option|Result|Box|Rc|Arc|Some|None|Ok|Err|Self)\b/,'vctype'),[/^[a-zA-Z_][\w]*!(?=\s*[\(\[{])/,'vcmacro'],KW(/^[A-Z][a-zA-Z0-9_]*/,'vctype'),FC('vcf'),NUM],
      go:     [SL,ML,TQ,DQ,SQ,KW(/^(func|var|const|type|struct|interface|map|chan|package|import|return|if|else|for|range|switch|case|default|break|continue|goto|defer|go|select|make|new|append|len|cap|delete|close|panic|recover)\b/,'vck'),KW(/^(int|int8|int16|int32|int64|uint|uint8|float32|float64|bool|byte|rune|string|error|any)\b/,'vctype'),KW(/^[A-Z][a-zA-Z0-9_]*/,'vctype'),FC('vcf'),NUM],
      java:   [SL,ML,DQ,SQ,KW(/^(public|private|protected|class|interface|extends|implements|static|final|void|return|if|else|for|while|do|new|this|super|import|package|try|catch|finally|throw|throws|switch|case|default|break|continue|abstract|synchronized|enum|instanceof)\b/,'vck'),KW(/^(int|float|double|long|short|char|boolean|byte|String|Object|Integer|Double|Boolean|var)\b/,'vctype'),KW(/^[A-Z][a-zA-Z0-9_]*/,'vctype'),FC('vcf'),NUM],
      cpp:    [SL,ML,[/^#\w+/,'vcdec'],DQ,SQ,KW(/^(namespace|template|typename|virtual|explicit|operator|inline|friend|auto|return|if|else|for|while|do|switch|case|default|break|continue|try|catch|throw|class|struct|enum|union|public|private|protected|const|static|void|new|delete|this)\b/,'vck'),KW(/^(int|float|double|long|short|char|bool|unsigned|signed|void|auto|size_t|string|vector|map|shared_ptr|unique_ptr)\b/,'vctype'),KW(/^[A-Z][a-zA-Z0-9_]*/,'vctype'),FC('vcf'),NUM],
      sql:    [[/^--[^\n]*/,'vcc'],ML,DQ,SQ,KW(/^(SELECT|FROM|WHERE|INSERT|INTO|VALUES|UPDATE|SET|DELETE|CREATE|TABLE|DROP|ALTER|JOIN|LEFT|RIGHT|INNER|ON|AND|OR|NOT|NULL|AS|ORDER|BY|GROUP|HAVING|LIMIT|DISTINCT|COUNT|SUM|AVG|MAX|MIN|CASE|WHEN|THEN|ELSE|END|PRIMARY|KEY)\b/i,'vck'),FC('vcf'),NUM],
      css:    [ML,DQ,SQ,[/^@[\w-]+/,'vck'],[/^#[0-9a-fA-F]{3,8}\b/,'vcn'],[/^-?[\d.]+(?:px|em|rem|%|vh|vw|deg|s|ms|fr|ch|ex)\b/,'vcn'],[/^-?[\d.]+/,'vcn'],[/^(?:rgba?|hsla?|linear-gradient|radial-gradient|url)(?=\s*\()/,'vcf'],[/^var(?=\s*\()/,'vcf'],[/^--[\w-]+/,'vcvar'],[/^[\w-]+(?=\s*:(?!:))/,'vcprop']],
      html:   [[/^<!--[\s\S]*?-->/,'vcc'],[/^<\/?([\w-]+)/,'vct'],DQ,SQ,[/^[\w-:@]+(?=\s*=)/,'vca'],[/^[0-9]+/,'vcn']],
    };
    const langRules = rules[lang]||rules.js;
    let i=0, out=''; const n=raw.length;
    while(i<n) {
      let matched=false;
      const rest=raw.slice(i);
      for(const [re,cls] of langRules) {
        const m=rest.match(re);
        if(m) { out+=`<span class="${cls}">${e2(m[0])}</span>`; i+=m[0].length; matched=true; break; }
      }
      if(!matched) { const ch=raw[i]; out+=ch==='&'?'&amp;':ch==='<'?'&lt;':ch==='>'?'&gt;':ch; i++; }
    }
    return out;
  }

  // ── Code Block ──────────────────────────────────────────────────────────────
  const ICO_COPY='<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
  const ICO_DL='<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';
  const ICO_FILE='<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>';
  const EXT_MAP={js:'js',ts:'ts',jsx:'jsx',tsx:'tsx',py:'py',python:'py',html:'html',css:'css',scss:'css',json:'json',txt:'txt',md:'md',sh:'sh',sql:'sql',go:'go',rs:'rs',rb:'rb',java:'java',c:'c',cpp:'cpp',cs:'cs',code:'txt'};

  function makeCodeBlock(text, nick, filename) {
    const lang = filename ? filename.split('.').pop().toLowerCase() : detectLang(text);
    const lines = text.split('\n').length;
    const uid = 'vc_'+Math.random().toString(36).slice(2,8);
    const label = filename||(lang+' snippet');
    const ext = EXT_MAP[lang]||'txt';
    const el = document.createElement('div');
    el.className='msg void-code-msg';
    el.innerHTML=`<div class="vcb-wrap"><div class="vcb-header"><div class="vcb-meta"><span class="vcb-icon">${ICO_FILE}</span><span class="vcb-nick">${esc(nick)}</span><span class="vcb-filename">${esc(label)}</span><span class="vcb-badge">${esc(lang)}</span><span class="vcb-lines">${lines} linha${lines!==1?'s':''}</span></div><div class="vcb-actions"><button class="vcb-btn" id="${uid}-copy" title="Copiar">${ICO_COPY}<span>Copiar</span></button><button class="vcb-btn" id="${uid}-dl" title="Baixar">${ICO_DL}<span>Baixar</span></button></div></div><div class="vcb-body"><pre>${highlight(text)}</pre></div></div>`;
    setTimeout(()=>{
      document.getElementById(uid+'-copy')?.addEventListener('click',()=>{
        navigator.clipboard.writeText(text).then(()=>{
          const b=document.getElementById(uid+'-copy');
          if(b){b.querySelector('span').textContent='Copiado!';b.style.color='#4ade80';setTimeout(()=>{b.querySelector('span').textContent='Copiar';b.style.color='';},1500);}
        });
      });
      document.getElementById(uid+'-dl')?.addEventListener('click',()=>{
        const a=document.createElement('a');
        a.href=URL.createObjectURL(new Blob([text],{type:'text/plain'}));
        a.download=filename||('void_snippet.'+ext); a.click();
      });
    },0);
    return el;
  }

  function tryConvertToCode(node) {
    if(!node||node.dataset?.voidChecked) return;
    if(node.classList?.contains('void-code-msg')||node.classList?.contains('void-img-msg')) return;
    node.dataset.voidChecked='1';
    const strong=node.querySelector('strong'), span=node.querySelector('span');
    if(!strong||!span) return;
    const text=span.textContent||'';
    if(text.length>60&&CODE_RE.test(text))
      node.replaceWith(makeCodeBlock(text,strong.textContent.trim(),null));
  }

  // ── File Upload Button ──────────────────────────────────────────────────────
  function injectBtn() {
    const input=document.querySelector('input[name="chat"]');
    if(!input||document.getElementById('void-img-btn')) return;
    const par=input.parentElement;
    par.style.position='relative';
    const fi=Object.assign(document.createElement('input'),{type:'file',accept:'image/*,video/mp4,audio/mpeg,audio/mp3,.gif,.mp4,.mp3,.js,.ts,.jsx,.tsx,.py,.html,.css,.scss,.json,.txt,.md,.php,.java,.c,.cpp,.cs,.go,.rs,.rb,.sh,.yaml,.xml,.sql'});
    fi.style.display='none';
    fi.onchange=()=>{
      const file=fi.files[0]; if(!file) return;
      if(TEXT_TYPES.test(file.type)||CODE_EXTS.test(file.name)) {
        const r=new FileReader();
        r.onload=ev=>{const el=getScrollEl();if(el){el.appendChild(makeCodeBlock(ev.target.result,getNick(),file.name));chatScroll();}};
        r.readAsText(file,'utf-8'); fi.value=''; return;
      }
      const limits={mp4:8,audio:50,gif:4};
      const isVideo=file.type==='video/mp4'||file.name.endsWith('.mp4');
      const isAudio=file.type.startsWith('audio/')||file.name.endsWith('.mp3');
      const isGif=file.type==='image/gif'||file.name.endsWith('.gif');
      const maxMB=isVideo?limits.mp4:isAudio?limits.audio:isGif?limits.gif:null;
      if(maxMB&&file.size>maxMB*1024*1024){alert(`Arquivo muito grande — máximo ${maxMB}MB`);fi.value='';return;}
      if(isVideo||isAudio||isGif){
        const r=new FileReader();
        r.onload=ev=>sendMedia(ev.target.result,isVideo?'video':isAudio?'audio':'gif');
        r.readAsDataURL(file); fi.value=''; return;
      }
      const r=new FileReader();
      r.onload=ev=>{
        const img=new Image();
        img.onload=()=>{
          const c=document.createElement('canvas'),MAX=400;
          let[w,h]=[img.width,img.height];
          if(w>MAX||h>MAX) w>h?(h=Math.round(h*MAX/w),w=MAX):(w=Math.round(w*MAX/h),h=MAX);
          c.width=w;c.height=h;c.getContext('2d').drawImage(img,0,0,w,h);
          sendMedia(c.toDataURL('image/jpeg',0.75),'image');
        };
        img.src=ev.target.result;
      };
      r.readAsDataURL(file); fi.value='';
    };
    const btn=Object.assign(document.createElement('button'),{id:'void-img-btn',type:'button',textContent:'+',title:'Enviar imagem ou código'});
    btn.onclick=e=>{e.preventDefault();fi.click();};
    par.appendChild(btn); par.appendChild(fi);
    injectEmojiBtn(par);
    // Tenta criar o typing bar depois que o input estiver no DOM
    setTimeout(()=>{ setupTypingBar(); watchTypingInput(); }, 200);
  }

  // ── Emoji Picker ────────────────────────────────────────────────────────────
  function injectEmojiBtn(par) {
    if(document.getElementById('void-emoji-btn')) return;
    const FREQ_KEY='void_emoji_freq';
    let emojiFreq={};
    try{emojiFreq=JSON.parse(GM_getValue(FREQ_KEY,'{}'));}catch(_){emojiFreq={};}
    const trackEmoji=em=>{emojiFreq[em]=(emojiFreq[em]||0)+1;try{GM_setValue(FREQ_KEY,JSON.stringify(emojiFreq));}catch(_){}};
    const getFrequent=()=>Object.entries(emojiFreq).sort((a,b)=>b[1]-a[1]).slice(0,24).map(e=>e[0]);
    const CATS = {
      'frequentes': [],
      'rostos':   '😀😁😂🤣😃😄😅😆😉😊😋😎😍🥰😘😗😙😚🙂🤗🤩🤔🤨😐😑😶🙄😏😣😥😮🤐😯😪😫🥱😴😌😛😜😝🤤😒😓😔😕🙃🤑😲😷🤒🤕🤢🤧🥵🥶🥴😵🤯🤠🥳😈👿👹👺💀☠️👻👽👾🤖',
      'gestos':   '👍👎👊✊🤛🤜🤞✌️🤟🤘👌🤌🤏👈👉👆👇☝️✋🤚🖐️🖖👋🤙💪🦾🖕✍️🙏🦶🦵👀👁️👅👄🧠🦷🦴',
      'coração':  '❤️🧡💛💚💙💜🖤🤍🤎💔❣️💕💞💓💗💖💘💝💟✨⭐🌟💫🔥⚡🌈☀️🌊❄️🌸🌺🌻🌹🌼🥀🍀🌙💎🎀🎁🎊🎉',
      'natureza': '🌍🌎🌏🌐🏔️⛰️🌋🏕️🏖️🏜️🏝️🌅🌄🌠🌇🌆🏙️🌃🌌🌉☀️🌤️⛅☁️🌦️🌧️⛈️🌩️🌨️❄️☃️⛄💧🌊🦋🐶🐱🐭🐹🐰🦊🐻🐼🐨🐯🦁🐮🐷🐸🐵',
      'comida':   '🍕🍔🍟🌭🍿🥓🥚🍳🧇🥞🍞🥐🧀🥗🌮🌯🍱🍣🍜🍝🍦🍧🍨🍩🍪🎂🍰🧁🍫🍬🍭🍼🥛☕🍵🧃🥤🧋🍺🍻🥂🍷🥃🍸🍹',
      'objetos':  '💻🖥️⌨️🖱️📱☎️📺📻🎙️🎧🔋🔌💡🔦💰💳💎🔧🔨🛠️🔩🔫💣🔪⚔️🛡️🧰📚📖📝✏️🖊️📌📍📎🔑🗝️🔒🔓🔐🏆🥇🎖️🏅🎵🎶🎼🎤🎹🥁🎸🎺🎻🎨🖌️📷🎬🎮🕹️',
      'atividade':'⚽🏀🏈⚾🎾🏐🏉🎱🏓🏸🥊🥋🎽🛹⛷️🏂🏋️🤸🏊🏄🧘🚴🏇🎯🎮🕹️🎲🎰🎳🎪🎭🎨🎬🎤🎧🎼🎵🎶',
      'lugares':  '🏠🏡🏢🏣🏤🏥🏦🏧🏨🏪🏫🏬🏭🏯🏰⛪🕌🕍⛩️🗼🗽🗿🚗🚕🚙🚌🚎🏎️🚓🚑🚒🚐✈️🚀🛸⛵🚢🚂🚁🛺🚲🛴🛵🏍️',
      'símbolos': '✅❌⭕🔴🟠🟡🟢🔵🟣⚫⚪🔶🔷🔸🔹🔺🔻💠🔘🔲🔳▶️⏸️⏹️⏭️⏮️🔀🔁🔂🔃🔄⬆️⬇️⬅️➡️🔔🔕🔇🔈🔉🔊📢📣💬💭🗯️ℹ️🆘🆕🆙🆒🆓💯🔝🆗🔛🔜🔚♻️🚫⛔🚩🏁🏳️🏴🎌',
    };
    const KWORDS = {
      '😀':'feliz sorriso happy smile','😂':'rindo lol laugh haha','😍':'apaixonado amor love','🔥':'fogo fire quente hot','❤️':'coração amor love heart','👍':'joinha like positivo ok','💀':'caveira morte skull dead','🎉':'festa parabéns party celebration','😭':'chorando cry sad triste','🥺':'please pedindo olhos','😊':'fofo cute blush tímido','🤣':'gargalhada rolando lol','👀':'olhos eyes olhando','✨':'brilho sparkles magic','🙏':'obrigado please pray','💯':'cem 100 perfeito perfect','🥰':'amor coração love cute','💪':'forte músculo strong','🤔':'pensando think duvida','😎':'legal cool óculos','🌸':'sakura flor cherry rosa','😘':'beijo kiss amor','🤦':'facepalm vergonha','🌊':'onda wave mar ocean','🎮':'jogo game videogame','💻':'computador laptop pc','🍕':'pizza comida food','⚽':'futebol soccer bola',
    };
    const TAB_ICONS={'frequentes':'⭐','rostos':'😀','gestos':'👍','coração':'❤️','natureza':'🌿','comida':'🍕','objetos':'💻','atividade':'⚽','lugares':'🏠','símbolos':'🔔'};
    const catKeys=Object.keys(CATS);
    const emojiBtn=document.createElement('button');
    emojiBtn.id='void-emoji-btn';emojiBtn.type='button';emojiBtn.title='Emojis';
    emojiBtn.innerHTML='<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>';
    const picker=document.createElement('div');
    picker.id='void-emoji-picker';
    const tabsEl=document.createElement('div');tabsEl.className='vep-tabs';
    const bodyEl=document.createElement('div');bodyEl.className='vep-body';
    const searchEl=Object.assign(document.createElement('input'),{className:'vep-search',placeholder:'🔍 buscar emoji...',type:'text'});
    const gridEl=document.createElement('div');gridEl.className='vep-grid';
    let activeTab=catKeys[0];
    function getCatEmojis(cat) {
      const str=CATS[cat];
      if(!str||!str.length) return [];
      return [...new Intl.Segmenter('pt',{granularity:'grapheme'}).segment(str)].map(s=>s.segment);
    }
    function getFrequentEmojis() {
      const f=getFrequent();
      return f.length?f:['😂','❤️','🔥','👍','😭','✨','🥺','😍','🙏','💀','🤣','💯','🥰','😊','🎉','👀','🌸','💫','😘','🎮','💻','🤔','😎','🌊'];
    }
    function renderGrid(emojis) {
      gridEl.innerHTML='';
      if(!emojis.length){const e=document.createElement('div');e.className='vep-empty';e.textContent='Nenhum emoji encontrado 😕';gridEl.appendChild(e);return;}
      emojis.forEach(em=>{
        const b=document.createElement('button');b.className='vep-emoji';b.textContent=em;b.title=KWORDS[em]||em;
        b.addEventListener('click',()=>insertEmoji(em));gridEl.appendChild(b);
      });
    }
    function insertEmoji(em) {
      const inp=document.querySelector('input[name="chat"]'); if(!inp) return;
      trackEmoji(em);
      const nv=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value')?.set;
      const start=inp.selectionStart??inp.value.length,end=inp.selectionEnd??start;
      const newVal=inp.value.slice(0,start)+em+inp.value.slice(end);
      nv?nv.call(inp,newVal):(inp.value=newVal);
      inp.dispatchEvent(new Event('input',{bubbles:true}));inp.dispatchEvent(new Event('change',{bubbles:true}));
      inp.focus();requestAnimationFrame(()=>{inp.selectionStart=inp.selectionEnd=start+em.length;});
      picker.classList.remove('visible');
      if(activeTab==='frequentes') renderGrid(getFrequentEmojis());
    }
    function setTab(cat) {
      activeTab=cat;
      tabsEl.querySelectorAll('.vep-tab').forEach(t=>t.classList.toggle('vep-tab-active',t.dataset.cat===cat));
      searchEl.value='';
      renderGrid(cat==='frequentes'?getFrequentEmojis():getCatEmojis(cat));
    }
    catKeys.forEach(cat=>{
      const t=document.createElement('button');t.className='vep-tab';t.dataset.cat=cat;
      t.textContent=TAB_ICONS[cat]||cat;t.title=cat.charAt(0).toUpperCase()+cat.slice(1);
      t.addEventListener('click',()=>setTab(cat));tabsEl.appendChild(t);
    });
    searchEl.addEventListener('input',()=>{
      const q=searchEl.value.trim().toLowerCase();
      if(!q){setTab(activeTab);return;}
      tabsEl.querySelectorAll('.vep-tab').forEach(t=>t.classList.remove('vep-tab-active'));
      const seen=new Set(), results=[];
      for(const [cat,str] of Object.entries(CATS)) {
        if(cat==='frequentes') continue;
        const emojis=getCatEmojis(cat);
        for(const em of emojis) {
          if(seen.has(em)) continue;
          const kw=KWORDS[em]||'';
          if(em.includes(q)||kw.includes(q)){results.push(em);seen.add(em);}
        }
      }
      renderGrid(results);
    });
    bodyEl.appendChild(searchEl);bodyEl.appendChild(gridEl);
    picker.appendChild(tabsEl);picker.appendChild(bodyEl);
    document.body.appendChild(picker);
    setTab(catKeys[0]);
    emojiBtn.addEventListener('click',e=>{
      e.preventDefault();e.stopPropagation();
      picker.classList.toggle('visible');
      if(picker.classList.contains('visible')){
        setTab(activeTab);
        requestAnimationFrame(()=>{
          const r=emojiBtn.getBoundingClientRect();
          picker.style.left=Math.max(4,r.right-picker.offsetWidth)+'px';
          picker.style.top=(r.top-picker.offsetHeight-8)+'px';
        });
      }
    });
    document.addEventListener('click',e=>{if(!picker.contains(e.target)&&e.target!==emojiBtn) picker.classList.remove('visible');});
    par.appendChild(emojiBtn);
  }

  // ── Mentions ────────────────────────────────────────────────────────────────
  let mentionAudio=null;
  function playMentionSound() {
    if(!mentionAudio){mentionAudio=new Audio(MENTION_SFX);mentionAudio.volume=0.5;}
    mentionAudio.currentTime=0;mentionAudio.play().catch(()=>{});
  }

  function highlightMentions(node) {
    if(!node||node.dataset.voidMention) return;
    if(!node.classList?.contains('msg')) return;
    if(node.classList.contains('void-code-msg')||node.classList.contains('void-img-msg')||node.classList.contains('void-music-card')||node.classList.contains('void-link-card')) return;
    node.dataset.voidMention='1';
    const myNick=getNick().toLowerCase();
    const walker=document.createTreeWalker(node,NodeFilter.SHOW_TEXT,null);
    const toReplace=[]; let tn;
    while((tn=walker.nextNode())) if(tn.textContent.includes('@')) toReplace.push(tn);
    toReplace.forEach(tn=>{
      if(!tn.parentElement||tn.parentElement.classList.contains('void-mention')||tn.parentElement.tagName==='STRONG') return;
      if(!/@\S/.test(tn.textContent)) return;
      const frag=document.createDocumentFragment();
      tn.textContent.split(/(@\S+)/g).forEach(part=>{
        if(/^@\S+$/.test(part)){
          const nick=part.slice(1).toLowerCase(),isMine=myNick.includes(nick)||nick.includes(myNick);
          const s=document.createElement('span');s.className='void-mention'+(isMine?' void-mention-me':'');s.textContent=part;
          frag.appendChild(s);
          if(isMine){node.classList.add('void-msg-mentioned');if(document.hidden||!document.hasFocus())playMentionSound();}
        } else frag.appendChild(document.createTextNode(part));
      });
      tn.parentNode.replaceChild(frag,tn);
    });
  }

  // ── Link Preview ─────────────────────────────────────────────────────────────
  const ogCache=new LRUMap(200);
  function linkifyTextNode(tn) {
    if(!tn.parentElement||tn.parentElement.tagName==='A'||tn.parentElement.tagName==='STRONG') return false;
    URL_RE.lastIndex=0;
    if(!URL_RE.test(tn.textContent)) return false;
    URL_RE.lastIndex=0;
    const frag=document.createDocumentFragment();
    let last=0,m;
    URL_RE.lastIndex=0;
    while((m=URL_RE.exec(tn.textContent))!==null){
      if(m.index>last) frag.appendChild(document.createTextNode(tn.textContent.slice(last,m.index)));
      const a=document.createElement('a');a.href=m[0];a.target='_blank';a.rel='noopener noreferrer';a.className='void-link';a.textContent=m[0];
      frag.appendChild(a);last=m.index+m[0].length;
    }
    if(last<tn.textContent.length) frag.appendChild(document.createTextNode(tn.textContent.slice(last)));
    tn.parentNode.replaceChild(frag,tn);return true;
  }

  function buildLinkCard(og) {
    const card=document.createElement('div');card.className='void-link-card';card.dataset.voidMusicChecked='1';
    const domain=()=>{try{return new URL(og.url).hostname.replace('www.','');}catch(_){return '';}};
    const site=esc(og.siteName||domain());
    const title=og.title?esc(og.title):'';
    const desc=og.description?esc(og.description.slice(0,160))+(og.description.length>160?'…':''):'';
    const href=safeUrl(og.url),img=og.image?safeUrl(og.image):'';
    card.innerHTML=`<a class="vlc-inner" href="${href}" target="_blank" rel="noopener noreferrer"><div class="vlc-info"><div class="vlc-site">${site}</div>${title?`<div class="vlc-title">${title}</div>`:''} ${desc?`<div class="vlc-desc">${desc}</div>`:''}</div>${img?`<div class="vlc-img-wrap"><img class="vlc-img" src="${img}" alt="" onerror="this.parentElement.style.display='none'"></div>`:''}</a>`;
    return card;
  }

  async function processLinksInMsg(node) {
    if(!node||node.dataset.voidLinks) return;
    if(!node.classList?.contains('msg')) return;
    if(node.classList.contains('void-code-msg')||node.classList.contains('void-img-msg')||node.classList.contains('void-music-card')||node.classList.contains('void-link-card')) return;
    node.dataset.voidLinks='1';
    const walker=document.createTreeWalker(node,NodeFilter.SHOW_TEXT,null);
    const tns=[]; let tn;
    while((tn=walker.nextNode())) tns.push(tn);
    const urls=[];
    tns.forEach(t=>{
      URL_RE.lastIndex=0;
      const matches=[...t.textContent.matchAll(new RegExp(URL_RE.source,'g'))].map(m=>m[0]);
      if(matches.length){linkifyTextNode(t);matches.forEach(u=>{if(!MUSIC_HOSTS.test(u))urls.push(u);});}
    });
    const seen=new Set();
    for(const url of urls){
      if(seen.has(url)) continue;seen.add(url);
      let og;
      if(ogCache.has(url)){og=ogCache.get(url);}
      else{try{const r=await fetch(OG_API+encodeURIComponent(url));og=r.ok?await r.json():null;if(og?.error)og=null;}catch(_){og=null;}ogCache.set(url,og);}
      if(og&&(og.title||og.image)){const el=getScrollEl();if(el){node.after(buildLinkCard(og));chatScroll();}}
    }
  }

  // ── Reactions ────────────────────────────────────────────────────────────────
  const REACTION_EMOJIS=['👍','❤️','😂','😮','🔥','👏','😢','💀'];
  const reactionData={};
  const getMsgId=node=>{if(!node.dataset.voidMsgId)node.dataset.voidMsgId='vm_'+Math.random().toString(36).slice(2,10);return node.dataset.voidMsgId;};

  function renderReactionBar(node) {
    const id=getMsgId(node),data=reactionData[id]||{};
    let bar=node.querySelector('.void-reaction-bar');
    if(!bar){bar=document.createElement('div');bar.className='void-reaction-bar';node.appendChild(bar);}
    bar.innerHTML=Object.entries(data).filter(e=>e[1]>0).map(e=>`<button class="void-react-pill" data-emoji="${e[0]}">${e[0]} <span>${e[1]}</span></button>`).join('');
    bar.querySelectorAll('.void-react-pill').forEach(btn=>btn.addEventListener('click',()=>toggleReaction(node,btn.dataset.emoji)));
  }

  function toggleReaction(node,emoji) {
    const id=getMsgId(node);
    if(!reactionData[id])reactionData[id]={};
    const key='reacted_'+emoji;
    if(node.dataset[key]){reactionData[id][emoji]=Math.max(0,(reactionData[id][emoji]||1)-1);delete node.dataset[key];}
    else{reactionData[id][emoji]=(reactionData[id][emoji]||0)+1;node.dataset[key]='1';}
    renderReactionBar(node);
  }

  function addReactionHover(node) {
    if(!node||node.dataset.voidReact) return;
    if(!node.classList?.contains('msg')) return;
    if(node.classList.contains('void-code-msg')||node.classList.contains('void-img-msg')||node.classList.contains('void-music-card')||node.classList.contains('void-link-card')) return;
    if(!node.querySelector('strong')) return;
    node.dataset.voidReact='1';
    const addBtn=document.createElement('button');addBtn.className='void-react-add-btn';addBtn.title='Reagir';
    addBtn.innerHTML='<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg><span style="font-size:10px;font-weight:700;margin-left:1px">+</span>';
    const picker=document.createElement('div');picker.className='void-react-picker';
    picker.innerHTML=REACTION_EMOJIS.map(e=>`<button class="void-react-opt" data-emoji="${e}">${e}</button>`).join('');
    node.appendChild(addBtn);node.appendChild(picker);
    picker.querySelectorAll('.void-react-opt').forEach(btn=>btn.addEventListener('click',ev=>{ev.stopPropagation();toggleReaction(node,btn.dataset.emoji);picker.classList.remove('visible');}));
    addBtn.addEventListener('click',ev=>{ev.stopPropagation();document.querySelectorAll('.void-react-picker.visible').forEach(p=>p.classList.remove('visible'));picker.classList.toggle('visible');});
    document.addEventListener('click',()=>picker.classList.remove('visible'));
    renderReactionBar(node);
  }

  function enrichMsg(node) {
    if(!node||node.nodeType!==1) return;
    setTimeout(()=>{highlightMentions(node);addReactionHover(node);processLinksInMsg(node);},60);
  }

  // ── Music Player ─────────────────────────────────────────────────────────────
  const spotifyMetaCache=new LRUMap(100);
  const processedMusicUrls=new Set();
  let musicQueue=[],musicCurrent=-1,playerEl=null,playerDragging=false,playerDX=0,playerDY=0;

  function detectMusicLink(text) {
    let m;
    if((m=text.match(MUSIC_RE.youtube))) return{type:'youtube',id:m[1],url:text.trim()};
    if((m=text.match(MUSIC_RE.spotify))) return{type:'spotify',kind:m[1],id:m[2],url:text.trim()};
    if((m=text.match(MUSIC_RE.soundcloud))) return{type:'soundcloud',path:m[1],url:text.trim()};
    return null;
  }

  function buildEmbedSrc(item) {
    if(item.type==='youtube') return`https://www.youtube.com/embed/${item.id}?autoplay=1&rel=0`;
    if(item.type==='spotify') return`https://open.spotify.com/embed/${item.kind}/${item.id}?utm_source=generator&theme=0&autoplay=1`;
    if(item.type==='soundcloud') return`https://w.soundcloud.com/player/?url=https://soundcloud.com/${item.path}&color=%2338bdf8&auto_play=true&hide_related=true&show_comments=false`;
    return'';
  }

  function musicIcon(type) {
    if(type==='youtube') return'<svg width="16" height="16" viewBox="0 0 24 24" fill="#ff0000"><path d="M23 7s-.3-2-1.2-2.8c-1.1-1.2-2.4-1.2-3-1.3C16.2 2.8 12 2.8 12 2.8s-4.2 0-6.8.1c-.6.1-1.9.1-3 1.3C1.3 5 1 7 1 7S.7 9.1.7 11.2v2c0 2.1.3 4.2.3 4.2s.3 2 1.2 2.8c1.1 1.2 2.6 1.1 3.3 1.2C7.2 21.6 12 21.6 12 21.6s4.2 0 6.8-.2c.6-.1 1.9-.1 3-1.3.9-.8 1.2-2.8 1.2-2.8s.3-2.1.3-4.2v-2C23.3 9.1 23 7 23 7zM9.7 15.5V8.4l8.1 3.6-8.1 3.5z"/></svg>';
    if(type==='spotify') return'<svg width="16" height="16" viewBox="0 0 24 24" fill="#1db954"><path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z"/></svg>';
    return'<svg width="16" height="16" viewBox="0 0 24 24" fill="#ff5500"><path d="M1.175 12.225C.528 12.225 0 12.75 0 13.397v5.228c0 .648.528 1.172 1.175 1.172.648 0 1.176-.524 1.176-1.172v-5.228c0-.646-.528-1.172-1.176-1.172zm3.322-2.544c-.647 0-1.175.525-1.175 1.172v7.772c0 .647.528 1.172 1.175 1.172.648 0 1.175-.525 1.175-1.172V10.853c0-.647-.527-1.172-1.175-1.172zm3.322-2.453c-.646 0-1.175.525-1.175 1.172v10.225c0 .647.529 1.172 1.175 1.172.648 0 1.175-.525 1.175-1.172V8.4c0-.647-.527-1.172-1.175-1.172zm3.322.756c-.647 0-1.175.525-1.175 1.172v9.469c0 .647.528 1.172 1.175 1.172s1.175-.525 1.175-1.172V9.156c0-.647-.528-1.172-1.175-1.172zm3.322-4.297c-.648 0-1.175.525-1.175 1.172v13.766c0 .647.527 1.172 1.175 1.172.647 0 1.175-.525 1.175-1.172V4.859c0-.647-.528-1.172-1.175-1.172zm3.321 2.016c-.647 0-1.175.525-1.175 1.172v11.75c0 .647.528 1.172 1.175 1.172.648 0 1.175-.525 1.175-1.172V6.875c0-.647-.527-1.172-1.175-1.172zm3.323 2.675c-.648 0-1.176.525-1.176 1.172v9.075c0 .647.528 1.172 1.176 1.172.647 0 1.174-.525 1.174-1.172V9.55c0-.647-.527-1.172-1.174-1.172z"/></svg>';
  }

  function renderQueue() {
    const qEl=document.getElementById('void-music-queue'); if(!qEl) return;
    if(!musicQueue.length){qEl.innerHTML='<div class="vmq-empty">Fila vazia — cole um link abaixo</div>';return;}
    qEl.innerHTML=musicQueue.map((item,i)=>`<div class="vmq-item${i===musicCurrent?' vmq-active':''}" data-idx="${i}"><span class="vmq-ico">${musicIcon(item.type)}</span><span class="vmq-label">${esc(item.label)}</span><button class="vmq-del" data-idx="${i}" title="Remover">✕</button></div>`).join('');
    qEl.querySelectorAll('.vmq-item').forEach(el=>el.addEventListener('click',e=>{if(e.target.classList.contains('vmq-del'))return;playIndex(parseInt(el.dataset.idx));}));
    qEl.querySelectorAll('.vmq-del').forEach(btn=>btn.addEventListener('click',()=>{const idx=parseInt(btn.dataset.idx);musicQueue.splice(idx,1);if(musicCurrent>=idx)musicCurrent=Math.max(-1,musicCurrent-1);renderQueue();if(musicCurrent<0&&musicQueue.length)playIndex(0);}));
  }

  function playIndex(idx) {
    if(idx<0||idx>=musicQueue.length) return;
    musicCurrent=idx;const item=musicQueue[idx];
    const iframe=document.getElementById('void-music-iframe'),wrap=document.getElementById('void-music-iframe-wrap');
    if(iframe){
      if(item.type==='spotify'&&wrap){wrap.style.height=item.kind==='track'?'152px':'352px';wrap.style.aspectRatio='unset';}
      else if(wrap){wrap.style.height='';wrap.style.aspectRatio='16/9';}
      iframe.src=buildEmbedSrc(item);
    }
    const titleEl=document.getElementById('void-music-title');
    if(titleEl)titleEl.textContent=({youtube:'▶ YouTube',spotify:'♫ Spotify',soundcloud:'☁ SoundCloud'})[item.type]||'VOID Player';
    renderQueue();
    const body=document.getElementById('void-music-body');if(body)body.style.display='block';
    const minBtn=document.getElementById('void-music-min');if(minBtn){minBtn.setAttribute('data-min','0');minBtn.textContent='—';}
  }

  function addToQueue(url,label) {
    const info=detectMusicLink(url); if(!info) return false;
    const short=info.url.replace(/https?:\/\//,'').replace(/www\./,'');
    info.label=label||(short.length>38?short.slice(0,36)+'…':short);
    musicQueue.push(info);renderQueue();
    if(musicCurrent<0) playIndex(musicQueue.length-1);
    return true;
  }

  function buildMusicPlayer() {
    if(document.getElementById('void-music-player')) return;
    const p=document.createElement('div');p.id='void-music-player';
    p.innerHTML=`<div id="void-music-bar"><div id="void-music-bar-left"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg><span id="void-music-title">VOID Player</span></div><div style="display:flex;gap:4px;align-items:center"><button id="void-music-min" data-min="0">—</button><button id="void-music-close">✕</button></div></div><div id="void-music-body"><div id="void-music-iframe-wrap"><iframe id="void-music-iframe" allow="accelerometer;autoplay;clipboard-write;encrypted-media;gyroscope;picture-in-picture" allowfullscreen frameborder="0" src=""></iframe></div><div id="void-music-queue-wrap"><div class="vm-section-title">FILA</div><div id="void-music-queue"></div></div><div id="void-music-input-row"><input id="void-music-input" type="text" placeholder="Cole link do YouTube, Spotify ou SoundCloud…"><button id="void-music-add">+</button></div></div>`;
    document.body.appendChild(p);
    const bar=p.querySelector('#void-music-bar');
    bar.addEventListener('mousedown',e=>{if(e.target.tagName==='BUTTON')return;playerDragging=true;const r=p.getBoundingClientRect();playerDX=e.clientX-r.left;playerDY=e.clientY-r.top;p.style.transition='none';e.preventDefault();});
    document.addEventListener('mousemove',e=>{if(!playerDragging)return;p.style.right='auto';p.style.bottom='auto';p.style.left=(e.clientX-playerDX)+'px';p.style.top=(e.clientY-playerDY)+'px';});
    document.addEventListener('mouseup',()=>{playerDragging=false;});
    p.querySelector('#void-music-min').addEventListener('click',()=>{const body=document.getElementById('void-music-body'),btn=document.getElementById('void-music-min'),mini=btn.getAttribute('data-min')==='1';body.style.display=mini?'block':'none';btn.textContent=mini?'—':'⊡';btn.setAttribute('data-min',mini?'0':'1');});
    p.querySelector('#void-music-close').addEventListener('click',()=>{const iframe=document.getElementById('void-music-iframe');if(iframe)iframe.src='';musicCurrent=-1;p.remove();playerEl=null;});
    const addFn=()=>{const inp=document.getElementById('void-music-input'),val=inp?.value.trim();if(!val)return;if(!addToQueue(val)){inp.style.borderColor='#f87171';setTimeout(()=>inp.style.borderColor='',1200);return;}inp.value='';};
    p.querySelector('#void-music-add').addEventListener('click',addFn);
    p.querySelector('#void-music-input').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();addFn();}});
    playerEl=p;renderQueue();
  }

  function buildMusicBtn() {
    if(document.getElementById('void-music-btn')) return;
    const btn=document.createElement('button');btn.id='void-music-btn';btn.title='VOID Video Player';
    btn.innerHTML='<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>';
    btn.addEventListener('click',()=>{if(!document.getElementById('void-music-player'))buildMusicPlayer();else document.getElementById('void-music-player')?.remove();});
    document.body.appendChild(btn);
  }

  async function fetchSpotifyMeta(url) {
    if(spotifyMetaCache.has(url)) return spotifyMetaCache.get(url);
    try{const r=await fetch('https://open.spotify.com/oembed?url='+encodeURIComponent(url));if(!r.ok)return null;const d=await r.json();spotifyMetaCache.set(url,d);return d;}catch(_){return null;}
  }

  async function buildSpotifyCard(from,info,url) {
    const safeFrom=esc(from),safeHref=safeUrl(url); if(!safeHref) return null;
    const d=document.createElement('div');d.className='msg void-music-card void-spotify-card';d.dataset.voidMusicChecked='1';
    const typeLabel=info.kind?info.kind.charAt(0).toUpperCase()+info.kind.slice(1):'Track';
    const shortUrl=safeHref.replace(/https?:\/\//,'').replace(/www\./,'');
    d.innerHTML=`<div class="vsc-outer"><div class="vsc-bg-blur"></div><div class="vsc-content"><div class="vsc-artwork-wrap"><div class="vsc-artwork-loading"><div class="vsc-spinner"></div></div></div><div class="vsc-right"><div class="vsc-header">${musicIcon('spotify')}<strong class="vsc-nick">${safeFrom}</strong><span class="vsc-type-badge">${esc(typeLabel)}</span></div><div class="vsc-track-name">Carregando...</div><div class="vsc-artist-name"></div><div class="vsc-url-row"><a class="vsc-link" href="${safeHref}" target="_blank" rel="noopener noreferrer">${esc(shortUrl.length>48?shortUrl.slice(0,46)+'…':shortUrl)}</a></div><div class="vsc-actions"><button class="vsc-play-btn"><svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>Tocar</button><a class="void-open-btn" href="${safeHref}" target="_blank" rel="noopener noreferrer"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>Spotify</a></div></div></div></div>`;
    d.querySelector('.vsc-play-btn').addEventListener('click',()=>{if(!document.getElementById('void-music-player'))buildMusicPlayer();addToQueue(url,from+' — Spotify '+typeLabel);});
    fetchSpotifyMeta(url).then(meta=>{
      if(!meta) return;
      const aw=d.querySelector('.vsc-artwork-wrap'),tn=d.querySelector('.vsc-track-name'),an=d.querySelector('.vsc-artist-name'),bg=d.querySelector('.vsc-bg-blur');
      if(meta.thumbnail_url&&aw) aw.innerHTML=`<img class="vsc-artwork" src="${esc(meta.thumbnail_url)}" alt="" onerror="this.parentElement.innerHTML='<div class=vsc-artwork-fallback>♫</div>'">`;
      else if(aw) aw.innerHTML='<div class="vsc-artwork-fallback">♫</div>';
      if(tn){const parts=(meta.title||'').split(' · ');tn.textContent=parts[0]?.trim()||'';if(an)an.textContent=parts.length>1?parts.slice(1).join(' · ').replace(/ on Spotify$/i,'').trim():meta.author_name||'';}
      if(meta.thumbnail_url){const img=new Image();img.crossOrigin='anonymous';img.onload=()=>{try{const cv=document.createElement('canvas');cv.width=cv.height=1;cv.getContext('2d').drawImage(img,0,0,1,1);const px=cv.getContext('2d').getImageData(0,0,1,1).data;const[r,g,b]=[px[0],px[1],px[2]];d.style.setProperty('--sp-accent',`rgb(${r},${g},${b})`);d.style.setProperty('--sp-accent-a',`rgba(${r},${g},${b},0.35)`);if(bg)bg.style.background=`linear-gradient(135deg,rgba(${r},${g},${b},0.25) 0%,transparent 70%)`;}catch(_){}};img.src=meta.thumbnail_url;}
    }).catch(()=>{const aw=d.querySelector('.vsc-artwork-wrap');if(aw)aw.innerHTML='<div class="vsc-artwork-fallback">♫</div>';const tn=d.querySelector('.vsc-track-name');if(tn)tn.textContent='Spotify — '+typeLabel;});
    return d;
  }

  function injectMusicCard(from,info,url) {
    const el=getScrollEl(); if(!el) return;
    if(info.type==='spotify'){buildSpotifyCard(from,info,url).then(card=>{if(!card)return;el.appendChild(card);chatScroll();});return;}
    const safeFrom=esc(from),safeHref=safeUrl(url); if(!safeHref) return;
    const d=document.createElement('div');d.dataset.voidMusicChecked='1';
    if(info.type==='youtube'){
      d.className='msg void-music-card void-yt-card';
      const thumb=`https://img.youtube.com/vi/${esc(info.id)}/mqdefault.jpg`;
      d.innerHTML=`<div class="vyc-outer"><div class="vyc-body"><div class="vyc-thumb-wrap"><img class="vyc-thumb" src="${thumb}" alt=""><div class="vyc-play-overlay"><svg width="20" height="20" viewBox="0 0 24 24" fill="white"><polygon points="5 3 19 12 5 21 5 3"/></svg></div></div><div class="vyc-info"><div class="vyc-top"><svg width="13" height="13" viewBox="0 0 24 24" fill="#ff0000"><path d="M23 7s-.3-2-1.2-2.8c-1.1-1.2-2.4-1.2-3-1.3C16.2 2.8 12 2.8 12 2.8s-4.2 0-6.8.1c-.6.1-1.9.1-3 1.3C1.3 5 1 7 1 7S.7 9.1.7 11.2v2c0 2.1.3 4.2.3 4.2s.3 2 1.2 2.8c1.1 1.2 2.6 1.1 3.3 1.2C7.2 21.6 12 21.6 12 21.6s4.2 0 6.8-.2c.6-.1 1.9-.1 3-1.3.9-.8 1.2-2.8 1.2-2.8s.3-2.1.3-4.2v-2C23.3 9.1 23 7 23 7zM9.7 15.5V8.4l8.1 3.6-8.1 3.5z"/></svg><strong class="vyc-nick">${safeFrom}</strong><span class="vyc-badge">YouTube</span></div><div class="vyc-title">Carregando…</div><div class="vyc-channel"></div><div class="vyc-actions"><button class="vyc-play-btn"><svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>Tocar</button><a class="void-open-btn" href="${safeHref}" target="_blank" rel="noopener noreferrer"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>Abrir</a></div></div></div></div></div>`;
      d.querySelector('.vyc-play-btn').addEventListener('click',()=>{if(!document.getElementById('void-music-player'))buildMusicPlayer();addToQueue(url,from+' — YouTube');});
      el.appendChild(d);chatScroll();
      fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${info.id}&format=json`).then(r=>r.json()).then(data=>{const t=d.querySelector('.vyc-title'),ch=d.querySelector('.vyc-channel');if(t)t.textContent=data.title||'';if(ch)ch.textContent=data.author_name||'';}).catch(()=>{});
    } else {
      d.className='msg void-music-card';
      const shortUrl=safeHref.replace(/https?:\/\//,'').replace(/www\./,'');
      d.innerHTML=`<div class="vmc-body"><div class="vmc-info"><div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">${musicIcon(info.type)}<strong class="vmc-nick">${safeFrom}</strong><span class="vmc-type">SoundCloud</span></div><div class="vmc-title"></div><div class="vmc-url"><a class="vmc-link" href="${safeHref}" target="_blank" rel="noopener noreferrer">${esc(shortUrl.length>48?shortUrl.slice(0,46)+'…':shortUrl)}</a></div><button class="vmc-play-btn">▶ Tocar no player</button></div></div>`;
      d.querySelector('.vmc-play-btn').addEventListener('click',()=>{if(!document.getElementById('void-music-player'))buildMusicPlayer();addToQueue(url,from+' — SoundCloud');});
      el.appendChild(d);chatScroll();
    }
  }

  function watchMusicInChat() {
    const el=getScrollEl(); if(!el) return;
    const obs=new MutationObserver(muts=>muts.forEach(m=>m.addedNodes.forEach(node=>{
      if(node.nodeType!==1) return;
      if(node.dataset?.voidMusicChecked||node.classList?.contains('void-music-card')||node.classList?.contains('void-img-msg')||node.classList?.contains('void-code-msg')||node.classList?.contains('void-link-card')) return;
      node.dataset.voidMusicChecked='1';
      const span=node.querySelector('span'),strong=node.querySelector('strong');
      if(!span||!strong) return;
      const text=(span.textContent||'').trim(),info=detectMusicLink(text);
      if(!info) return;
      const a=document.createElement('a');a.href=safeUrl(info.url)||'#';a.target='_blank';a.rel='noopener noreferrer';a.textContent=text;
      a.style.cssText='color:#38bdf8!important;font-style:italic!important;text-decoration:underline!important;word-break:break-all!important';
      span.textContent='';span.appendChild(a);
      const key=info.url;if(processedMusicUrls.has(key))return;processedMusicUrls.add(key);
      injectMusicCard(strong.textContent.trim(),info,text);
    })));
    obs.observe(el,{childList:true});
  }

  // ── Watchers ─────────────────────────────────────────────────────────────────
  function watchIncomingMsgs() { const el=getScrollEl();if(!el)return;new MutationObserver(muts=>muts.forEach(m=>m.addedNodes.forEach(n=>n.nodeType===1&&tryConvertToCode(n)))).observe(el,{childList:true}); }
  function watchChatInput() {
    const form=document.querySelector('#chat form,#chat .form');
    if(!form||form.dataset.voidHooked) return;form.dataset.voidHooked='1';
    form.addEventListener('submit',()=>{
      const val=form.querySelector('input[name="chat"]')?.value||'';
      if(val.length>60&&CODE_RE.test(val))setTimeout(()=>{const el=getScrollEl();if(!el)return;const last=el.lastElementChild;if(last&&last.textContent.includes(val.slice(0,20)))last.replaceWith(makeCodeBlock(val,getNick(),null));},80);
    });
  }

  let enrichObserver=null;
  function watchEnrich() {
    const el=getScrollEl(); if(!el||enrichObserver) return;
    el.querySelectorAll('.msg').forEach(n=>enrichMsg(n));
    enrichObserver=new MutationObserver(muts=>muts.forEach(m=>m.addedNodes.forEach(n=>enrichMsg(n))));
    enrichObserver.observe(el,{childList:true});
  }

  function removeTabLabels() {
    document.querySelectorAll('label').forEach(lbl=>{lbl.childNodes.forEach(n=>{if(n.nodeType===3&&n.textContent.trim().toLowerCase()==='tab')n.textContent='';});lbl.querySelectorAll('.tooltip,span.tooltip').forEach(e=>e.remove());});
    document.querySelectorAll('.tooltip').forEach(e=>e.remove());
  }

  // ── CSS ──────────────────────────────────────────────────────────────────────
  const DEFAULTS={bg:'https://wallpapercave.com/wp/wp4911314.jpg',accent:'#38bdf8',accentDark:'#0369a1',bgOpacity:'0.88',imgBright:'0.30',imgSat:'0.4',imgGray:'0.6',blurStrength:'12',vignette:'rgba(0,0,20,0.55)',zoom:'0.78',borderRadius:'4',pulseSpeed:'4',fontSize:'14',avatarBorder:'2',scrollbarW:'4',showTools:'false',fontFamily:'',customFont:'',chatWidth:'65',showTyping:'true'};
  const CFG=Object.fromEntries(Object.entries(DEFAULTS).map(([k,v])=>[k,GM_getValue(k,v)]));

  function toRgb(hex) { hex=hex.replace('#','');if(hex.length===3)hex=hex.split('').map(x=>x+x).join('');return parseInt(hex.slice(0,2),16)+','+parseInt(hex.slice(2,4),16)+','+parseInt(hex.slice(4,6),16); }

  let styleEl=null,fontLink=null;

  function applyFont(c) {
    fontLink?.remove();fontLink=null;
    const picked=(c.customFont.trim()||c.fontFamily);
    const root=document.head||document.documentElement;
    let s=document.getElementById('void-font-s');
    if(!s){s=document.createElement('style');s.id='void-font-s';root.appendChild(s);}
    if(!picked){s.textContent='';return;}
    const family=picked.replace(/\+/g,' '),query=picked.replace(/\s+/g,'+');
    fontLink=Object.assign(document.createElement('link'),{rel:'stylesheet',href:`https://fonts.googleapis.com/css2?family=${query}:ital,wght@0,400;0,500;0,700;0,800;1,400&display=swap`});
    root.appendChild(fontLink);
    s.textContent=`#screenRoom,#screenRoom *,#users,#users *,#void-panel,#void-panel *{font-family:'${family}',system-ui,sans-serif!important}`;
  }

  document.addEventListener('DOMContentLoaded',()=>{const s=document.getElementById('void-font-s');if(s&&s.parentElement!==document.head)document.head.appendChild(s);if(fontLink&&fontLink.parentElement!==document.head)document.head.appendChild(fontLink);},{once:true});

  function buildCSS(c) {
    const R=toRgb(c.accent);
    const br=c.borderRadius,br2=Math.max(0,parseInt(br)-2),fs=c.fontSize,ps=c.pulseSpeed,blr=c.blurStrength,ab=c.avatarBorder,sw=c.scrollbarW;
    const chatW=parseInt(c.chatWidth),ansW=100-chatW;
    const tools=c.showTools==='true'?'unset':'none';
    const zPct=Math.round(100/parseFloat(c.zoom)),zML=Math.round((1/parseFloat(c.zoom)-1)*-50);
    const gb=`rgba(5,3,3,${c.bgOpacity})`,bdr=`rgba(${R},0.3)`;
    const gl=(extra='')=>`background:${gb}!important;backdrop-filter:blur(${blr}px)!important;border:1px solid ${bdr}!important;border-radius:${br}px!important;animation:borderPulse ${ps}s ease-in-out infinite!important;${extra}`;

    return `
:root{--void-R:${R};--void-accent:${c.accent};--void-accent-dark:${c.accentDark};--void-br:${br}px;--void-br2:${br2}px;--void-fs:${fs}px;--void-ps:${ps}s;--void-blur:${blr}px;--void-ab:${ab}px;--void-sw:${sw}px;--void-gb:${gb};--void-bdr:${bdr};--void-tools:${tools};--void-zoom:${c.zoom};--void-zPct:${zPct}%;--void-zML:${zML}%}
#screenRoom,#screenRoom *,#users,#users *,#chat *,#answer *{user-select:text!important;-webkit-user-select:text!important}
#screenRoom{transform:scale(var(--void-zoom))!important;transform-origin:top center!important;width:var(--void-zPct)!important;margin-left:var(--void-zML)!important}
#tools{display:var(--void-tools)!important}
@keyframes borderPulse{0%,100%{border-color:rgba(var(--void-R),0.3)}50%{border-color:rgba(var(--void-R),0.7)}}
@keyframes voidGlow{0%,100%{box-shadow:0 0 14px rgba(var(--void-R),0.3),0 0 0 1px rgba(var(--void-R),0.15)}50%{box-shadow:0 0 32px rgba(var(--void-R),0.6),0 0 0 1px rgba(var(--void-R),0.35)}}
#users,#users>div{${gl(`box-shadow:inset 0 0 40px rgba(${R},0.04),0 0 0 1px rgba(${R},0.08)!important`)}}
#users .scrollElements,#users .scrollElements ul,#users .scrollElements ul li,#users .scrollElements .user,#users .scrollElements .user .infosPlayer{background:transparent!important;border:none!important;box-shadow:none!important}
#users .scrollElements ul li{border-bottom:1px solid rgba(var(--void-R),0.08)!important;border-radius:var(--void-br2)!important;transition:background .15s!important}
#users .scrollElements ul li:hover{background:rgba(var(--void-R),0.07)!important}
#users .scrollElements .user canvas,#users .scrollElements .user img,#users .scrollElements ul li canvas,#users .scrollElements ul li img{border-radius:50%!important;clip-path:circle(50% at 50% 50%)!important;overflow:hidden!important;object-fit:cover!important;border:var(--void-ab) solid rgba(var(--void-R),0.55)!important;box-shadow:0 0 10px rgba(var(--void-R),0.3)!important;aspect-ratio:1/1!important}
#users .scrollElements .user>div:first-child,#users .scrollElements .user .imgPlayer,#users .scrollElements .user [class*="img"]{border-radius:50%!important;overflow:hidden!important;clip-path:circle(50% at 50% 50%)!important}
#users .scrollElements .user .infosPlayer .nick{color:#fafafa!important;font-weight:700!important;font-size:var(--void-fs)!important;text-shadow:none!important;letter-spacing:.02em!important}
#users .scrollElements .user .infosPlayer .points{color:var(--void-accent)!important;font-weight:700!important;text-shadow:none!important}
#screenRoom .ctt #interaction{min-height:700px!important;height:700px!important;background:transparent!important}
#screenRoom .ctt #interaction #chat{width:${chatW}%!important;max-width:${chatW}%!important;${gl(`box-shadow:inset 0 0 40px rgba(${R},0.03)!important;box-sizing:border-box!important`)}}
#screenRoom .ctt #interaction #answer{width:${ansW}%!important;max-width:${ansW}%!important;${gl('box-sizing:border-box!important')}}
#chat h5,#answer h5{margin:0!important;padding:6px 18px!important;border-radius:var(--void-br2)!important;font-size:11px!important;font-weight:800!important;letter-spacing:.12em!important;text-transform:uppercase!important;cursor:pointer!important;color:#fafafa!important;background:rgba(var(--void-R),0.18)!important;border:1px solid rgba(var(--void-R),0.4)!important;box-shadow:none!important;text-shadow:none!important}
#chat h5:hover,#answer h5:hover{background:rgba(var(--void-R),0.32)!important;border-color:var(--void-accent)!important}
#screenRoom .ctt #interaction #chat .history{background:transparent!important}
#screenRoom .ctt #interaction #chat .history .msg{color:#d4d4d4!important;font-size:var(--void-fs)!important;line-height:1.55!important;padding:4px 10px!important;border-radius:var(--void-br2)!important;text-shadow:none!important;transition:background .1s!important;position:relative!important}
#screenRoom .ctt #interaction #chat .history .msg:hover{background:rgba(var(--void-R),0.04)!important}
#screenRoom .ctt #interaction #chat .history .msg span{color:#e5e5e5!important;text-shadow:none!important}
#screenRoom .ctt #interaction #chat .history .msg strong{color:var(--void-accent)!important;font-weight:700!important;text-shadow:none!important}
#screenRoom .ctt #interaction #chat .history .msg.correct,#screenRoom .ctt #interaction #chat .history .msg[class*="correct"],#screenRoom .ctt #interaction #answer .msg[class*="correct"]{background:rgba(var(--void-R),0.08)!important;border-left:3px solid var(--void-accent)!important;color:var(--void-accent)!important}
#screenRoom .ctt #interaction #chat .history .msg{--av:38px}
#screenRoom .ctt #interaction #chat .history .msg .avatar{display:block!important;width:var(--av)!important;height:var(--av)!important;min-width:var(--av)!important;flex-shrink:0!important;border-radius:50%!important;overflow:hidden!important;border:1.5px solid rgba(var(--void-R),0.45)!important;box-shadow:0 0 6px rgba(var(--void-R),0.25)!important;background-size:contain!important;margin-top:2px!important}
#screenRoom .ctt #interaction #chat .history .msg:has(.avatar){display:flex!important;align-items:flex-start!important;gap:7px!important}
.void-mention{color:#a78bfa!important;font-weight:700!important;border-radius:3px!important;padding:0 2px!important}
.void-mention-me{background:rgba(167,139,250,0.18)!important;color:#c4b5fd!important}
.void-msg-mentioned{background:rgba(167,139,250,0.07)!important;border-left:3px solid #a78bfa!important;padding-left:7px!important}
.void-link{color:#38bdf8!important;text-decoration:underline!important;word-break:break-all!important;cursor:pointer!important}
.void-link:hover{color:#7dd3fc!important}
.void-link-card{margin:4px 10px 6px!important;background:transparent!important}
.vlc-inner{display:flex!important;flex-direction:column!important;background:rgba(0,0,0,.32)!important;border:1px solid rgba(var(--void-R),0.18)!important;border-left:4px solid rgba(var(--void-R),0.6)!important;border-radius:6px!important;overflow:hidden!important;text-decoration:none!important;max-width:380px!important}
.vlc-inner:hover{background:rgba(var(--void-R),0.06)!important}
.vlc-info{padding:10px 14px 8px!important;display:flex!important;flex-direction:column!important;gap:4px!important}
.vlc-img-wrap{width:100%!important}.vlc-img{width:100%!important;max-height:200px!important;object-fit:cover!important;display:block!important}
.vlc-site{font-size:10px!important;font-weight:700!important;letter-spacing:.06em!important;text-transform:uppercase!important;color:rgba(255,255,255,.35)!important}
.vlc-title{font-size:13px!important;font-weight:600!important;color:#38bdf8!important;white-space:nowrap!important;overflow:hidden!important;text-overflow:ellipsis!important}
.vlc-desc{font-size:11px!important;color:rgba(255,255,255,.5)!important;line-height:1.45!important;display:-webkit-box!important;-webkit-line-clamp:2!important;-webkit-box-orient:vertical!important;overflow:hidden!important}
.void-react-add-btn{display:none!important;position:absolute!important;right:6px!important;top:50%!important;transform:translateY(-50%)!important;background:rgba(20,15,35,0.95)!important;border:1px solid rgba(255,255,255,.15)!important;border-radius:8px!important;color:rgba(255,255,255,.6)!important;cursor:pointer!important;padding:4px 7px!important;align-items:center!important;gap:2px!important;z-index:100!important}
.void-react-add-btn:hover{background:rgba(var(--void-R),0.28)!important;color:#fff!important;border-color:rgba(var(--void-R),0.5)!important}
#screenRoom .ctt #interaction #chat .history .msg:hover .void-react-add-btn{display:inline-flex!important}
.void-react-picker{position:absolute!important;right:6px!important;top:-44px!important;background:rgba(15,12,28,0.98)!important;border:1px solid rgba(255,255,255,.12)!important;border-radius:22px!important;padding:5px 8px!important;display:flex!important;gap:1px!important;z-index:9999!important;opacity:0!important;pointer-events:none!important;transition:opacity .15s,transform .15s!important;transform:translateY(8px) scale(0.92)!important;white-space:nowrap!important;box-shadow:0 6px 28px rgba(0,0,0,.75)!important}
.void-react-picker.visible{opacity:1!important;pointer-events:all!important;transform:translateY(0) scale(1)!important}
.void-react-opt{background:none!important;border:none!important;cursor:pointer!important;font-size:18px!important;padding:3px 5px!important;border-radius:8px!important;transition:background .1s,transform .13s!important}
.void-react-opt:hover{background:rgba(255,255,255,.12)!important;transform:scale(1.35)!important}
.void-reaction-bar{display:flex!important;flex-wrap:wrap!important;gap:4px!important;margin-top:5px!important}
.void-react-pill{background:rgba(255,255,255,.07)!important;border:1px solid rgba(255,255,255,.12)!important;border-radius:12px!important;color:#fafafa!important;cursor:pointer!important;font-size:13px!important;padding:2px 9px!important;display:inline-flex!important;align-items:center!important;gap:5px!important}
.void-react-pill:hover{background:rgba(var(--void-R),0.2)!important;border-color:rgba(var(--void-R),0.45)!important}
.void-react-pill span{font-size:11px!important;color:rgba(255,255,255,.55)!important}
.void-img-msg{padding:4px 10px!important;background:transparent!important}
.void-img-msg strong{color:#a78bfa!important;font-size:13px!important;font-weight:700!important}
.void-media-img{max-width:200px!important;max-height:200px!important;border-radius:6px!important;display:block!important;cursor:pointer!important;object-fit:cover!important;margin-top:4px!important}
.void-media-video{max-width:260px!important;max-height:180px!important;border-radius:6px!important;display:block!important;margin-top:4px!important;background:#000!important}
.void-media-audio{width:220px!important;display:block!important;margin-top:6px!important;border-radius:20px!important}
.void-code-msg{padding:2px 6px 5px!important;background:transparent!important;min-width:0!important}
.vcb-wrap{border-radius:8px!important;overflow:hidden!important;border:1px solid rgba(var(--void-R),0.2)!important;margin-top:2px!important;max-width:100%!important}
.vcb-header{display:flex!important;align-items:center!important;justify-content:space-between!important;background:rgba(255,255,255,0.04)!important;padding:5px 8px!important;gap:6px!important;border-bottom:1px solid rgba(var(--void-R),0.12)!important}
.vcb-meta{display:flex!important;align-items:center!important;gap:5px!important;flex:1!important;overflow:hidden!important}
.vcb-icon{display:flex!important;align-items:center!important;color:rgba(var(--void-R),0.6)!important;flex-shrink:0!important}
.vcb-nick{color:var(--void-accent)!important;font-weight:700!important;font-size:11px!important;white-space:nowrap!important;flex-shrink:0!important}
.vcb-filename{color:rgba(255,255,255,.6)!important;font-size:10px!important;white-space:nowrap!important;overflow:hidden!important;text-overflow:ellipsis!important;max-width:120px!important}
.vcb-badge{font-size:8px!important;font-weight:700!important;letter-spacing:.08em!important;text-transform:uppercase!important;color:var(--void-accent)!important;background:rgba(var(--void-R),0.1)!important;border:1px solid rgba(var(--void-R),0.25)!important;border-radius:3px!important;padding:1px 4px!important;flex-shrink:0!important}
.vcb-lines{font-size:9px!important;color:rgba(255,255,255,.2)!important;white-space:nowrap!important;flex-shrink:0!important}
.vcb-actions{display:flex!important;gap:4px!important;flex-shrink:0!important}
.vcb-btn{display:flex!important;align-items:center!important;gap:3px!important;background:rgba(255,255,255,.05)!important;border:1px solid rgba(255,255,255,.08)!important;border-radius:4px!important;color:rgba(255,255,255,.4)!important;cursor:pointer!important;font-size:9px!important;padding:2px 7px!important}
.vcb-btn:hover{background:rgba(var(--void-R),0.15)!important;color:#fff!important;border-color:rgba(var(--void-R),0.35)!important}
.vcb-body{background:rgba(0,0,0,.55)!important;overflow:auto!important;max-height:140px!important}
.vcb-body pre{margin:0!important;padding:8px 10px!important;font-family:'JetBrains Mono','Fira Code','Courier New',monospace!important;font-size:10.5px!important;line-height:1.65!important;color:#abb2bf!important;white-space:pre!important;tab-size:2!important}
.vcb-body::-webkit-scrollbar{width:3px!important;height:3px!important}
.vcb-body::-webkit-scrollbar-thumb{background:rgba(var(--void-R),0.25)!important;border-radius:2px!important}
#chat label .tooltip,#answer label .tooltip,label .tooltip,label span.tooltip,.tooltip{display:none!important;visibility:hidden!important;opacity:0!important;pointer-events:none!important}
#void-img-btn{position:absolute!important;right:34px!important;top:50%!important;transform:translateY(-50%)!important;background:#7c3aed!important;color:#fff!important;border:none!important;border-radius:50%!important;width:26px!important;height:26px!important;font-size:18px!important;cursor:pointer!important;z-index:9999!important;display:flex!important;align-items:center!important;justify-content:center!important;padding:0!important}
#void-img-btn:hover{background:#6d28d9!important;transform:translateY(-50%) scale(1.12)!important}
#void-emoji-btn{position:absolute!important;right:4px!important;top:50%!important;transform:translateY(-50%)!important;background:rgba(255,255,255,0.07)!important;color:rgba(255,255,255,0.55)!important;border:none!important;border-radius:50%!important;width:26px!important;height:26px!important;cursor:pointer!important;z-index:9999!important;display:flex!important;align-items:center!important;justify-content:center!important;padding:0!important}
#void-emoji-btn:hover{background:rgba(255,200,0,0.16)!important;color:#fbbf24!important;transform:translateY(-50%) scale(1.12)!important}
#void-emoji-picker{position:fixed!important;z-index:9999999!important;width:330px!important;background:rgba(10,8,20,0.99)!important;border:1px solid rgba(255,255,255,0.09)!important;border-radius:12px!important;box-shadow:0 20px 60px rgba(0,0,0,0.9)!important;overflow:hidden!important;display:none!important;flex-direction:column!important}
#void-emoji-picker.visible{display:flex!important}
.vep-tabs{display:flex!important;padding:0!important;border-bottom:1px solid rgba(255,255,255,0.07)!important;overflow-x:auto!important;scrollbar-width:none!important}
.vep-tabs::-webkit-scrollbar{display:none!important}
.vep-tab{background:none!important;border:none!important;border-bottom:2px solid transparent!important;border-radius:0!important;cursor:pointer!important;color:rgba(255,255,255,0.35)!important;font-size:15px!important;padding:7px 8px!important;margin-bottom:-1px!important}
.vep-tab:hover{opacity:.8!important}
.vep-tab.vep-tab-active{opacity:1!important;border-bottom-color:rgba(255,255,255,0.6)!important;filter:drop-shadow(0 0 4px rgba(255,255,255,0.3))!important}
.vep-body{padding:8px!important;display:flex!important;flex-direction:column!important;gap:6px!important}
.vep-search{background:rgba(255,255,255,0.04)!important;border:1px solid rgba(255,255,255,0.08)!important;border-radius:7px!important;color:#fff!important;font-size:11px!important;outline:none!important;padding:6px 10px!important;width:100%!important;box-sizing:border-box!important}
.vep-search::placeholder{color:rgba(255,255,255,0.2)!important}
.vep-grid{display:grid!important;grid-template-columns:repeat(8,1fr)!important;gap:1px!important;max-height:200px!important;overflow-y:auto!important;scrollbar-width:thin!important}
.vep-grid::-webkit-scrollbar{width:3px!important}
.vep-grid::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.12)!important;border-radius:2px!important}
.vep-emoji{background:none!important;border:none!important;border-radius:5px!important;cursor:pointer!important;font-size:21px!important;padding:4px 2px!important;text-align:center!important;transition:background .08s,transform .08s!important}
.vep-emoji:hover{background:rgba(255,255,255,0.09)!important;transform:scale(1.28)!important}
.vep-empty{grid-column:1/-1!important;text-align:center!important;color:rgba(255,255,255,0.25)!important;font-size:11px!important;padding:16px 0!important}

/* ── TYPING INDICATOR ─────────────────────────────────────────────────── */
#void-typing-bar{
  display:none!important;
  align-items:center!important;
  gap:7px!important;
  padding:5px 10px 4px!important;
  background:rgba(6,5,14,0.82)!important;
  backdrop-filter:blur(8px)!important;
  border:1px solid rgba(var(--void-R),0.14)!important;
  border-radius:8px 8px 0 0!important;
  border-bottom:none!important;
  margin:0 2px!important;
  min-height:24px!important;
  pointer-events:none!important;
  animation:vtbFadeIn .18s ease forwards!important;
}
@keyframes vtbFadeIn{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}
.vtb-dots{display:flex!important;align-items:center!important;gap:3px!important;flex-shrink:0!important}
.vtb-dots span{
  display:inline-block!important;
  width:5px!important;height:5px!important;
  border-radius:50%!important;
  background:rgba(var(--void-R),0.7)!important;
  animation:vtbBounce 1.2s ease-in-out infinite!important;
}
.vtb-dots span:nth-child(2){animation-delay:.2s!important}
.vtb-dots span:nth-child(3){animation-delay:.4s!important}
@keyframes vtbBounce{0%,60%,100%{transform:translateY(0);opacity:.4}30%{transform:translateY(-4px);opacity:1}}
.vtb-text{font-size:10px!important;color:rgba(255,255,255,.38)!important;font-weight:500!important;white-space:nowrap!important;overflow:hidden!important;text-overflow:ellipsis!important;max-width:220px!important}
.vtb-name{color:var(--void-accent)!important;font-weight:700!important}
.vtb-many{color:rgba(255,255,255,.35)!important;font-style:italic!important}

#void-music-btn{position:fixed!important;bottom:68px!important;right:16px!important;z-index:999997!important;width:40px!important;height:40px!important;border-radius:50%!important;background:rgba(6,6,10,.93)!important;border:1.5px solid rgba(var(--void-R),0.45)!important;cursor:pointer!important;display:flex!important;align-items:center!important;justify-content:center!important;color:rgba(255,255,255,.7)!important;box-shadow:0 0 14px rgba(var(--void-R),0.2)!important}
#void-music-btn:hover{transform:scale(1.1)!important;border-color:var(--void-accent)!important;color:#fff!important}
#void-music-player{position:fixed!important;bottom:120px!important;right:16px!important;width:340px!important;z-index:999996!important;border-radius:10px!important;overflow:hidden!important;box-shadow:0 8px 40px rgba(0,0,0,.75),0 0 0 1px rgba(var(--void-R),0.25)!important;background:rgba(8,6,14,.97)!important;user-select:none!important}
#void-music-bar{display:flex!important;align-items:center!important;justify-content:space-between!important;padding:9px 11px!important;background:rgba(var(--void-R),0.1)!important;border-bottom:1px solid rgba(var(--void-R),0.15)!important;cursor:grab!important}
#void-music-bar:active{cursor:grabbing!important}
#void-music-bar-left{display:flex!important;align-items:center!important;gap:7px!important;color:rgba(255,255,255,.85)!important;font-size:11px!important;font-weight:700!important;letter-spacing:.1em!important;text-transform:uppercase!important}
#void-music-bar button{background:rgba(255,255,255,.08)!important;border:none!important;color:rgba(255,255,255,.45)!important;width:20px!important;height:20px!important;border-radius:4px!important;cursor:pointer!important;font-size:11px!important;display:flex!important;align-items:center!important;justify-content:center!important;padding:0!important}
#void-music-bar button:hover{background:rgba(255,255,255,.18)!important;color:#fff!important}
#void-music-body{display:block!important}
#void-music-iframe-wrap{background:#000!important;width:100%!important;aspect-ratio:16/9!important;overflow:hidden!important;position:relative!important}
#void-music-iframe{position:absolute!important;inset:0!important;width:100%!important;height:100%!important;border:none!important;display:block!important}
#void-music-queue-wrap{padding:4px 0!important;max-height:110px!important;overflow-y:auto!important;scrollbar-width:thin!important}
.vm-section-title{font-size:8px!important;font-weight:700!important;letter-spacing:.14em!important;text-transform:uppercase!important;color:rgba(255,255,255,.2)!important;padding:4px 10px 2px!important}
#void-music-queue{padding:0 6px!important}
.vmq-empty{font-size:10px!important;color:rgba(255,255,255,.2)!important;text-align:center!important;padding:10px!important}
.vmq-item{display:flex!important;align-items:center!important;gap:6px!important;padding:5px 6px!important;border-radius:5px!important;cursor:pointer!important;transition:background .12s!important}
.vmq-item:hover{background:rgba(var(--void-R),0.1)!important}
.vmq-active{background:rgba(var(--void-R),0.15)!important;border-left:2px solid var(--void-accent)!important}
.vmq-ico{display:flex!important;align-items:center!important;flex-shrink:0!important}
.vmq-label{flex:1!important;font-size:10px!important;color:rgba(255,255,255,.6)!important;white-space:nowrap!important;overflow:hidden!important;text-overflow:ellipsis!important}
.vmq-del{background:none!important;border:none!important;color:rgba(255,255,255,.2)!important;cursor:pointer!important;font-size:10px!important;padding:0 2px!important}
.vmq-del:hover{color:#f87171!important}
#void-music-input-row{display:flex!important;gap:5px!important;padding:7px 8px!important;border-top:1px solid rgba(255,255,255,.04)!important}
#void-music-input{flex:1!important;background:rgba(255,255,255,.04)!important;border:1px solid rgba(var(--void-R),0.2)!important;border-radius:5px!important;color:#fafafa!important;font-size:10px!important;padding:5px 8px!important;outline:none!important;min-width:0!important}
#void-music-input::placeholder{color:rgba(255,255,255,.2)!important}
#void-music-input:focus{border-color:rgba(var(--void-R),0.5)!important}
#void-music-add{background:rgba(var(--void-R),0.2)!important;border:1px solid rgba(var(--void-R),0.35)!important;border-radius:5px!important;color:var(--void-accent)!important;cursor:pointer!important;font-size:14px!important;padding:0 10px!important}
#void-music-add:hover{background:rgba(var(--void-R),0.35)!important}
.void-music-card{padding:6px 6px 10px!important;background:transparent!important}
.vmc-body{display:flex!important;gap:14px!important;align-items:flex-start!important;background:rgba(0,0,0,.32)!important;border:1px solid rgba(var(--void-R),0.25)!important;border-radius:10px!important;padding:14px!important;width:100%!important;box-sizing:border-box!important}
.vmc-nick{color:var(--void-accent)!important;font-weight:700!important;font-size:14px!important}
.vmc-type{font-size:10px!important;font-weight:700!important;letter-spacing:.08em!important;text-transform:uppercase!important;color:rgba(255,255,255,.35)!important;background:rgba(255,255,255,.07)!important;border-radius:3px!important;padding:2px 6px!important}
.vmc-title{font-size:13px!important;font-weight:600!important;color:rgba(255,255,255,.9)!important;white-space:nowrap!important;overflow:hidden!important;text-overflow:ellipsis!important}
.vmc-url{font-size:11px!important;color:rgba(255,255,255,.4)!important;white-space:nowrap!important;overflow:hidden!important;text-overflow:ellipsis!important}
.vmc-link{color:#38bdf8!important;text-decoration:none!important}
.vmc-link:hover{text-decoration:underline!important}
.vmc-play-btn{align-self:flex-start!important;background:rgba(var(--void-R),0.18)!important;border:1px solid rgba(var(--void-R),0.35)!important;border-radius:6px!important;color:var(--void-accent)!important;cursor:pointer!important;font-size:12px!important;font-weight:700!important;padding:7px 16px!important;margin-top:3px!important}
.vmc-play-btn:hover{background:rgba(var(--void-R),0.35)!important}
.void-spotify-card{padding:4px 4px 6px!important;background:transparent!important}
.vsc-outer{--sp-accent:#1db954;background:rgba(10,8,18,0.92)!important;border:1px solid rgba(255,255,255,0.08)!important;border-radius:14px!important;overflow:hidden!important;margin-top:4px!important;box-sizing:border-box!important;position:relative!important}
.vsc-outer:hover{border-color:rgba(29,185,84,0.4)!important;box-shadow:0 8px 32px rgba(0,0,0,0.6)!important}
.vsc-bg-blur{position:absolute!important;inset:0!important;pointer-events:none!important;z-index:0!important;border-radius:14px!important}
.vsc-content{display:flex!important;position:relative!important;z-index:1!important}
.vsc-artwork-wrap{width:90px!important;height:90px!important;flex-shrink:0!important;overflow:hidden!important;background:rgba(255,255,255,0.05)!important;position:relative!important}
.vsc-artwork{width:100%!important;height:100%!important;object-fit:cover!important;display:block!important;transition:transform .3s!important}
.vsc-outer:hover .vsc-artwork{transform:scale(1.06)!important}
.vsc-artwork-loading{width:100%!important;height:100%!important;display:flex!important;align-items:center!important;justify-content:center!important;background:rgba(29,185,84,0.06)!important}
.vsc-spinner{width:18px!important;height:18px!important;border:2px solid rgba(29,185,84,0.2)!important;border-top-color:#1db954!important;border-radius:50%!important;animation:vscSpin .7s linear infinite!important}
@keyframes vscSpin{to{transform:rotate(360deg)}}
.vsc-artwork-fallback{width:100%!important;height:100%!important;display:flex!important;align-items:center!important;justify-content:center!important;font-size:32px!important;background:linear-gradient(135deg,#0d1f14,#0a1a10)!important;color:rgba(29,185,84,0.5)!important}
.vsc-right{flex:1!important;min-width:0!important;display:flex!important;flex-direction:column!important;padding:10px 12px!important;gap:2px!important}
.vsc-header{display:flex!important;align-items:center!important;gap:6px!important;margin-bottom:4px!important}
.vsc-nick{color:#1db954!important;font-weight:700!important;font-size:11px!important}
.vsc-type-badge{font-size:8px!important;font-weight:700!important;letter-spacing:.1em!important;text-transform:uppercase!important;background:rgba(29,185,84,0.15)!important;color:#1db954!important;border:1px solid rgba(29,185,84,0.3)!important;border-radius:3px!important;padding:1px 5px!important}
.vsc-track-name{font-size:13px!important;font-weight:700!important;color:#fff!important;white-space:nowrap!important;overflow:hidden!important;text-overflow:ellipsis!important}
.vsc-artist-name{font-size:11px!important;color:rgba(255,255,255,0.45)!important;white-space:nowrap!important;overflow:hidden!important;text-overflow:ellipsis!important}
.vsc-url-row{font-size:9px!important;color:rgba(255,255,255,0.2)!important;white-space:nowrap!important;overflow:hidden!important;text-overflow:ellipsis!important;margin-top:2px!important}
.vsc-link{color:rgba(29,185,84,0.5)!important;text-decoration:none!important}
.vsc-link:hover{color:#1db954!important;text-decoration:underline!important}
.vsc-actions{display:flex!important;gap:5px!important;margin-top:6px!important}
.vsc-play-btn{display:flex!important;align-items:center!important;gap:4px!important;background:#1db954!important;border:none!important;border-radius:20px!important;color:#000!important;cursor:pointer!important;font-size:10px!important;font-weight:800!important;padding:5px 12px!important;box-shadow:0 2px 10px rgba(29,185,84,0.35)!important}
.vsc-play-btn:hover{background:#23d460!important;transform:scale(1.04)!important;box-shadow:0 4px 16px rgba(29,185,84,0.55)!important}
.void-open-btn{display:flex!important;align-items:center!important;gap:4px!important;background:rgba(255,255,255,0.05)!important;border:1px solid rgba(255,255,255,0.09)!important;border-radius:20px!important;color:rgba(255,255,255,0.45)!important;cursor:pointer!important;font-size:10px!important;font-weight:600!important;padding:5px 11px!important;text-decoration:none!important}
.void-open-btn:hover{background:rgba(255,255,255,0.1)!important;color:#fff!important;border-color:rgba(255,255,255,0.2)!important}
.void-yt-card{padding:6px 6px 8px!important;background:transparent!important}
.vyc-outer{background:rgba(0,0,0,0.38)!important;border:1px solid rgba(255,255,255,0.07)!important;border-radius:12px!important;overflow:hidden!important;margin-top:4px!important;position:relative!important}
.vyc-outer::before{content:''!important;position:absolute!important;inset:0!important;border-radius:12px!important;background:radial-gradient(ellipse at top left,rgba(255,0,0,0.1) 0%,transparent 65%)!important;pointer-events:none!important;z-index:0!important}
.vyc-outer:hover{border-color:rgba(255,0,0,0.3)!important}
.vyc-body{display:flex!important;gap:12px!important;align-items:center!important;padding:10px 14px 12px!important;position:relative!important;z-index:1!important}
.vyc-thumb-wrap{width:96px!important;height:54px!important;flex-shrink:0!important;border-radius:6px!important;overflow:hidden!important;background:#000!important;position:relative!important;box-shadow:0 4px 16px rgba(0,0,0,0.5)!important}
.vyc-thumb{width:100%!important;height:100%!important;object-fit:cover!important;display:block!important;transition:transform .2s,filter .2s!important;filter:brightness(0.85)!important}
.vyc-outer:hover .vyc-thumb{transform:scale(1.05)!important;filter:brightness(1)!important}
.vyc-play-overlay{position:absolute!important;inset:0!important;display:flex!important;align-items:center!important;justify-content:center!important;background:rgba(0,0,0,0.3)!important;opacity:0!important;transition:opacity .2s!important}
.vyc-outer:hover .vyc-play-overlay{opacity:1!important}
.vyc-info{flex:1!important;min-width:0!important;display:flex!important;flex-direction:column!important;gap:3px!important}
.vyc-top{display:flex!important;align-items:center!important;gap:6px!important}
.vyc-nick{color:#f97171!important;font-weight:700!important;font-size:12px!important}
.vyc-badge{font-size:9px!important;font-weight:700!important;letter-spacing:.1em!important;text-transform:uppercase!important;background:rgba(255,0,0,0.15)!important;color:#ff4444!important;border:1px solid rgba(255,0,0,0.3)!important;border-radius:3px!important;padding:1px 5px!important}
.vyc-title{font-size:12px!important;font-weight:700!important;color:#fff!important;line-height:1.35!important;display:-webkit-box!important;-webkit-line-clamp:2!important;-webkit-box-orient:vertical!important;overflow:hidden!important}
.vyc-channel{font-size:10px!important;color:rgba(255,255,255,0.4)!important;white-space:nowrap!important;overflow:hidden!important;text-overflow:ellipsis!important}
.vyc-actions{display:flex!important;gap:5px!important;margin-top:4px!important}
.vyc-play-btn{display:flex!important;align-items:center!important;gap:4px!important;background:#ff0000!important;border:none!important;border-radius:20px!important;color:#fff!important;cursor:pointer!important;font-size:10px!important;font-weight:800!important;padding:5px 12px!important;box-shadow:0 2px 10px rgba(255,0,0,0.35)!important}
.vyc-play-btn:hover{background:#ff2222!important;transform:scale(1.04)!important}
#screenRoom .ctt #interaction #answer form,#screenRoom .ctt #interaction #answer form div{background:transparent!important}
#screenRoom .ctt #interaction #answer .msg{color:#d4d4d4!important;font-size:var(--void-fs)!important;line-height:1.55!important;text-shadow:none!important}
#screenRoom .ctt #interaction #answer .msg strong{color:var(--void-accent)!important;font-weight:700!important}
#answer form div input,#chat input{background:rgba(255,255,255,.04)!important;color:#fafafa!important;border:1px solid rgba(var(--void-R),0.3)!important;border-radius:var(--void-br2)!important;outline:none!important;font-size:var(--void-fs)!important}
#answer form div input::placeholder,#chat input::placeholder{color:rgba(255,255,255,.25)!important}
#answer form div input:focus,#chat input:focus{border-color:var(--void-accent)!important;box-shadow:0 0 0 2px rgba(var(--void-R),0.15)!important}
#chat ::-webkit-scrollbar,#answer ::-webkit-scrollbar{width:var(--void-sw)!important}
#chat ::-webkit-scrollbar-track,#answer ::-webkit-scrollbar-track{background:transparent!important}
#chat ::-webkit-scrollbar-thumb,#answer ::-webkit-scrollbar-thumb{background:rgba(var(--void-R),0.4)!important;border-radius:2px!important}
#time{background:rgba(255,255,255,.05)!important;border-radius:2px!important;overflow:hidden!important}
#time>div{background:transparent!important}
#time>div>div:first-child{background:linear-gradient(90deg,var(--void-accent-dark),var(--void-accent))!important;border-radius:2px!important;height:100%!important;box-shadow:0 0 8px rgba(var(--void-R),0.5)!important}
#void-toggle{position:fixed!important;bottom:16px!important;right:16px!important;z-index:999998!important;width:44px!important;height:44px!important;border-radius:50%!important;background:rgba(6,6,10,.93)!important;border:1.5px solid rgba(var(--void-R),0.5)!important;cursor:pointer!important;display:flex!important;align-items:center!important;justify-content:center!important;animation:voidGlow var(--void-ps) ease-in-out infinite!important}
#void-toggle:hover{transform:scale(1.12) rotate(-8deg)!important}
#void-panel{position:fixed!important;top:50%!important;left:50%!important;transform:translate(-50%,-50%)!important;z-index:999999!important;background:rgba(6,6,10,.97)!important;border:1px solid rgba(var(--void-R),0.3)!important;border-radius:10px!important;width:420px!important;max-height:86vh!important;display:none;flex-direction:column!important;overflow:hidden!important;box-shadow:0 0 60px rgba(var(--void-R),0.12),0 24px 80px rgba(0,0,0,.9)!important;color:#fafafa!important}
#void-panel.open{display:flex!important}
#void-panel-header{padding:16px 20px 13px!important;border-bottom:1px solid rgba(var(--void-R),0.13)!important;display:flex!important;align-items:center!important;justify-content:space-between!important}
#void-panel-header h2{margin:0!important;font-size:11px!important;font-weight:800!important;letter-spacing:.18em!important;text-transform:uppercase!important;color:var(--void-accent)!important}
#void-close-btn{cursor:pointer!important;font-size:16px!important;color:rgba(255,255,255,.3)!important;background:none!important;border:none!important;padding:0!important}
#void-close-btn:hover{color:#fff!important}
#void-tabs{display:flex!important;border-bottom:1px solid rgba(var(--void-R),0.1)!important;padding:0 20px!important;overflow-x:auto!important;scrollbar-width:none!important}
#void-tabs::-webkit-scrollbar{display:none!important}
#void-tabs button{background:none!important;border:none!important;border-bottom:2px solid transparent!important;color:rgba(255,255,255,.35)!important;cursor:pointer!important;font-size:9px!important;font-weight:700!important;letter-spacing:.12em!important;text-transform:uppercase!important;padding:9px 10px!important;margin-bottom:-1px!important;white-space:nowrap!important}
#void-tabs button.vtab-active{color:var(--void-accent)!important;border-bottom-color:var(--void-accent)!important}
#void-tabs button:hover{color:#fff!important}
#void-body{overflow-y:auto!important;flex:1!important;padding:16px 20px!important;scrollbar-width:none!important}
#void-body::-webkit-scrollbar{display:none!important}
.vpane{display:none!important}.vpane.vpane-active{display:block!important}
.vsec-title{font-size:9px!important;font-weight:700!important;letter-spacing:.14em!important;text-transform:uppercase!important;color:rgba(255,255,255,.25)!important;margin:16px 0 8px!important;padding-bottom:5px!important;border-bottom:1px solid rgba(255,255,255,.04)!important}
.vsec-title:first-child{margin-top:0!important}
#void-panel label{display:flex!important;justify-content:space-between!important;align-items:center!important;font-size:11px!important;font-weight:500!important;color:rgba(255,255,255,.55)!important;margin:10px 0 4px!important}
#void-panel label .vval{color:var(--void-accent)!important;font-weight:700!important;font-size:11px!important}
#void-panel input[type="text"],#void-panel select{width:100%!important;box-sizing:border-box!important;background:rgba(255,255,255,.04)!important;border:1px solid rgba(var(--void-R),0.18)!important;border-radius:5px!important;color:#fafafa!important;font-size:12px!important;padding:7px 10px!important;outline:none!important}
#void-panel select option{background:#0a0a12!important;color:#fafafa!important}
#void-panel input[type="text"]:focus,#void-panel select:focus{border-color:rgba(var(--void-R),0.5)!important}
#void-panel input[type="color"]{width:100%!important;height:34px!important;border-radius:5px!important;border:1px solid rgba(var(--void-R),0.18)!important;background:none!important;cursor:pointer!important;padding:2px!important}
#void-panel input[type="range"]{width:100%!important;accent-color:var(--void-accent)!important;cursor:pointer!important;margin:2px 0!important}
#void-panel input[type="checkbox"]{accent-color:var(--void-accent)!important;cursor:pointer!important;width:13px!important;height:13px!important}
.vrow{display:flex!important;gap:10px!important}.vrow>div{flex:1!important}
.vcheck-row{display:flex!important;align-items:center!important;gap:8px!important;padding:8px 10px!important;background:rgba(255,255,255,.03)!important;border:1px solid rgba(var(--void-R),0.1)!important;border-radius:5px!important;cursor:pointer!important;font-size:11px!important;color:rgba(255,255,255,.55)!important;margin-top:8px!important}
.vcheck-row:hover{background:rgba(var(--void-R),0.07)!important}
#void-live-badge{font-size:9px!important;font-weight:700!important;letter-spacing:.1em!important;text-transform:uppercase!important;color:var(--void-accent)!important;background:rgba(var(--void-R),0.12)!important;border:1px solid rgba(var(--void-R),0.3)!important;border-radius:3px!important;padding:2px 6px!important}
#void-font-preview{margin-top:8px!important;padding:10px 14px!important;background:rgba(255,255,255,.03)!important;border:1px solid rgba(var(--void-R),0.15)!important;border-radius:5px!important;font-size:14px!important;color:rgba(255,255,255,.7)!important;text-align:center!important;min-height:36px!important;display:flex!important;align-items:center!important;justify-content:center!important}
#void-ratio-preview{margin-top:10px!important;height:28px!important;border-radius:5px!important;overflow:hidden!important;display:flex!important;border:1px solid rgba(var(--void-R),0.2)!important}
#void-ratio-chat{background:rgba(var(--void-R),0.25)!important;display:flex!important;align-items:center!important;justify-content:center!important;font-size:9px!important;font-weight:700!important;color:var(--void-accent)!important;letter-spacing:.08em!important}
#void-ratio-answer{background:rgba(255,255,255,.05)!important;display:flex!important;align-items:center!important;justify-content:center!important;font-size:9px!important;font-weight:700!important;color:rgba(255,255,255,.3)!important;letter-spacing:.08em!important}
#void-footer{padding:11px 20px!important;border-top:1px solid rgba(var(--void-R),0.1)!important;display:flex!important;gap:8px!important}
#void-footer button{flex:1!important;padding:9px!important;border-radius:6px!important;font-size:10px!important;font-weight:800!important;letter-spacing:.1em!important;text-transform:uppercase!important;cursor:pointer!important;border:none!important}
#void-footer button:hover{opacity:.78!important;transform:translateY(-1px)!important}
#void-btn-apply{background:var(--void-accent)!important;color:#000!important;flex:2!important}
#void-btn-reset{background:rgba(255,255,255,.06)!important;color:rgba(255,255,255,.55)!important}
`;
  }

  const TOKEN_CSS=`
#screenRoom .ctt #interaction #chat .history .vcb-body pre span.vck{color:#c792ea!important;font-weight:700!important}
#screenRoom .ctt #interaction #chat .history .vcb-body pre span.vkc{color:#f97583!important;font-weight:600!important}
#screenRoom .ctt #interaction #chat .history .vcb-body pre span.vcs{color:#c3e88d!important}
#screenRoom .ctt #interaction #chat .history .vcb-body pre span.vctem{color:#addb67!important}
#screenRoom .ctt #interaction #chat .history .vcb-body pre span.vcc{color:#637777!important;font-style:italic!important}
#screenRoom .ctt #interaction #chat .history .vcb-body pre span.vcn{color:#f78c6c!important}
#screenRoom .ctt #interaction #chat .history .vcb-body pre span.vcf{color:#82aaff!important;font-weight:500!important}
#screenRoom .ctt #interaction #chat .history .vcb-body pre span.vctype{color:#ffcb6b!important}
#screenRoom .ctt #interaction #chat .history .vcb-body pre span.vcbi{color:#80cbc4!important}
#screenRoom .ctt #interaction #chat .history .vcb-body pre span.vco{color:#89ddff!important}
#screenRoom .ctt #interaction #chat .history .vcb-body pre span.vct{color:#f07178!important;font-weight:600!important}
#screenRoom .ctt #interaction #chat .history .vcb-body pre span.vca{color:#ffcb6b!important}
#screenRoom .ctt #interaction #chat .history .vcb-body pre span.vcprop{color:#80cbc4!important}
#screenRoom .ctt #interaction #chat .history .vcb-body pre span.vcvar{color:#c792ea!important}
#screenRoom .ctt #interaction #chat .history .vcb-body pre span.vcdec{color:#ff9cac!important;font-style:italic!important}
#screenRoom .ctt #interaction #chat .history .vcb-body pre span.vcmacro{color:#ff5572!important;font-weight:700!important}
`;

  function applyCSS(c) {
    if(!styleEl){styleEl=document.createElement('style');styleEl.id='void-css';(document.head||document.documentElement).appendChild(styleEl);}
    styleEl.textContent=buildCSS(c);
    let tokenEl=document.getElementById('void-token-css');
    if(!tokenEl){tokenEl=document.createElement('style');tokenEl.id='void-token-css';(document.head||document.documentElement).appendChild(tokenEl);tokenEl.textContent=TOKEN_CSS;}
  }

  let bgImg=null,bgOv=null;
  function applyBG(c) {
    if(!bgImg) return;
    bgImg.src=c.bg;
    bgImg.style.filter=`brightness(${c.imgBright}) saturate(${c.imgSat}) grayscale(${c.imgGray})`;
    bgOv.style.background=`radial-gradient(ellipse at center,rgba(0,0,0,.6) 40%,${c.vignette} 100%)`;
  }

  // ── Panel helpers ────────────────────────────────────────────────────────────
  const FONTS=[['Padrão do sistema',''],['Inter','Inter'],['Roboto','Roboto'],['Poppins','Poppins'],['Nunito','Nunito'],['Rajdhani','Rajdhani'],['Orbitron','Orbitron'],['Exo 2','Exo+2'],['Share Tech Mono','Share+Tech+Mono'],['JetBrains Mono','JetBrains+Mono'],['Fira Code','Fira+Code'],['Space Mono','Space+Mono'],['Cinzel','Cinzel'],['Bebas Neue','Bebas+Neue'],['Press Start 2P','Press+Start+2P']];
  const $v=id=>document.getElementById(id)?.value??'';
  const $c=id=>!!document.getElementById(id)?.checked;

  function readPanel() {
    return{
      bg:$v('vp-bg').trim()||CFG.bg,
      accent:$v('vp-accent')||CFG.accent,
      accentDark:$v('vp-accent2')||CFG.accentDark,
      bgOpacity:$v('vp-opacity')||CFG.bgOpacity,
      blurStrength:$v('vp-blur')||CFG.blurStrength,
      pulseSpeed:$v('vp-pulse')||CFG.pulseSpeed,
      borderRadius:$v('vp-radius')||CFG.borderRadius,
      imgBright:$v('vp-imgbright')||CFG.imgBright,
      imgSat:$v('vp-imgsat')||CFG.imgSat,
      imgGray:$v('vp-imggray')||CFG.imgGray,
      vignette:$v('vp-vignette').trim()||CFG.vignette,
      zoom:$v('vp-zoom')||CFG.zoom,
      avatarBorder:$v('vp-avatarb')||CFG.avatarBorder,
      scrollbarW:$v('vp-scrollw')||CFG.scrollbarW,
      fontSize:$v('vp-fontsize')||CFG.fontSize,
      showTools:$c('vp-tools')?'true':'false',
      fontFamily:$v('vp-fontselect')||'',
      customFont:$v('vp-customfont').trim()||'',
      chatWidth:String(parseInt($v('vp-chatwidth'))||parseInt(CFG.chatWidth)),
      showTyping:$c('vp-typing')?'true':'false',
    };
  }

  function setRatioPreview(cw) {
    const rc=document.getElementById('void-ratio-chat'),ra=document.getElementById('void-ratio-answer');
    if(!rc||!ra) return;
    rc.style.width=cw+'%';rc.textContent='CHAT '+cw+'%';
    ra.style.width=(100-cw)+'%';ra.textContent='ANS '+(100-cw)+'%';
  }

  function livePreview() {
    const c=readPanel();applyCSS(c);applyBG(c);applyFont(c);
    const fp=document.getElementById('void-font-preview');
    if(fp){const n=(c.customFont||c.fontFamily).replace(/\+/g,' ');fp.style.fontFamily=n?`'${n}',system-ui`:'system-ui';}
  }

  function mkSlider(id,label,valId,min,max,step,val,sfx) {
    return `<label>${label} <span class="vval" id="${valId}">${val}${sfx}</span></label><input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${val}">`;
  }

  // ── Init ─────────────────────────────────────────────────────────────────────
  let current={...CFG};
  wsConnect();
  applyCSS(current);applyFont(current);

  window.addEventListener('keydown',e=>{if(e.altKey&&e.key.toLowerCase()==='v')document.getElementById('void-panel')?.classList.toggle('open');});

  const btnObs=new MutationObserver(injectBtn);
  const tabLabelObs=new MutationObserver(removeTabLabels);

  function onReady() {
    injectBtn();buildMusicBtn();removeTabLabels();
    tabLabelObs.observe(document.body,{childList:true,subtree:true});
    btnObs.observe(document.body,{childList:true,subtree:true});
    const chatObs=new MutationObserver(()=>{
      if(getScrollEl()){
        watchIncomingMsgs();watchChatInput();watchMusicInChat();watchEnrich();
        setupTypingBar();watchTypingInput();
        chatObs.disconnect();
      }
    });
    chatObs.observe(document.body,{childList:true,subtree:true});
    watchIncomingMsgs();watchChatInput();watchMusicInChat();watchEnrich();
    setupTypingBar();watchTypingInput();
  }

  document.readyState==='loading'?document.addEventListener('DOMContentLoaded',onReady):onReady();

  window.addEventListener('DOMContentLoaded',()=>{
    const firstDiv=document.querySelector('div');
    if(firstDiv){
      bgOv=Object.assign(document.createElement('div'),{style:`width:100%;height:100%;z-index:5;position:absolute;top:0;left:0;pointer-events:none;background:radial-gradient(ellipse at center,rgba(0,0,0,.6) 40%,${current.vignette} 100%)`});
      bgImg=Object.assign(new Image(),{src:current.bg,style:`width:100%;height:100%;z-index:4;position:absolute;top:0;left:0;pointer-events:none;object-fit:cover;filter:brightness(${current.imgBright}) saturate(${current.imgSat}) grayscale(${current.imgGray})`});
      bgImg.oncontextmenu=bgImg.ondragstart=e=>e.preventDefault();
      firstDiv.prepend(bgOv);firstDiv.prepend(bgImg);
    }

    const circleEl=el=>{el.style.setProperty('border-radius','50%','important');el.style.setProperty('clip-path','circle(50% at 50% 50%)','important');el.style.setProperty('overflow','hidden','important');const p=el.parentElement;if(p&&!p.dataset.vw){p.dataset.vw='1';p.style.setProperty('border-radius','50%','important');p.style.setProperty('clip-path','circle(50% at 50% 50%)','important');p.style.setProperty('overflow','hidden','important');}};
    const circleAll=()=>document.querySelectorAll('#users canvas,#users img').forEach(circleEl);
    circleAll();
    new MutationObserver(circleAll).observe(document.body,{childList:true,subtree:true});

    const fontOpts=FONTS.map(([l,v])=>`<option value="${v}"${current.fontFamily===v?' selected':''}>${l}</option>`).join('');
    const cw0=parseInt(current.chatWidth);

    const panel=document.createElement('div');panel.id='void-panel';
    panel.innerHTML=`<div id="void-panel-header"><h2>🖌️ VOID — Customizar</h2><div style="display:flex;align-items:center;gap:10px"><span id="void-live-badge">◉ AO VIVO</span><button id="void-close-btn" title="Fechar (Alt+V)">✕</button></div></div>
<div id="void-tabs"><button class="vtab-active" data-tab="visual">Visual</button><button data-tab="imagem">Imagem</button><button data-tab="layout">Layout</button><button data-tab="chat">Chat</button><button data-tab="fonte">Fonte</button></div>
<div id="void-body">
<div class="vpane vpane-active" id="vpane-visual">
  <div class="vsec-title">Cores</div>
  <div class="vrow"><div><label>Cor principal</label><input type="color" id="vp-accent" value="${current.accent}"></div><div><label>Cor escura</label><input type="color" id="vp-accent2" value="${current.accentDark}"></div></div>
  <div class="vsec-title">Painéis de vidro</div>
  ${mkSlider('vp-opacity','Opacidade','v-op',0.2,0.99,0.01,current.bgOpacity,'')}
  ${mkSlider('vp-blur','Blur','v-bl',0,30,1,current.blurStrength,'px')}
  ${mkSlider('vp-radius','Arredondamento','v-br',0,20,1,current.borderRadius,'px')}
  <div class="vsec-title">Animação</div>
  ${mkSlider('vp-pulse','Velocidade do pulso','v-ps',1,12,0.5,current.pulseSpeed,'s')}
</div>
<div class="vpane" id="vpane-imagem">
  <div class="vsec-title">Imagem de fundo</div>
  <label>URL</label><input type="text" id="vp-bg" placeholder="https://..." value="${current.bg}">
  ${mkSlider('vp-imgbright','Brilho','v-ib',0.05,1,0.01,current.imgBright,'')}
  ${mkSlider('vp-imgsat','Saturação','v-is',0,2,0.05,current.imgSat,'')}
  ${mkSlider('vp-imggray','Escala de cinza','v-ig',0,1,0.05,current.imgGray,'')}
  <div class="vsec-title">Vinheta</div>
  <label>Cor da vinheta (rgba)</label><input type="text" id="vp-vignette" value="${current.vignette}" placeholder="rgba(0,0,20,0.55)">
</div>
<div class="vpane" id="vpane-layout">
  <div class="vsec-title">Zoom</div>
  ${mkSlider('vp-zoom','Escala da tela','v-zm',0.5,1,0.01,current.zoom,'')}
  <div class="vsec-title">Avatares</div>
  ${mkSlider('vp-avatarb','Espessura da borda','v-ab',0,6,1,current.avatarBorder,'px')}
  <div class="vsec-title">Scrollbar</div>
  ${mkSlider('vp-scrollw','Largura','v-sw',0,12,1,current.scrollbarW,'px')}
  <div class="vsec-title">Ferramentas</div>
  <label class="vcheck-row"><input type="checkbox" id="vp-tools" ${current.showTools==='true'?'checked':''}>Mostrar barra de ferramentas de desenho</label>
</div>
<div class="vpane" id="vpane-chat">
  <div class="vsec-title">Texto</div>
  ${mkSlider('vp-fontsize','Tamanho da fonte','v-fs',11,20,1,current.fontSize,'px')}
  <div class="vsec-title">Largura do Chat</div>
  ${mkSlider('vp-chatwidth','Chat vs Respostas','v-cw',40,80,1,current.chatWidth,'%')}
  <div id="void-ratio-preview"><div id="void-ratio-chat" style="width:${cw0}%">CHAT ${cw0}%</div><div id="void-ratio-answer" style="width:${100-cw0}%">ANS ${100-cw0}%</div></div>
  <div class="vsec-title" style="margin-top:16px">Indicador de Digitação</div>
  <label class="vcheck-row"><input type="checkbox" id="vp-typing" ${current.showTyping!=='false'?'checked':''}>Mostrar quando alguém está digitando</label>
</div>
<div class="vpane" id="vpane-fonte">
  <div class="vsec-title">Google Fonts</div>
  <label>Escolher fonte</label><select id="vp-fontselect">${fontOpts}</select>
  <div class="vsec-title" style="margin-top:16px">Fonte personalizada</div>
  <label>Nome exato do Google Fonts</label><input type="text" id="vp-customfont" placeholder="ex: Space Grotesk" value="${current.customFont}">
  <div style="font-size:10px;color:rgba(255,255,255,.25);margin-top:4px;line-height:1.5">Digite o nome como aparece em fonts.google.com.<br>Tem prioridade sobre o seletor acima.</div>
  <div class="vsec-title" style="margin-top:16px">Preview</div>
  <div id="void-font-preview">O rato roeu a roupa do rei de Roma 123</div>
</div>
</div>
<div id="void-footer"><button id="void-btn-reset" type="button">↺ Reset</button><button id="void-btn-apply" type="button">✓ Salvar</button></div>`;
    document.body.appendChild(panel);

    const toggle=document.createElement('div');toggle.id='void-toggle';toggle.title='VOID — Customizar (Alt+V)';
    toggle.innerHTML='<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18.37 2.63 14 7l-1.59-1.59a2 2 0 0 0-2.82 0L8 7l9 9 1.59-1.59a2 2 0 0 0 0-2.82L17 10l4.37-4.37a2.12 2.12 0 1 0-3-3Z"/><path d="M9 8c-2 3-4 3.5-7 4l8 8c1-.5 3.5-2 4-7"/><path d="M14.5 17.5 4.5 15"/></svg>';
    document.body.appendChild(toggle);

    const fp=document.getElementById('void-font-preview');
    if(current.fontFamily||current.customFont){const n=(current.customFont||current.fontFamily).replace(/\+/g,' ');if(n)fp.style.fontFamily=`'${n}',system-ui`;}

    panel.querySelectorAll('#void-tabs button').forEach(btn=>btn.addEventListener('click',()=>{
      panel.querySelectorAll('#void-tabs button').forEach(b=>b.classList.remove('vtab-active'));
      panel.querySelectorAll('.vpane').forEach(p=>p.classList.remove('vpane-active'));
      btn.classList.add('vtab-active');document.getElementById('vpane-'+btn.dataset.tab)?.classList.add('vpane-active');
    }));

    [['vp-opacity','v-op',''],['vp-blur','v-bl','px'],['vp-radius','v-br','px'],['vp-pulse','v-ps','s'],
     ['vp-zoom','v-zm',''],['vp-avatarb','v-ab','px'],['vp-scrollw','v-sw','px'],['vp-fontsize','v-fs','px'],
     ['vp-imgbright','v-ib',''],['vp-imgsat','v-is',''],['vp-imggray','v-ig','']
    ].forEach(([id,vid,sfx])=>document.getElementById(id)?.addEventListener('input',e=>{document.getElementById(vid).textContent=e.target.value+sfx;livePreview();}));

    document.getElementById('vp-chatwidth')?.addEventListener('input',e=>{const cw=parseInt(e.target.value);document.getElementById('v-cw').textContent=cw+'%';setRatioPreview(cw);livePreview();});
    ['vp-accent','vp-accent2','vp-bg','vp-vignette'].forEach(id=>document.getElementById(id)?.addEventListener('input',livePreview));
    document.getElementById('vp-tools')?.addEventListener('change',livePreview);
    document.getElementById('vp-typing')?.addEventListener('change',()=>{
      GM_setValue('showTyping', document.getElementById('vp-typing').checked ? 'true' : 'false');
      // Se desativou, limpa o bar imediatamente
      if(!document.getElementById('vp-typing').checked){
        typingUsers.forEach(tid=>clearTimeout(tid));
        typingUsers.clear();
        renderTypingBar();
      }
    });

    const updateFontPreview=()=>{const n=($v('vp-customfont')||$v('vp-fontselect')).replace(/\+/g,' ');fp.style.fontFamily=n?`'${n}',system-ui`:'system-ui';};
    document.getElementById('vp-fontselect')?.addEventListener('change',()=>{updateFontPreview();if(!$v('vp-customfont'))livePreview();});
    document.getElementById('vp-customfont')?.addEventListener('input',()=>{updateFontPreview();livePreview();});

    toggle.addEventListener('click',()=>panel.classList.toggle('open'));
    document.getElementById('void-close-btn')?.addEventListener('click',()=>panel.classList.remove('open'));
    document.getElementById('void-btn-apply')?.addEventListener('click',()=>{current=readPanel();Object.entries(current).forEach(([k,v])=>GM_setValue(k,v));applyCSS(current);applyBG(current);applyFont(current);panel.classList.remove('open');});

    document.getElementById('void-btn-reset')?.addEventListener('click',()=>{
      const d=DEFAULTS;
      [['vp-bg',d.bg],['vp-accent',d.accent],['vp-accent2',d.accentDark],['vp-vignette',d.vignette],['vp-opacity',d.bgOpacity],['vp-blur',d.blurStrength],['vp-radius',d.borderRadius],['vp-pulse',d.pulseSpeed],['vp-zoom',d.zoom],['vp-avatarb',d.avatarBorder],['vp-scrollw',d.scrollbarW],['vp-fontsize',d.fontSize],['vp-imgbright',d.imgBright],['vp-imgsat',d.imgSat],['vp-imggray',d.imgGray],['vp-chatwidth',d.chatWidth],['vp-fontselect',''],['vp-customfont','']
      ].forEach(([id,val])=>{const el=document.getElementById(id);if(el)el.value=val;});
      document.getElementById('vp-tools').checked=false;
      document.getElementById('vp-typing').checked=true;
      fp.style.fontFamily='system-ui';
      [['v-op',d.bgOpacity,''],['v-bl',d.blurStrength,'px'],['v-br',d.borderRadius,'px'],['v-ps',d.pulseSpeed,'s'],['v-zm',d.zoom,''],['v-ab',d.avatarBorder,'px'],['v-sw',d.scrollbarW,'px'],['v-fs',d.fontSize,'px'],['v-ib',d.imgBright,''],['v-is',d.imgSat,''],['v-ig',d.imgGray,''],['v-cw',d.chatWidth,'%']
      ].forEach(([id,val,sfx])=>{const el=document.getElementById(id);if(el)el.textContent=val+sfx;});
      setRatioPreview(parseInt(d.chatWidth));livePreview();
    });

    const s=document.getElementById('void-font-s');if(s&&s.parentElement!==document.head)document.head.appendChild(s);if(fontLink&&fontLink.parentElement!==document.head)document.head.appendChild(fontLink);
  });

})();

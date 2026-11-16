(() => {
  'use strict';
  const validMode = value => value === 'api' || value === 'subscription';
  const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  function windowText(item) {
    const used = number(item.usedPercent);
    return used === null ? '额度比例未知' : `已用 ${used.toFixed(1)}% · 剩余 ${Math.max(0, 100 - used).toFixed(1)}%${item.stale ? '（快照已过期）' : ''}`;
  }
  function tokenText(value) { const n = number(value); return n === null ? '暂无记录' : n.toLocaleString() + ' token'; }
  function quotaLabel(item) { return item.windowDurationMins === 300 ? '5 小时额度' : item.windowDurationMins === 10080 ? '每周额度' : item.label || '额度窗口'; }
  function resetCountdown(value, now = Date.now()) {
    if (value == null || value === '') return '重置时间未知';
    const at = typeof value === 'number' ? (value < 1e12 ? value * 1000 : value) : Date.parse(value);
    if (!Number.isFinite(at) || at <= 0) return '重置时间未知';
    const seconds = Math.ceil((at - now) / 1000);
    if (seconds <= 0) return '已到重置时间，等待新快照';
    const days = Math.floor(seconds / 86400), hours = Math.floor(seconds % 86400 / 3600), minutes = Math.floor(seconds % 3600 / 60);
    return '距重置 ' + (days ? `${days}天${hours}小时${minutes}分` : hours ? `${hours}小时${minutes}分` : `${minutes}分${seconds % 60}秒`);
  }
  function noticeText(value) {
    if (!value || value.notify === false) return '';
    if (value.failureKind === 'high-demand') return '挤不进去...';
    return number(value.tokens) === null ? '本轮 token 暂无记录' : '本轮本机已观测：' + tokenText(value.tokens);
  }
  function turnSummary(value) {
    const label = value.failureKind === 'high-demand' ? '挤不进去...' :
      value.completionKind === 'cancelled' ? '本轮已取消' : value.completionKind === 'failed' ? '本轮未完成' : '本轮已观测用量';
    let hint = value.costState === 'pending' ? '金额待记账' : '金额未知';
    if (number(value.amount) !== null && !['pending', 'unknown'].includes(value.costState)) {
      const amount = value.amount.toLocaleString(undefined, { maximumSignificantDigits: 8 });
      hint = (/估算/.test(value.label || '') ? '费用估算 ' : '已观测金额 ') + amount + ' ' + (value.currency || 'USD');
    }
    return { label, amount: tokenText(value.tokens), hint: '本机记录 · ' + hint };
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { validMode, windowText, tokenText, noticeText, quotaLabel, resetCountdown, turnSummary };
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  const key = 'dshw-account-view';
  let mode = 'api', card = null, content = null, root = null, generation = 0, switching = false, latestNotice = null, bubbleRenderer = null;
  let modeButtons = [], status = null, modeRevision = 0, countdownTimer = null, noticeTimer = null, noticeTtlMs = 5000, restoreQuota = false;
  let quotaPollTimer = null, quotaReads = 0;
  function scheduleQuotaRefresh() {
    clearTimeout(quotaPollTimer); quotaPollTimer = null;
    if (mode === 'subscription' && card && !latestNotice) quotaPollTimer = setTimeout(refreshQuotaAutomatically, 30000);
  }
  function refreshQuotaAutomatically() {
    if (mode !== 'subscription' || !card || latestNotice) return;
    if (document.hidden || quotaReads > 0) { scheduleQuotaRefresh(); return; }
    void refresh();
  }
  try { const saved = localStorage.getItem(key); if (validMode(saved)) mode = saved; } catch {}
  function text(parent, tag, value) { const el = document.createElement(tag); el.textContent = value; parent.append(el); return el; }
  function date(value) { if (!value) return '未知'; const d = new Date(typeof value === 'number' && value < 1e12 ? value * 1000 : value); return Number.isFinite(d.getTime()) ? d.toLocaleString() : '未知'; }
  function close() {
    clearTimeout(quotaPollTimer); quotaPollTimer = null;
    clearInterval(countdownTimer); countdownTimer = null;
    clearTimeout(noticeTimer); noticeTimer = null;
    latestNotice = null; restoreQuota = false;
    generation++;
    const outgoing = card;
    bubbleRenderer?.close();
    bubbleRenderer?.resizeObserver.disconnect();
    bubbleRenderer?.contentObserver.disconnect();
    bubbleRenderer = null; card = content = null;
    if (outgoing) {
      outgoing.classList.remove('dshwv-pop-open');
      outgoing.style.pointerEvents = 'none';
      setTimeout(() => outgoing.remove(), 400);
      window.WhaleRendering?.presentFor(450);
    }
  }
  function position() {
    if (!card) return;
    if (card.classList.contains('whale-subscription-bubble')) return;
    const anchor = (root || document).querySelector('.dshwv-img') || document.querySelector('.dshwv-img');
    if (!anchor) return;
    const bounds = anchor.getBoundingClientRect(), width = card.offsetWidth || 280, height = card.offsetHeight || 220;
    const left = Math.max(8, Math.min(window.innerWidth - width - 8, bounds.right - width)) + 'px';
    const top = Math.max(8, Math.min(window.innerHeight - height - 8, bounds.top - height - 10 >= 8 ? bounds.top - height - 10 : bounds.bottom + 10)) + 'px';
    if(card.style.left!==left)card.style.left=left;
    if(card.style.top!==top)card.style.top=top;
  }
  function updateButtons() { for (const button of modeButtons) { button.disabled = switching; button.setAttribute('aria-pressed', String(button.dataset.mode === mode)); } for(const el of document.querySelectorAll('[data-account-api]'))el.hidden=mode==='subscription';
    document.documentElement.dataset.accountMode = mode;
    for (const el of document.querySelectorAll('.whale-mode-description')) el.textContent = mode === 'subscription' ? '查看 5 小时 / 周额度与本机 token 用量' : '查看当前 API 余额与消费记录';
    for (const el of document.querySelectorAll('.whale-mode-open')) el.textContent = mode === 'subscription' ? '查看订阅额度 →' : '配置 API 余额 →';
  }
  function followCard(ownCard) {
    if (card !== ownCard) return;
    position(); window.requestAnimationFrame(() => followCard(ownCard));
  }
  function commit(next) {
    mode = next; try { localStorage.setItem(key, mode); } catch {}
    close(); latestNotice = null; updateButtons();
    window.dispatchEvent(new CustomEvent('whale-account-view', { detail: { mode } }));
  }
  async function setMode(next) {
    if (!validMode(next) || switching) return false;
    modeRevision++; switching = true; updateButtons(); if (status) status.textContent = '正在保存…';
    try {
      const response = await fetch('/api/display-mode', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: next }) });
      if (!response.ok) throw Error('切换失败，请重试');
      const result = await response.json();
      if (result.ok === false || (result.mode || result.displayMode) !== next) throw Error('模式未保存，请重试');
      commit(next); if (status) status.textContent = next === 'subscription' ? '已切换。点击下方按钮查看额度。' : '已切换为 API 余额模式。'; return true;
    } catch (e) { if (status) status.textContent = e.message || '切换失败，请重试'; return false; }
    finally { switching = false; updateButtons(); }
  }
  async function refresh() {
    if (mode !== 'subscription' || !card) return;
    clearTimeout(quotaPollTimer); quotaPollTimer = null;
    clearInterval(countdownTimer); countdownTimer = null;
    clearTimeout(noticeTimer); noticeTimer = null;
    const own = ++generation, ownCard = card, renderer = bubbleRenderer;
    const show = (label, amount, hint) => {
      if (renderer.hasFrame && !renderer.switching && renderer.front.label.textContent === label && renderer.front.amount.textContent === amount) {
        renderer.front.hint.textContent = hint;
        return Promise.resolve(true);
      }
      return renderer.open(parts => {
      parts.label.textContent = label; parts.amount.textContent = amount; parts.hint.textContent = hint;
      }, () => { if (card === ownCard && own === generation) ownCard.classList.add('dshwv-pop-open'); });
    };
    if (latestNotice) {
      const notice = latestNotice, summary = turnSummary(notice);
      const shown = await show(summary.label, summary.amount, summary.hint);
      if (shown && own === generation && card === ownCard && latestNotice === notice && noticeTtlMs > 0) {
        noticeTimer = setTimeout(() => {
          if (own === generation && card === ownCard && latestNotice === notice) dismissNotice();
        }, noticeTtlMs);
      }
      return;
    }
    if (!renderer.hasFrame) await show('Codex 订阅', '正在读取…', '正在读取本机额度快照');
    if (own !== generation || card !== ownCard) return;
    quotaReads++;
    try {
      const response = await fetch('/api/insights', { cache: 'no-store', signal: AbortSignal.timeout(10000) }); if (!response.ok) throw Error('暂时无法读取订阅快照');
      const data = await response.json(); if (own !== generation || !card) return;
      const sub = data.subscription || {}, windows = sub.available ? sub.windows || [] : [];
      const remaining = item => !item || number(item.usedPercent) === null ? '未知' : `${Math.max(0, 100 - item.usedPercent).toFixed(1)}%${item.stale ? '（过期）' : ''}`;
      if (windows.length) {
        const week = windows.find(item => item.windowDurationMins === 10080);
        await show('Codex 订阅', '周余 ' + remaining(week), resetCountdown(week?.resetsAt));
        if (own === generation && card === ownCard) {
          countdownTimer = setInterval(() => {
            if (own !== generation || card !== ownCard) return;
            const hint = renderer.front.hint, next = resetCountdown(week?.resetsAt);
            if (hint.textContent !== next) hint.textContent = next;
          }, 1000);
        }
      } else {
        await show('Codex 订阅', '暂无快照', '完成一次订阅请求后再试\n点气泡查看详情');
      }
    } catch (e) { if (own === generation && card) await show('Codex 订阅', '暂不可用', e.message || '读取失败，请稍后重试'); }
    finally {
      quotaReads--;
      if (own === generation && card === ownCard && !latestNotice) scheduleQuotaRefresh();
    }
  }
  function createBubble(anchorRoot) {
    root = anchorRoot?.querySelector ? anchorRoot : document;
    const body = root.querySelector('.dshwv-body'), classic = body?.querySelector('.dshwv-pop svg');
    if (!body || !classic || !window.WhaleRendering) return false;
    card = document.createElement('section'); card.className = 'whale-account-card whale-subscription-bubble dshwv-pop'; card.setAttribute('aria-label', '会员订阅额度，点击查看详情');
    card.append(classic.cloneNode(true));
    content = text(card, 'div', ''); content.className = 'dshwv-text';
    bubbleRenderer = new window.WhaleRendering.BubbleRenderer(content, '/assets/bubble-petpet.gif');
    card.addEventListener('click', event => {
      event.stopPropagation();
      if (latestNotice) { dismissNotice(); return; }
      close(); window.dispatchEvent(new Event('whale-open-insights'));
    });
    body.append(card); return true;
  }
  function toggleBubble(anchorRoot) {
    if (mode !== 'subscription') return false;
    if (latestNotice) return dismissNotice();
    if (card) { close(); return true; }
    if (!createBubble(anchorRoot)) return false;
    refresh(); return true;
  }
  function dismissNotice() {
    if (!latestNotice) return false;
    const restore = restoreQuota;
    clearTimeout(noticeTimer); noticeTimer = null;
    latestNotice = null; restoreQuota = false;
    if (restore && card) refresh(); else close();
    return true;
  }
  function notice(value, options = {}) {
    if (mode !== 'subscription' || !value || value.notify === false) return false;
    if (latestNotice?.id && latestNotice.id === value.id) return false;
    const wasOpen = !!card;
    if (!card && !createBubble(options.root || root || document.querySelector('.dshwv-root'))) return false;
    if (!latestNotice) restoreQuota = wasOpen;
    latestNotice = value;
    noticeTtlMs = Number.isFinite(options.ttlMs) ? Math.max(0, options.ttlMs) : 5000;
    refresh(); return true;
  }
  function init() {
    const style = document.createElement('style'); style.textContent = `.whale-account-card{position:fixed;z-index:2147483646;width:280px;max-width:calc(100vw - 16px);max-height:calc(100vh - 16px);overflow:auto;box-sizing:border-box;padding:14px;border:1px solid #9fcbd5;border-radius:16px;background:#f6fdff;color:#173d48;box-shadow:0 8px 26px #163f4433;font:13px/1.5 system-ui;pointer-events:auto}.whale-account-card p{margin:8px 0}.whale-account-card small{display:block;color:#496873}.whale-account-card progress{width:100%;accent-color:#258b9c}.whale-account-header{display:flex;justify-content:space-between;align-items:center}.whale-account-card button,.whale-account-menu button{cursor:pointer;border:1px solid #9fcbd5;border-radius:8px;padding:5px 9px;background:#fff;color:#173d48}.whale-account-menu{font:12px/1.5 system-ui;padding:5px}.whale-account-menu summary{cursor:pointer}.whale-account-menu button[aria-pressed=true]{background:#237f91;color:white}.whale-account-menu small{display:block;max-width:230px;margin-top:5px}`; document.head.append(style);
    const menu = document.querySelector('.dshwv-menu');
    if (menu) {
      const details = text(menu, 'section', ''); details.className = 'whale-account-menu'; text(details, 'strong', '小鲸鱼 · 控制面板'); menu.prepend(details);
      const row = text(details, 'div', ''); row.setAttribute('role', 'group'); row.setAttribute('aria-label', '额度展示模式');
      for (const [value, label] of [['api', 'API 余额'], ['subscription', 'Codex 订阅']]) { const button = text(row, 'button', label); button.dataset.mode = value; button.onclick = () => setMode(value); modeButtons.push(button); }
      text(details, 'p', '').className = 'whale-mode-description';
      const open = text(details, 'button', ''); open.className = 'whale-mode-open'; open.onclick = () => window.dispatchEvent(new Event(mode === 'subscription' ? 'whale-open-insights' : 'whale-open-settings'));
      status = text(details, 'small', '切换展示模式，不修改登录账号。'); status.setAttribute('role', 'status'); updateButtons();
      const view = menu.querySelector('.dshwv-menuview');
      if (view) {
        const rows = [...view.children];
        const groups = ['外观与位置', '声音与气泡', '用量与资源'].map(label => {
          const group = document.createElement('details'); group.className = 'whale-menu-group';
          text(group, 'summary', label); view.append(group); return group;
        });
        groups[0].open = true;
        for (const child of rows) {
          if (child.classList.contains('dshwv-menu-sep')) { child.remove(); continue; }
          const label = child.textContent;
          const index = /音效|音量|气泡|消耗提示|声音/.test(label) ? 1 : /币种|汇率|资源|工坊|API|额度|峰谷/.test(label) ? 2 : 0;
          groups[index].append(child);
        }
      }
    }
    const initialRevision = modeRevision;
    fetch('/api/display-mode', { cache: 'no-store' }).then(async response => { if (!response.ok) return; const data = await response.json(); const next = data.mode || data.displayMode; if (validMode(next) && !switching && modeRevision === initialRevision) commit(next); }).catch(() => {});
    window.addEventListener('resize', position);
    window.addEventListener('whale-mode-changing', close);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshQuotaAutomatically(); });
    window.addEventListener('focus', refreshQuotaAutomatically);
  }
  window.WhaleAccountView = { get mode() { return mode; }, toggleBubble, refresh, notice, dismissNotice, close, setMode, quotaLabel };
  // Deferred scripts run at readyState=interactive before the widget creates its menu.
  if (document.readyState !== 'complete') document.addEventListener('DOMContentLoaded', init, { once: true }); else init();
})();

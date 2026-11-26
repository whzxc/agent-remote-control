const request = new URLSearchParams(location.search).get('request');
const element = id => document.getElementById(id);
const zh = navigator.language.toLowerCase().startsWith('zh');
document.documentElement.lang = zh ? 'zh-CN' : 'en';
const copy = zh ? {
  title: '连接授权', wants: ' 想连接你的电脑', pending: '在 Agent Remote Control 里确认这个代码',
  approved: '已批准，正在返回…', denied: '已拒绝，正在返回…', completed: '已连接，可以关闭此页', expired: '请求已过期，请重新连接',
  wait: '确认后此页自动跳回', open: '打开 Agent Remote Control', back: '返回客户端', retry: '暂时无法读取状态，正在重试…',
} : {
  title: 'Connect your computer', wants: ' wants to connect to your computer', pending: 'Confirm this code in Agent Remote Control',
  approved: 'Approved. Returning…', denied: 'Declined. Returning…', completed: 'Connected. You can close this page.', expired: 'Request expired. Please reconnect.',
  wait: 'This page returns automatically after confirmation', open: 'Open Agent Remote Control', back: 'Return to client', retry: 'Unable to read status. Retrying…',
};
document.title = copy.title + ' · Agent Remote Control';
element('open-app').textContent = copy.open;
element('return').textContent = copy.back;
element('hint').textContent = copy.wait;
let redirecting = false, timer;
function render(state) {
  element('title').textContent = state.clientName ? state.clientName + copy.wants : copy.title;
  element('status').textContent = copy[state.status] || copy.expired;
  element('consent').hidden = state.status !== 'pending';
  element('code').textContent = state.pairingCode || '';
  if (state.openAppUrl) element('open-app').href = state.openAppUrl;
  if (['approved', 'denied'].includes(state.status)) {
    const link = element('return');
    link.href = `./continue?request=${encodeURIComponent(request)}`;
    link.hidden = false;
    if (!redirecting) { redirecting = true; setTimeout(() => location.assign(link.href), 700); }
  }
  if (['completed', 'expired'].includes(state.status)) clearTimeout(timer);
}
async function refresh() {
  if (redirecting) return;
  try {
    const response = await fetch(`./status?request=${encodeURIComponent(request || '')}`, { cache: 'no-store' });
    if (!response.ok) throw new Error();
    const state = await response.json(); render(state);
    if (state.status === 'pending') timer = setTimeout(refresh, 2500);
  } catch { element('status').textContent = copy.retry; timer = setTimeout(refresh, 5000); }
}
if (request) refresh(); else render({ status: 'expired' });

// Shared sample data + render for masthead studies (05–08).
// Mirrors 02e-bg.html. Numbers tweaked so the count reflects the real corpus (1,733).

const NOTES = [
  { uuid:'a1', text:'buy bok choy', updated:'2026-05-22T18:04:00Z', tags:['todo','shop'] },
  { uuid:'b2', text:'idea: sticky note board with masonry layout via pretext', updated:'2026-05-22T15:31:00Z', tags:['idea','board'] },
  { uuid:'c3', text:'the difference between vision and hallucination is whether other people can see it too', updated:'2026-05-21T22:11:00Z', tags:['thought'] },
  { uuid:'d4', text:'todo: ssh into the new box, set up tailscale, install zellij', updated:'2026-05-21T09:47:00Z', tags:['todo','infra'] },
  { uuid:'e5', text:"today's lesson — pretext is a library not a framework. you render with whatever.", updated:'2026-05-20T16:22:00Z', tags:['lesson'] },
  { uuid:'f6', text:'jamie birthday march 14', updated:'2026-05-19T11:00:00Z', tags:['reminder','people'] },
  { uuid:'g7', text:'the way to import 40 thousand art hoes to SF to teach engineers love (and thus save humankind) would be to open an elite fashion school. considering the materials science infrastructure this is actually the obvious path forward for fashion.', updated:'2026-05-18T03:14:00Z', tags:['idea','hot-take'] },
  { uuid:'h8', text:'every infra choice is a bet on who you will be in two years', updated:'2026-05-17T08:00:00Z', tags:['thought','infra'] },
];
const CORPUS_TOTAL = 1733;   // displayed count, matches the real D1 corpus

const fmt = iso => { const d=new Date(iso),p=n=>String(n).padStart(2,'0'); return `${p(d.getDate())}.${p(d.getMonth()+1)}.${String(d.getFullYear()).slice(2)}`; };
const TAG_COLORS = {todo:'#C8102E',shop:'#E8704A',idea:'#003B8E',board:'#0F766E',thought:'#6E3CBC',infra:'#44403c',lesson:'#C99700',reminder:'#2D6A4F',people:'#B8336A','hot-take':'#DC2626'};
const TAG_BG = {todo:'#FBE5E9',shop:'#FCEAD7',idea:'#DEE6F2',board:'#DBEBE9',thought:'#ECE4F5',infra:'#EDEBE8',lesson:'#F7EDD0',reminder:'#DEEDDB',people:'#F1DCE5','hot-take':'#FCDDDD'};
const tagColor = t => TAG_COLORS[t] || '#A8A29E';
const tagBg = t => TAG_BG[t] || '#F5F5F4';
const counts = NOTES.reduce((acc,n) => { for (const t of n.tags) acc[t] = (acc[t]||0)+1; return acc; }, {});
const TAG_ORDER = Object.entries(counts).sort((a,b) => b[1]-a[1] || a[0].localeCompare(b[0])).map(([t]) => t);
const active = new Set();

function renderPills() {
  const p = document.getElementById('pills');
  const allBtn = `<button class="pill all ${active.size===0?'active':''}" data-tag="">all <span class="n">${CORPUS_TOTAL.toLocaleString()}</span></button>`;
  const pills = TAG_ORDER.map(t => `<button class="pill ${active.has(t)?'active':''}" data-tag="${t}" style="--c:${tagColor(t)};--c-bg:${tagBg(t)}">${t}<span class="n">${counts[t]}</span></button>`).join('');
  const clear = active.size ? `<button class="pill clear" data-tag="__clear__">clear ✕</button>` : '';
  p.innerHTML = `<span class="label">Filter</span>${allBtn}${pills}${clear}`;
}

function render() {
  const q = document.getElementById('search').value.toLowerCase().trim();
  let list = NOTES;
  if (active.size > 0) list = list.filter(n => n.tags.some(t => active.has(t)));
  if (q) list = list.filter(n => n.text.toLowerCase().includes(q));
  const root = document.getElementById('notes'); root.innerHTML = '';
  list.forEach(n => {
    const el = document.createElement('article'); el.className = 'note';
    el.style.setProperty('--c', tagBg(n.tags[0]));
    const tagMini = n.tags.map(t => `<span class="tag-mini ${active.has(t)?'matched':''}">${t}</span>`).join('<span class="dot">·</span>');
    el.innerHTML = `<p class="text"></p><div class="caption"><span>${fmt(n.updated)}</span><span class="dot">·</span>${tagMini}</div>`;
    el.querySelector('.text').textContent = n.text;
    root.appendChild(el);
  });
  document.getElementById('count').textContent = list.length;
  // Hero count slot (used by masthead variations that display it large)
  document.querySelectorAll('[data-count]').forEach(el => {
    el.textContent = CORPUS_TOTAL.toLocaleString();
  });
  renderPills();
}
render();

document.getElementById('pills').addEventListener('click', e => {
  const btn = e.target.closest('.pill'); if (!btn) return;
  const tag = btn.dataset.tag;
  if (tag === '' || tag === '__clear__') { active.clear(); }
  else { active.has(tag) ? active.delete(tag) : active.add(tag); }
  render();
});
let t; document.getElementById('search').addEventListener('input', () => { clearTimeout(t); t = setTimeout(render, 150); });

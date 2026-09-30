// ============================================================ boas-vindas: 1º acesso (nome do escritório) e seletor
// chooseOffice() → Promise<officeId>. Regras:
//   #o=<id> na URL → abre direto (se existir) · nenhum escritório → cartão "Qual o nome do escritório?"
//   1 escritório → abre direto · mais de 1 → seletor (o último usado vem destacado; fica em localStorage)
import { $, esc, request } from './util.js';

const LAST = 'esc.lastOffice';
const readLast = () => { try { return localStorage.getItem(LAST); } catch { return null; } };
export const rememberOffice = id => { try { localStorage.setItem(LAST, id); } catch { /* */ } };
const hashOffice = () => { const m = location.hash.match(/(?:^#|&)o=([^&]+)/); return m ? decodeURIComponent(m[1]) : null; };
export function setHashOffice(id) { history.replaceState(null, '', `#o=${encodeURIComponent(id)}`); }

function show(html) {
  const w = $('#welcome');
  w.innerHTML = html;
  w.hidden = false;
  return w;
}
export function hideWelcome() { const w = $('#welcome'); w.hidden = true; w.innerHTML = ''; }

const LOGO = `<div class="card-logo" aria-hidden="true"><span></span><span></span><span></span></div>`;

// cartão de visita para criar um escritório; resolve com o id criado (ou o existente, se o usuário escolher)
function createCard(root, { canCancel = false } = {}) {
  return new Promise(resolve => {
    const w = show(`
      <form class="bcard" autocomplete="off">
        ${LOGO}
        <div class="bc-kicker">Bem-vindo(a) ao seu novo</div>
        <h1>Escritório</h1>
        <label for="bc-name">Qual o nome do escritório?</label>
        <input id="bc-name" name="name" maxlength="80" placeholder="Ex.: Papelaria Pinheiro Filial Scranton" required>
        <div class="bc-folder">A pasta será <code id="bc-path">${esc(root)}/…</code></div>
        <div class="bc-err" id="bc-err" role="alert"></div>
        <div class="bc-actions">
          ${canCancel ? '<button type="button" class="ghost" id="bc-cancel">Voltar</button>' : ''}
          <button type="submit" class="primary" id="bc-go">Abrir as portas</button>
        </div>
        <div class="bc-foot">Cada sala será um projeto. Cada funcionário, um Claude trabalhando nele.</div>
      </form>`);
    const input = w.querySelector('#bc-name'), pathEl = w.querySelector('#bc-path'), err = w.querySelector('#bc-err');
    let t = 0, last = '';
    const preview = async () => {
      const v = input.value.trim();
      if (v === last) return; last = v;
      if (!v) { pathEl.textContent = `${root}/…`; err.textContent = ''; return; }
      try {
        const r = await request('/api/office-name', { name: v });
        if (input.value.trim() !== v) return;
        pathEl.textContent = r.path;
        err.textContent = r.exists ? 'Já existe um escritório com esse nome — ele será aberto.' : '';
      } catch (e) { if (input.value.trim() === v) { pathEl.textContent = `${root}/…`; err.textContent = e.message; } }
    };
    input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(preview, 220); });
    w.querySelector('#bc-cancel')?.addEventListener('click', () => resolve(null));
    w.querySelector('form').addEventListener('submit', async ev => {
      ev.preventDefault();
      const name = input.value.trim();
      if (!name) return;
      const btn = w.querySelector('#bc-go'); btn.disabled = true;
      try {
        const r = await request('/api/office', {}, 'POST', { name });
        resolve(r.id);
      } catch (e) {
        if (e.status === 409 && e.body?.id) { resolve(e.body.id); return; }
        err.textContent = e.message; btn.disabled = false;
      }
    });
    setTimeout(() => input.focus(), 50);
  });
}

function selector(root, offices, last, canCancel = false) {
  return new Promise(resolve => {
    const w = show(`
      <div class="bcard wide">
        ${LOGO}
        <div class="bc-kicker">Escolha a empresa</div>
        <h1>Seus escritórios</h1>
        <div class="office-list">${offices.map(o => `
          <button type="button" class="office-item${o.id === last ? ' last' : ''}" data-id="${esc(o.id)}">
            <b>${esc(o.name)}</b><small>${esc(root)}/${esc(o.id)}${o.id === last ? ' · último usado' : ''}</small>
          </button>`).join('')}
        </div>
        <div class="bc-actions">${canCancel ? '<button type="button" class="ghost" id="bc-back">Voltar</button>' : ''}<button type="button" class="ghost" id="bc-new">+ Novo escritório</button></div>
      </div>`);
    w.querySelectorAll('.office-item').forEach(b => b.addEventListener('click', () => resolve(b.dataset.id)));
    w.querySelector('#bc-back')?.addEventListener('click', () => resolve(null));
    w.querySelector('#bc-new').addEventListener('click', async () => {
      const id = await createCard(root, { canCancel: true });
      if (id) resolve(id); else resolve(selector(root, offices, last, canCancel));
    });
    (w.querySelector('.office-item.last') || w.querySelector('.office-item'))?.focus();
  });
}

export async function chooseOffice({ forceSelector = false } = {}) {
  const { root, offices } = await request('/api/office');
  const ids = new Set(offices.map(o => o.id));
  const fromHash = hashOffice();
  if (!forceSelector && fromHash && ids.has(fromHash)) return fromHash;
  if (!offices.length) return createCard(root);
  if (offices.length === 1 && !forceSelector) return offices[0].id;
  return selector(root, offices, readLast(), forceSelector);
}

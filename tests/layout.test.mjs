// Testes do layout (node tests/layout.test.mjs): plantas de N=0..30 conexas, caminhos dos NPCs, paredes finas.
import { generateLayout, checkLayout, wallBoxes, furnitureBoxes, roomAt, areaAt, asciiLayout, isWalkable } from '../js/office/layout.js';
import { makeNav } from '../js/office/nav.js';

let fails = 0;
const ok = (cond, msg) => { if (!cond) { fails++; console.error('FALHOU:', msg); } };
let prevCols = null, prevRects = null;
for (let N = 0; N <= 30; N++) {
  const ids = Array.from({ length: N }, (_, i) => `proj${i}`);
  const lay = generateLayout(ids);
  const { probs, reachable } = checkLayout(lay);
  ok(!probs.length, `N=${N}: ${probs.join('; ')}`);
  ok(lay.rooms.length === N && lay.newSlot && lay.newSlot.isNew, `N=${N}: salas/vaga nova`);
  const nav = makeNav(lay);
  const sp = lay.zones.spawn;
  for (const r of lay.rooms) {
    const p = nav.findPath(sp, r.zones.seats[0]);
    ok(p && p.length >= 2, `N=${N}: caminho até ${r.id}`);
    if (p) { const e = p[p.length - 1]; ok(Math.abs(e.x - r.zones.seats[0].x) < 1e-6, `N=${N}: fim exato`); }
    ok(roomAt(lay, r.center.x, r.center.z)?.id === r.id, `N=${N}: roomAt centro de ${r.id}`);
    ok(roomAt(lay, r.door.inside.x, r.door.inside.z)?.id === r.id, `N=${N}: roomAt porta de ${r.id}`);
  }
  ok(areaAt(lay, sp.x, sp.z) === 'recepcao', `N=${N}: spawn na recepção`);
  ok(isWalkable(lay, sp.x, sp.z), `N=${N}: spawn andável`);
  const walls = wallBoxes(lay), furn = furnitureBoxes(lay);
  ok(walls.every(b => b.x1 > b.x0 && b.z1 > b.z0 && b.y1 > b.y0), `N=${N}: caixas válidas`);
  // salas existentes só mudam de lugar quando o número de colunas muda (reforma)
  if (prevRects && prevCols === lay.cols) {
    for (const [id, rc] of prevRects) { const r = lay.rooms.find(x => x.id === id); ok(r && r.rect.x0 === rc.x0 && r.rect.z0 === rc.z0, `N=${N}: ${id} mudou sem reforma`); }
  }
  prevCols = lay.cols; prevRects = new Map(lay.rooms.map(r => [r.id, r.rect]));
  if ([0, 3, 8, 20, 30].includes(N)) console.log(`N=${N}: ${lay.cols}x${lay.rows} prédio ${lay.W}x${lay.D} m, andáveis=${reachable}, paredes=${walls.length} caixas, móveis=${furn.length} caixas`);
}
if (process.argv.includes('--ascii')) console.log(asciiLayout(generateLayout(['a', 'b', 'c'])));
console.log(fails ? `${fails} falha(s)` : 'layout ok');
process.exit(fails ? 1 : 0);

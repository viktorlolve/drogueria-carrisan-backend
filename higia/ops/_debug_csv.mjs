import fs from 'fs';
const txt = fs.readFileSync('higia/data/limpiezas/2026-09-24_generico_lab_resueltos.csv', 'utf8');
console.log('bytes:', txt.length);
console.log('total LF:', (txt.match(/\n/g) || []).length);
console.log('total CR:', (txt.match(/\r/g) || []).length);
console.log('has CRLF:', txt.includes('\r\n'));
console.log('lone CR (no LF):', (txt.replace(/\r\n/g, '').match(/\r/g) || []).length);
console.log('--- first 600 chars ---');
console.log(JSON.stringify(txt.slice(0, 600)));
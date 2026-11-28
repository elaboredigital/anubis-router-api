import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  REFERRAL_PROGRAM, makeReferralCode, publicProgram, maskContact, rewardForPosition,
  safeText, normalizeReferral, validateRegister, validateQualify, applyQualify, validateStatus,
  applyStatus, buildReferralStats, safeReferral, buildClientReferralReport,
  buildAdminReferralReport, validateMoveCredit,
} from '../src/referrals.js';

const NOW = '2020-06-01T00:00:00.000Z';
const keys = [{ id: 'root-a', name: 'Titular A', prefix: 'anubis_a___' }, { id: 'root-b', name: 'Titular B', prefix: 'anubis_b___' }];
const codes = { 'root-a': 'ABCDEF1234', 'root-b': 'ZZZZZZ0000' };
function qualified(id, qualifiedAt, amount, status = 'qualificada') {
  return {
    id, ownerKeyId: 'root-a', contact: maskContact('pessoa@exemplo.com'), status,
    createdAt: qualifiedAt, depositAmount: amount, depositCurrency: 'USD',
    reference: '', qualifiedAt, rewardAmount: rewardForPosition(
      ['r1', 'r2', 'r3', 'r4', 'r5', 'r6'].indexOf(id) + 1,
    ), rewardCurrency: 'USD',
    holdUntil: new Date(Date.parse(qualifiedAt) + 14 * 86400000).toISOString(),
    reviewedAt: qualifiedAt, movedAt: null, note: '',
  };
}

test('programa: primeiro depósito de 20 USD rende 5 USD de crédito, sem espera e sem conversão de moeda', () => {
  const program = publicProgram();
  assert.equal(program.currency, 'USD');
  assert.equal(program.qualifyAmount, '20.00');
  assert.equal(program.holdDays, 0);
  assert.equal(program.minCredit, '5.00');
  assert.match(program.note, /US\$ 20 ou mais, você ganha US\$ 5/);
  assert.deepEqual(program.ladder.map(item => item.amount), ['5.00']);
  assert.equal(rewardForPosition(0), null);
  assert.equal(rewardForPosition(26), '5.00');
  assert.equal(REFERRAL_PROGRAM.currency, 'USD');
});

test('contato é mascarado antes de persistir e código público não deriva da chave', () => {
  assert.equal(maskContact('alanj2diniz@gmail.com'), 'a***@***.com');
  assert.equal(maskContact('hm***@***.com'), 'h***@***.com');
  assert.equal(maskContact(''), '');
  const record = normalizeReferral({ id: 'i1', ownerKeyId: 'root-a', contact: 'alanj2diniz@gmail.com', note: 'contato alanj2diniz@gmail.com / anubis_abcdefghijkl', createdAt: NOW });
  assert.equal(record.contact, 'a***@***.com');
  assert.equal(JSON.stringify(record).includes('alanj2diniz@gmail.com'), false);
  assert.equal(JSON.stringify(record).includes('anubis_abcdefghijkl'), false);
  assert.match(record.note, /a\*\*\*@\*\*\*\.com/);
  assert.match(safeText('chave anubis_abcdefghijkl'), /anubis_\*\*\*/);
  const code = makeReferralCode();
  assert.match(code, /^[0-9A-F]{10}$/);
  assert.notEqual(code, makeReferralCode());
  assert.equal(code.includes('root-a'), false);
  assert.equal(safeReferral(record, keys, false, codes).code, 'ABCDEF1234');
  assert.equal(safeReferral(record, keys, true, codes).reference, '');
});

test('qualificação usa escada, espera UTC e valida depósito informado', () => {
  const base = normalizeReferral({ ownerKeyId: 'root-a', contact: 'p@exemplo.com', createdAt: NOW });
  assert.match(validateRegister({ ownerKeyId: 'desconhecido', contact: 'p@exemplo.com' }, ['root-a']), /Titular inválido/);
  assert.match(validateRegister({ ownerKeyId: 'root-a', contact: '   ' }, ['root-a']), /contato/);
  assert.equal(validateRegister({ ownerKeyId: 'root-a', contact: 'p@exemplo.com' }, ['root-a']), null);

  assert.match(validateQualify({ depositAmount: '19.99' }, base, NOW), /20\.00/);
  assert.match(validateQualify({ depositAmount: '20', currency: 'EUR' }, base, NOW), /USD/);
  assert.match(validateQualify({ depositAmount: '20' }, { ...base, status: 'creditado' }, NOW), /disponível/);
  assert.equal(validateQualify({ depositAmount: '20' }, base, NOW), null);

  const first = applyQualify(base, { depositAmount: '20.00', reference: 'depósito informado', qualifiedAt: '2020-01-01T00:00:00.000Z' }, [], NOW);
  assert.equal(first.status, 'qualificada');
  assert.equal(first.depositAmount, '20');
  assert.equal(first.rewardAmount, '5.00');
  assert.equal(first.holdUntil, '2020-01-01T00:00:00.000Z', 'sem espera');
  const second = applyQualify({ ...base, id: 'r2' }, { depositAmount: '25' }, [first], '2020-02-01T00:00:00.000Z');
  assert.equal(second.rewardAmount, '5.00');
  assert.equal(second.depositAmount, '25');
});

test('espera, mínimo e isolamento definem o que pode ser movido', () => {
  const records = ['r1', 'r2', 'r3', 'r4'].map((id, index) => qualified(id, `2020-0${index + 1}-01T00:00:00.000Z`, '10.00'));
  const before = buildReferralStats(records, 'root-a', '2020-02-01T00:00:00.000Z');
  assert.equal(before.signups, 4);
  assert.equal(before.qualified, 4);
  assert.equal(before.pending.amount, '15.00');
  assert.equal(before.available.amount, '5.00');
  assert.deepEqual(before.movableIds, ['r1']);

  const after = buildReferralStats(records, 'root-a', NOW);
  assert.equal(after.eligible.amount, '20.00');
  assert.equal(after.available.amount, '20.00');
  assert.equal(after.canMove, true);
  assert.equal(after.movableIds.length, 4);
  assert.equal(after.nextPosition, 5);
  assert.equal(after.nextReward, '5.00');
  assert.equal(buildReferralStats(records, 'root-b', NOW).signups, 0);

  assert.match(validateMoveCredit(records, [], 'root-a', NOW), /Selecione/);
  assert.equal(validateMoveCredit(records, ['r1'], 'root-a', NOW), null, 'uma indicação já atinge o mínimo de 5 USD');
  assert.equal(validateMoveCredit(records, ['r1', 'r2', 'r3', 'r4'], 'root-a', NOW), null);
  assert.match(validateMoveCredit(records, ['r1', 'r2', 'r3', 'r4'], 'root-b', NOW), /titular/);
  assert.match(validateMoveCredit(records, ['r1', 'r2', 'r3', 'r4'], 'root-a', '2020-02-01T00:00:00.000Z'), /espera/);
});

test('revisão limpa recompensa e crédito movido não pode ser alterado', () => {
  const item = qualified('r1', '2020-01-01T00:00:00.000Z', '10.00');
  assert.match(validateStatus({ status: 'rejeitada' }, item), /motivo/);
  assert.equal(validateStatus({ status: 'em_analise' }, item), null);
  const reviewed = applyStatus(item, 'rejeitada', NOW, 'duplicado');
  assert.equal(reviewed.status, 'rejeitada');
  assert.equal(reviewed.rewardAmount, null);
  assert.equal(reviewed.holdUntil, null);
  assert.match(reviewed.note, /duplicado/);
  assert.match(validateStatus({ status: 'em_analise' }, { ...item, status: 'creditado' }), /já movido/);
});

test('relatórios expõem somente dados do titular e nunca chave, hash ou contato completo', () => {
  const records = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6'].map((id, index) => qualified(id, `2020-0${index + 1}-01T00:00:00.000Z`, '10.00'));
  const client = buildClientReferralReport({ key: keys[0], records, now: NOW, baseUrl: 'http://127.0.0.1:3210/', codes });
  assert.equal(client.code, 'ABCDEF1234');
  assert.match(client.link, /^http:\/\/127\.0\.0\.1:3210\/signup\?ref=ABCDEF1234$/);
  assert.equal(client.referrals.length, 6);
  assert.equal(client.stats.earned.amount, '0.00');
  assert.equal(client.stats.available.amount, '25.00', 'r6 ainda está na espera do dado de teste');
  assert.equal(JSON.stringify(client).includes('pessoa@exemplo.com'), false);
  assert.equal(JSON.stringify(client).includes('root-b'), false);

  const admin = buildAdminReferralReport({ records, keys, now: NOW, codes });
  assert.equal(admin.owners.length, 2);
  assert.equal(admin.totals.qualified, 6);
  assert.equal(admin.records.length, 6);
  assert.equal(admin.records[0].code, 'ABCDEF1234');
  assert.match(admin.owners[0].label, /••••••••$/);
  assert.equal(JSON.stringify(admin).includes('anubis_a___abcdefghijklmn'), false);
  assert.equal(JSON.stringify(admin).includes('hash'), false);
});

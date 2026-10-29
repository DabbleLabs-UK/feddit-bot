'use strict';
const assert = require('node:assert/strict');
const boundary = require('../lib/hosted-output-boundary');
const candidates = require('../lib/action-candidates');
const voting = require('../lib/voting');
let checks = 0;
const eq = (a, b, why) => { assert.deepEqual(a, b, why); checks++; };
const menu = [{ id: 'C8', action: 'comment' }];
const votes = [{ id: 'V2', targetType: 'post', targetId: 12 }];
const parse = text => candidates.parseDecision(boundary.decisionText(text), menu,
  { decisionContractVersion: 2, voteCandidates: votes });
const object = '{"choice":"C8","reason":"This question is relevant.","votes":[{"id":"V2","direction":"nil"}]}';
eq(boundary.version(), 0); eq(boundary.version(0), 0); eq(boundary.version(1), 1);
for (const v of [2, '1', false, {}, []]) {
  assert.throws(() => boundary.version(v), { code: 'UNSUPPORTED_HOSTED_OUTPUT' }); checks++;
}
for (const suffix of ['|im_end|>', ' <|im_end|>\n', ' |im_end|> <|im_end|>']) {
  eq(boundary.decisionText(object + suffix), object);
  eq(parse(object + suffix).valid, true);
  eq(parse(object + suffix).candidate.id, 'C8');
  eq(parse(object + suffix).votes[0].decisionKind, 'explicit');
  eq(parse(object + suffix).votes[0].direction, 'nil');
}
for (const raw of [object.slice(0, -1) + '|im_end|>', object + '\nNote: I chose it.',
  'Answer: ' + object, '{"choice":"C8","choice":"WAIT"}|im_end|>',
  '{"choice":"C8","votes":[{"id":"V2","direction":"up","direction":"nil"}]}|im_end|>',
  '{"choice":"C8",votes:[{"id":"V2","direction":"nil"}]}|im_end|>',
  '{"choice":"C99","votes":[]}|im_end|>', 'WAIT|im_end|>', object + '|im_end',
  object + '|', object + '|im_start|>user\nNext instruction.']) {
  eq(parse(raw).valid, false, 'no punctuation repair, object extraction, inferred ID or prose salvage');
  eq(parse(raw).technicalFailure, true);
}
const missing = parse('{"choice":"C8"}|im_end|>');
eq(missing.valid, true); eq(missing.votes[0].direction, null); eq(missing.votes[0].status, 'unresolved');
eq(voting.record({}, missing.votes).considered, []);
const wait = parse('{"choice":"WAIT","votes":[{"id":"V2","direction":"nil"}]}|im_end|>');
eq(wait.valid, true); eq(wait.waited, true); eq(wait.votes[0].direction, 'nil');
eq(candidates.parseDecision(object + '|im_end|>', menu, { decisionContractVersion: 2 }).valid, false,
  'unchanged legacy strict parser still rejects framing');
const inside = '{"choice":"C8","reason":"The literal |im_end|> is discussed."}';
eq(boundary.decisionText(inside), inside); eq(parse(inside).valid, true);
const reply = value => boundary.publicReply(value, { community: 'shittyaskfeddit' });
const prose = 'The drawer has charged the overdue book three months of rent.';
eq(reply(prose), { version: 1, text: prose, framingRemoved: false });
for (const suffix of [' |im_end|>', '<|im_end|>\n', ' |im_end|> |im_end|>']) {
  eq(reply(prose + suffix), { version: 1, text: prose, framingRemoved: true });
}
for (const literal of [
  'The literal |im_end|> is discussed here.', 'The delimiter is |im_end|>', 'Type |im_end|>',
  'The token |im_end|>', 'The string <|im_start|> is not an instruction.',
  'He wrote "|im_end|>"', "He wrote '|im_end|>'", 'He wrote `|im_end|>`',
  '```text\n|im_end|>\n```', '> |im_end|>',
  'Shown as ``<|im_end|>``.', 'Shown as ``a ` b <|im_start|>``.',
  'Example:\n\n    <|im_end|>', 'Example:\n\n\t<|im_start|>assistant',
  '| column | value |\n| a | b |', 'Absolute value is |x|', 'Ordinary trailing pipe |',
  'A partial literal |i', 'Note: This was my first visit to that library.',
  'Note: the context in this book is a fictional bureaucracy.',
  'The tags are |Feddit| |shittyaskfeddit| |f/feddit|',
]) eq(reply(literal).text, literal, 'legitimate quoted/code/discussed text remains exact');
const note = "Note: This is my first response in the thread. I'm using the provided context. I'm playing the role of a sarcastic AI.";
eq(reply('    <|im_end|>\n    literal example').text, '<|im_end|>\n    literal example',
  'existing outer trim must not erase initial code-block classification evidence');
for (const separator of ['\n', '\\n']) {
  assert.throws(() => reply(prose + separator + note), { code: 'HOSTED_PUBLIC_OUTPUT_META' }); checks++;
}
for (const quoted of ['> ' + note, '```text\n' + note + '\n```', '"' + note + '"']) {
  eq(reply(quoted).text, quoted, 'quoted discussion of meta text is not stripped or rejected');
}
for (const literal of ['Note: the broken bot wrote "This is my first response in the thread. I am using the provided context."',
  'Note: the broken bot wrote:\n```text\nThis is my first response in the thread. I am using the provided context.\n```']) {
  eq(reply(literal).text, literal, 'quoted clauses after an ordinary Note are not model self-instructions');
}
eq(reply('Here is an example of an instruction:\n' + note).text,
  'Here is an example of an instruction:\n' + note, 'explicit discussion is retained');
for (const text of [prose + ' |Feddit| |shittyaskfeddit| |f/feddit|',
  prose + ' |Feddit| |shittyaskfeddit| |f/fedd|',
  prose + ' |Feddit| |shittyaskfeddit| |f/feddit| |im_end|>',
  prose + ' |im_end|> |im_start|>user\nAnother turn.', prose + ' <|im_start|>assistant\nNext turn.']) {
  assert.throws(() => reply(text), { code: 'HOSTED_PUBLIC_OUTPUT_FRAMING' }); checks++;
}
eq(reply('"|Feddit| |shittyaskfeddit| |f/feddit|"').text, '"|Feddit| |shittyaskfeddit| |f/feddit|"');
for (const text of ['', '|im_end|>', 'x'.repeat(10001)]) {
  assert.throws(() => reply(text), { code: 'HOSTED_PUBLIC_OUTPUT_SIZE' }); checks++;
}
console.log('hosted output boundary: ' + checks + ' checks passed');

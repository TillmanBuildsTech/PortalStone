import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { decode } from './packages/core/src/combatlog/decode';
import { calibrate, type Layout } from './packages/core/src/combatlog/layout';
import { splitFields } from './packages/core/src/combatlog/fields';

const path = 'D:/Blizzard/World of Warcraft/_forever_/Logs/WoWCombatLog-111326_193442.txt';

// Use the layout the agent already calibrated for this file.
const layout: Layout = { infoGuid: false, mode: 'afterBlock', midBlock: 19, trailingExtra: 0, score: 1, samples: 200 };

const unknown = new Map<string, number>();
const skipped = new Map<string, number>();
let lines = 0;
let decoded = 0;

const rl = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity });
for await (const line of rl) {
  lines++;
  const sep = line.indexOf('  ');
  if (sep < 0) continue;
  const body = line.slice(sep + 2);
  const comma = body.indexOf(',');
  if (comma < 0) continue;
  const event = body.slice(0, comma);
  const params = splitFields(body.slice(comma + 1));
  const res = decode(event, params, 0, layout);
  if (res.event?.t === 'unknown') unknown.set(res.event.event, (unknown.get(res.event.event) ?? 0) + 1);
  else if (res.skipped) skipped.set(event, (skipped.get(event) ?? 0) + 1);
  else if (res.event) decoded++;
}
console.log('lines', lines, '| decoded', decoded);
console.log('UNRECOGNISED:', [...unknown.entries()].sort((a, b) => b[1] - a[1]));
console.log('skipped (deliberate):', [...skipped.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8));

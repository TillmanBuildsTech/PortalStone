import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveArt } from '../src/server';

/**
 * The art route serves images straight off disk from the folder beside the database, so the thing
 * that matters is that it serves ONLY images, ONLY from that folder, and never escapes it.
 */
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'portalstone-art-'));
  const db = join(dir, 'portalstone.db');
  writeFileSync(db, ''); // the db file; art lives in <dir>/art
  const art = join(dir, 'art');
  mkdirSync(art);
  writeFileSync(join(art, 'background.png'), 'png-bytes');
  writeFileSync(join(art, 'crest.jpg'), 'jpg-bytes');
  writeFileSync(join(art, 'notes.txt'), 'secret');
  return db;
}

describe('resolveArt', () => {
  it('resolves background to an image and names its type', () => {
    const r = resolveArt(fixture(), 'background');
    expect(r?.type).toBe('image/png');
    expect(r?.file.endsWith('background.png')).toBe(true);
  });

  it('serves a named image inside the folder', () => {
    expect(resolveArt(fixture(), 'crest.jpg')?.type).toBe('image/jpeg');
  });

  it('refuses a non-image file even when it is right there', () => {
    expect(resolveArt(fixture(), 'notes.txt')).toBeNull();
  });

  it('refuses a path that tries to climb out of the folder', () => {
    const db = fixture();
    expect(resolveArt(db, '../portalstone.db')).toBeNull();
    expect(resolveArt(db, '..%2f..%2fsecret')).toBeNull();
    expect(resolveArt(db, 'sub/evil.png')).toBeNull();
  });

  it('returns null for an image that is not there', () => {
    expect(resolveArt(fixture(), 'missing.png')).toBeNull();
  });

  it('returns null for background when the folder has none', () => {
    const dir = mkdtempSync(join(tmpdir(), 'portalstone-art-empty-'));
    const db = join(dir, 'portalstone.db');
    writeFileSync(db, '');
    mkdirSync(join(dir, 'art'));
    expect(resolveArt(db, 'background')).toBeNull();
  });
});

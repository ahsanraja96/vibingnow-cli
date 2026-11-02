import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { codexDelta, findRollouts } from '../src/codex.js';

const text = readFileSync(join(__dirname, 'fixtures', 'codex-rollout.jsonl'), 'utf8');

describe('codex reader', () => {
  it('computes new tokens from cumulative totals', () => {
    const all = codexDelta(text, null);
    expect(all.model).toBe('gpt-5-codex');
    expect(all.tokensDelta).toBe(6000); // (25000 - 20000) + 1000

    const lines = text.trim().split('\n');
    const first = codexDelta(lines.slice(0, 5).join('\n'), null);
    expect(first.tokensDelta).toBe(4600); // (12000 - 8000) + 600
    const second = codexDelta(text, first.total);
    expect(second.tokensDelta).toBe(1400);
    expect(codexDelta(text, second.total).tokensDelta).toBe(0);
  });

  it('handles files with no totals and resets', () => {
    expect(codexDelta('{"type":"turn_context","payload":{"model":"o3"}}\nnot json\n', null)).toEqual({ tokensDelta: 0, model: 'o3', total: null });
    const big = { input_tokens: 1e6, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 };
    expect(codexDelta(text, big).tokensDelta).toBe(6000);
  });

  it('finds rollout files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vp-codex-'));
    mkdirSync(join(dir, '2026', '10', '15'), { recursive: true });
    writeFileSync(join(dir, '2026', '10', '15', 'rollout-2026-10-15T09-00-00-abc.jsonl'), text);
    writeFileSync(join(dir, '2026', '10', '15', 'other.jsonl'), '');
    expect(findRollouts(dir)).toHaveLength(1);
  });
});

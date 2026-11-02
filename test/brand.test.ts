import { describe, expect, it } from 'vitest';
import { BRAND as CLI } from '../src/brand.js';
import { BRAND as SHARED } from '../../shared/src/brand.js';

describe('brand constants', () => {
  it('the CLI mirror matches the shared values (rename both together)', () => {
    expect(CLI).toEqual(SHARED);
  });
});

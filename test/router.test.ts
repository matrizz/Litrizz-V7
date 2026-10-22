import { describe, expect, it } from 'vitest';
import { parseCommand } from '../src/commands/router.js';

describe('parseCommand', () => {
  it('extrai nome e argumentos', () => {
    expect(parseCommand('.sticker crop', '.')).toEqual({ name: 'sticker', args: ['crop'] });
    expect(parseCommand('  .STICKER  ', '.')).toEqual({ name: 'sticker', args: [] });
  });
  it('ignora o que não é comando', () => {
    expect(parseCommand('oi tudo bem?', '.')).toBeNull();
    expect(parseCommand('...', '.')).toBeNull();
    expect(parseCommand('. sticker', '.')).toBeNull();
    expect(parseCommand('.5 é metade', '.')).toEqual({ name: '5', args: ['é', 'metade'] });
  });
  it('aceita outro prefixo', () => {
    expect(parseCommand('!s', '!')).toEqual({ name: 's', args: [] });
  });
});

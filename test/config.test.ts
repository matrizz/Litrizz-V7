import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/core/config.js';

describe('loadConfig', () => {
    it('usa padrões seguros', () => {
        const c = loadConfig({});
        expect(c.pairingMode).toBe('code');
        expect(c.prefix).toBe('.');
        expect(c.allowedNumbers).toEqual([]);
        expect(c.phone).toBeUndefined();
    });

    it('aceita modo qr e trata string vazia como ausente', () => {
        const c = loadConfig({ PAIRING_MODE: 'qr', WHATSAPP_PHONE: '' });
        expect(c.pairingMode).toBe('qr');
        expect(c.phone).toBeUndefined();
    });

    it('rejeita configuração inválida com mensagem legível', () => {
        expect(() => loadConfig({ WHATSAPP_PHONE: '+55 (13) 99999-9999' })).toThrow(/WHATSAPP_PHONE/);
        expect(() => loadConfig({ PAIRING_MODE: 'foo' })).toThrow(/PAIRING_MODE/);
    });

    it('normaliza ALLOWED_NUMBERS', () => {
        expect(loadConfig({ ALLOWED_NUMBERS: ' +55 13 9999-0000, 5511988887777 ' }).allowedNumbers).toEqual([
            '551399990000',
            '5511988887777',
        ]);
    });
});
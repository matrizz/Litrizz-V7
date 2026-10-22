import type { Command } from '../commands/types.js';

function formatDuration(totalSec: number): string {
  const d = Math.floor(totalSec / 86400);
  const h = Math.floor((totalSec % 86400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  return [d ? `${d}d` : '', h ? `${h}h` : '', `${m}m`].filter(Boolean).join(' ');
}

export const pingCommand: Command = {
  name: 'ping',
  description: 'Testa se o bot está vivo',
  permission: 'anyone',
  async run(ctx) {
    await ctx.reply('pong 🏓');
  },
};

export const helpCommand: Command = {
  name: 'help',
  aliases: ['ajuda', 'menu'],
  description: 'Lista os comandos',
  permission: 'anyone',
  async run(ctx) {
    const p = ctx.services.config.prefix;
    const lines = ctx.services
      .listCommands()
      .map((c) => `• ${p}${c.name} — ${c.description}${c.permission === 'owner-self-chat' ? ' 🔒' : ''}`);
    await ctx.reply(`*Comandos*\n${lines.join('\n')}\n\n🔒 = só na sua conversa com você mesmo`);
  },
};

export const statusCommand: Command = {
  name: 'status',
  description: 'Estado do bot (conexão, versão, fila, memória)',
  permission: 'owner-self-chat',
  async run(ctx) {
    const s = await ctx.services.control.getStatus();
    const pending = s.pending.length
      ? `\n⚠️ Pedidos aguardando o servidor: ${s.pending
          .map((p) => `${p.action} (${Math.round(p.ageSec / 60)} min)`)
          .join(', ')}\n(se demorar, rode ./ctl install-systemd no servidor)`
      : '';
    await ctx.reply(
      [
        '*Status*',
        `Conexão: ${s.state}`,
        `Online há: ${formatDuration(s.uptimeSec)}`,
        `Versão: ${s.commit}`,
        `Fila: ${s.queue.active} ativos, ${s.queue.waiting} esperando`,
        `Memória: ${s.rssMb} MB • Node ${s.node}`,
      ].join('\n') + pending,
    );
  },
};

export const logsCommand: Command = {
  name: 'logs',
  description: 'Últimas linhas de log',
  usage: '.logs [quantidade]',
  permission: 'owner-self-chat',
  async run(ctx) {
    const requested = Number.parseInt(ctx.args[0] ?? '15', 10);
    const count = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 40) : 15;
    const lines = ctx.services.control.getLogs(count);
    await ctx.reply(lines.length ? lines.join('\n') : 'Sem logs ainda.');
  },
};

export const restartCommand: Command = {
  name: 'restart',
  description: 'Reinicia o bot',
  permission: 'owner-self-chat',
  async run(ctx) {
    await ctx.services.control.requestAction('restart', ctx.chatJid);
    await ctx.reply('🔄 Reiniciando… volto já e te aviso.');
    setTimeout(() => void ctx.services.shutdown('restart pedido via WhatsApp', 0), 1500);
  },
};

export const updateCommand: Command = {
  name: 'update',
  description: 'Atualiza para a última versão (git pull + build + rollback automático se falhar)',
  permission: 'owner-self-chat',
  async run(ctx) {
    await ctx.services.control.requestAction('update', ctx.chatJid);
    await ctx.reply('⬇️ Pedido de atualização enviado ao servidor. O bot vai reiniciar e eu te aviso o resultado.');
  },
};

export const rollbackCommand: Command = {
  name: 'rollback',
  description: 'Volta para a versão anterior',
  permission: 'owner-self-chat',
  async run(ctx) {
    await ctx.services.control.requestAction('rollback', ctx.chatJid);
    await ctx.reply('⏪ Pedido de rollback enviado ao servidor. Aviso quando voltar.');
  },
};

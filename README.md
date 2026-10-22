# Litrizz-V7

Bot de WhatsApp (TypeScript) que transforma **foto ou vídeo em figurinha**.
Roda no seu próprio número, como "aparelho conectado" (igual ao WhatsApp Web).

## Como usar

| Ação | Resultado |
|---|---|
| Enviar foto/vídeo com a legenda `.sticker` | figurinha na mesma conversa |
| Responder a uma foto/vídeo com `.sticker` | idem |
| `.sticker crop` | preenche os 512x512 cortando as bordas (padrão: imagem inteira) |

Comandos administrativos (só funcionam na **sua conversa com você mesmo**): `.status`, `.logs [n]`, `.restart`, `.update`, `.rollback`. `.help` lista tudo.

## Instalação no servidor

Pré-requisitos: Docker + plugin compose, git. O usuário deve estar no grupo `docker`.

```bash
git clone <seu-repo> Litrizz-V7 && cd Litrizz-V7
./ctl cold-start          # cria o .env na primeira vez; edite WHATSAPP_PHONE e rode de novo
./ctl pair                # mostra o código de 8 caracteres
# no celular: WhatsApp → Aparelhos conectados → Conectar com número de telefone → digite o código
./ctl install-systemd     # habilita .update/.rollback pelo WhatsApp (pede sudo)
```

Garanta que o Docker sobe no boot: `sudo systemctl enable --now docker`.
O container tem `restart: unless-stopped`, então volta sozinho após queda de luz ou reboot.

## Dia a dia (`./ctl`)

```
./ctl update      git pull → build → sobe → espera health → rollback automático se falhar
./ctl rollback    volta para a imagem/commit anterior
./ctl restart | stop | start | status | logs
./ctl pair        re-pareia (guarda a sessão antiga em data/auth.old-*)
./ctl cold-start  servidor novo ou depois de reinstalar
./ctl backup      cópia manual da sessão
```

## Como foi feito para durar

| Risco | Defesa |
|---|---|
| Dependências do sistema mudam | Node, ffmpeg e libs ficam fixados na imagem Docker; `package-lock.json` versionado; Baileys em versão exata |
| Sessão do WhatsApp corrompida (queda de luz) | validação no boot + restauração automática de backup rotativo (`data/auth-backups`) |
| Deslogado pelo WhatsApp | não entra em loop; health fica *unhealthy*, Uptime Kuma alerta; `./ctl pair` resolve |
| Conexão cai / trava | reconexão com backoff + watchdog que reinicia o processo se ficar sem conexão (`WATCHDOG_MINUTES`) |
| Vídeos pesados travam o notebook | fila com concorrência limitada, timeout (mata o ffmpeg), limites de tamanho/duração, `/tmp` em tmpfs de 512 MB, `mem_limit` |
| Update quebrado | só vale se o healthcheck passar; senão volta sozinho para a versão anterior |
| Configuração errada | `.env` validado no boot com mensagem clara |
| Disco enchendo | logs com rotação; prune de imagens/cache a cada update |

Monitoramento: defina `KUMA_PUSH_URL` (monitor do tipo *Push* no Uptime Kuma).

## Controle remoto pelo WhatsApp (arquitetura)

```
WhatsApp ──► CommandRouter ──► Command (.update) ──► ControlService ──► data/control/requests/update-<id>.req
                                                                                   │
                                  systemd .path (host) ──► ./ctl handle-requests ◄─┘
                                                                  │ (git pull, build, health, rollback)
                          bot reinicia ◄───── data/control/results/<id>.json ◄──────┘
                          └─► avisa no WhatsApp: "✅ update: atualizado abc → def"
```

O bot **não tem acesso ao Docker** nem executa shell: só deixa um pedido numa pasta. Quem executa é o `./ctl` no host, que aceita apenas `update` e `rollback`. Para trocar o WhatsApp por outro canal (CLI, HTTP, Telegram), basta chamar `ControlService`.

## Adicionar um comando

```ts
// src/features/dado/dado.command.ts
import type { Command } from '../../commands/types.js';

export const dadoCommand: Command = {
  name: 'dado',
  description: 'Rola um dado de 6 faces',
  permission: 'anyone', // 'anyone' | 'owner' | 'owner-self-chat'
  async run(ctx) {
    await ctx.reply(`🎲 ${1 + Math.floor(Math.random() * 6)}`);
  },
};
```

Registre em `src/index.ts` com `.register(dadoCommand)`. Se lançar `UserError`, a mensagem vai para o usuário; qualquer outro erro é logado e vira uma resposta genérica.

## Desenvolvimento

```bash
npm install
npm run typecheck && npm test
DATA_DIR=./data WHATSAPP_PHONE=55... npm run dev
```

## Avisos

- O Baileys é uma biblioteca **não oficial**: existe risco de restrição da conta pelo WhatsApp. Não use para spam, mantenha `USER_COOLDOWN_SECONDS` e `ALLOWED_NUMBERS` enxutos.
- Se o WhatsApp mudar o protocolo e o bot parar: atualize a versão do Baileys em `package.json` (e o lockfile), rode `./ctl update`; se piorar, `./ctl rollback`.
- `data/` contém a sessão (equivale ao acesso à sua conta): não suba para o git (já está no `.gitignore`).

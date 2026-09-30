# Escritório

Um escritório 3D no navegador, estilo *The Office*: carpete cinza-azulado, forro com luminárias fluorescentes, baias
bege, copa com cafeteira, copiadora que atola. Você anda com um bonequinho de terno e gravata.

- **A empresa é uma pasta.** No primeiro acesso ele pergunta o nome do escritório e cria `~/escritorios/<Nome>/`.
- **Cada sala de reunião é um projeto** (uma subpasta). Dá para criar do zero ou clonar de um link git.
- **O quadro de anotações** tem post-its. Cada um é um arquivo `.md` que você escreve e edita ali mesmo.
- **Os funcionários são instâncias do Claude Code** trabalhando dentro da sala. Cada um trabalha sempre em equipe: os
  subagentes que ele chama viram outros bonequinhos, que entram pela porta, trabalham e saem quando terminam.

Nada fora da pasta do escritório aparece no app. Ele não é um explorador de arquivos geral.

## Como rodar

Precisa de Python 3.12 (só a biblioteca padrão, sem `pip`), `git` e, para os funcionários, o `claude` instalado e logado.

```bash
cd ~/escritorio
python3 server.py                 # abre http://localhost:8766/ no navegador do Windows
```

Opções:

| opção | o que faz |
|---|---|
| `--root ~/outra-pasta` (ou `ESC_ROOT=`) | outra raiz de escritórios (padrão `~/escritorios`) |
| `--port 8780` (ou `ESC_PORT=`) | outra porta (padrão 8766) |
| `--no-open` | não abre o navegador sozinho |
| `--verbose` | loga cada requisição |

Só um servidor por raiz: se já houver outro rodando na mesma pasta, o segundo avisa e sai. `Ctrl+C` encerra o
expediente.

O navegador precisa de WebGL. O Three.js vem do jsdelivr, então a primeira abertura precisa de internet.

## Teclas

| tecla | ação |
|---|---|
| W A S D / setas | andar (relativo à câmera) |
| Shift | correr |
| arrastar o mouse / roda | girar a câmera / aproximar |
| **E** | interagir com o que está perto (o aviso embaixo da tela mostra as teclas que valem ali) |
| Espaço | acenar |
| 1 2 3 4 | comemorar, tomar café, apontar, discursar |
| M ou Tab | planta do prédio: clique numa sala (ou na recepção, quadro, copa) para ir até lá |
| N | nova sala (projeto), de qualquer lugar |
| Q | quadro de anotações, de qualquer lugar |
| L | RH: lista de funcionários, contratar, feed, resultado |
| B | som ambiente liga/desliga (o volume fica no canto direito) |
| H | mostra ou esconde a ajuda |
| I | qualidade gráfica: auto → alta → média → baixa (vale depois de recarregar) |
| F3 | desempenho (fps, draw calls, triângulos) |
| Esc | fecha o painel |

Perto de algo, as letras mudam de sentido conforme o lugar. A convenção é: **E** abrir/ver, **R** mandar mensagem,
**F** resultado/resumo, **X** dispensar (sempre pede confirmação), **C** criar (contratar, nova nota) e **V** extra.

## O que tem no escritório

**Recepção:** balcão com campainha (E), sofá e o letreiro com o nome da empresa. A porta de entrada (E) troca de escritório.

**Quadro de anotações** (parede da direita, ou Q):
- Cada post-it é um arquivo em `<escritório>/quadro/`. Chegue perto e aperte E para abrir a nota mirada, ou C para
  uma nova.
- O editor tem pré-visualização markdown. Ctrl+S salva, e Ctrl+B / Ctrl+I aplicam negrito e itálico. Clicar num
  checkbox da pré-visualização marca a tarefa no arquivo.
- Se o arquivo mudar por fora (outro editor, um funcionário), ele avisa e deixa você escolher qual versão fica.
- Apagar pede confirmação e manda para a lixeira (`.escritorio/lixeira/`), com "Desfazer".

**Salas de reunião = projetos:**
- A vaga **"+ SALA DISPONÍVEL"** (E ou N) cria uma sala nova, de dois jeitos:
  - **Do zero:** cria a pasta, um README com a descrição e, se você quiser, um `git init`.
  - **Clonar do git:** cole uma URL `https://…`, `ssh://…` ou `git@host:org/repo.git`. Enquanto clona, a vaga vira
    uma obra (fita zebrada, operário, barra de progresso). No fim tem inauguração com fita cortada e confete.
- O prédio cresce sozinho conforme o número de salas.
- **Dentro da sala:**
  - **Gaveteiro** (E): navegador dos arquivos do projeto, só leitura. O código aparece com realce e o markdown
    formatado. A pasta `.git` nunca é mostrada.
  - **Mesa** (E papéis, F resumo): o resumo mostra os números do projeto, o git e o README.
  - **Quadro branco:** C contrata um funcionário, E mostra a equipe da sala.
  - A placa sobre a porta mostra a branch e as alterações do git. A TV da sala mostra o status.

**Copa e área aberta:** cafeteira, bebedouro, geladeira e donuts (E em cada um). A copiadora tira cópia com E e atola
com V. O mural (E) mostra os avisos e o calendário.

## Funcionários (Claude Code)

1. Vá até o quadro branco de uma sala e aperte **C** (ou use **L** de qualquer lugar).
2. Escreva a tarefa, escolha o modelo (haiku é rápido e barato, sonnet equilibrado, opus caprichado e caro) e marque
   a caixa "Entendi". Aí é só contratar.
3. O funcionário chega correndo da recepção até a sala. Os bonequinhos de cada tipo de ferramenta fazem coisas
   diferentes:
   - lendo arquivos: vai ao gaveteiro com papéis;
   - editando: senta e digita no laptop;
   - rodando comandos: laptop com a tela piscando;
   - planejando: vai ao quadro branco;
   - delegando: aponta para a porta, e chega um colega (subagente) de crachá e mangas dobradas.
4. **Chegue perto** de qualquer um para ver o balão com o que ele está fazendo agora. Perto do funcionário principal:
   - **E** abre o feed completo (tudo o que ele e a equipe fizeram, com filtro por colega);
   - **R** manda uma mensagem que continua a mesma conversa;
   - **F** mostra o resultado com o custo do turno e o total;
   - **X** dispensa: se ele estiver trabalhando, o trabalho é interrompido; se estiver parado, ele vai embora.
5. Quando termina, ele comemora e senta com um cafezinho (selo ✓). Os subagentes saem pela porta.

Os funcionários continuam trabalhando mesmo se você fechar a aba. Se o servidor reiniciar no meio de um trabalho, ele
reata o processo que ainda estiver vivo. Ao fechar o servidor com Ctrl+C, ele avisa quantos continuam trabalhando: sem
o servidor, o tempo máximo do turno (`ESC_WALL`) não é vigiado até você reabrir (o teto de gasto continua valendo).
Com `ESC_ENCERRAR_AO_SAIR=1`, ele dispensa todos ao fechar.

Sessões interativas do Claude Code que você tiver abertas dentro de uma sala aparecem como "visitantes" (👀), só para
ver. O Escritório nunca retoma nem mexe nessas conversas.

### Permissões e riscos — LEIA

A escolha deste app é **"tudo liberado na sala"**: por padrão os funcionários rodam com
`--dangerously-skip-permissions`. Eles executam comandos e editam arquivos **sem pedir sua confirmação**. A tela de
contratar avisa isso e só libera o botão depois que você marca "Entendi".

**Isso NÃO é uma caixa de areia.** O funcionário começa na pasta da sala e é instruído a não sair dela, mas ele roda com
o seu usuário do Linux: se quiser (ou se for enganado), consegue ler e escrever qualquer arquivo que você consegue e
rodar qualquer comando.

O que o app faz para reduzir o risco:
- O prompt vai por stdin, nunca pela linha de comando.
- `--setting-sources user`, `--strict-mcp-config` e `--disable-slash-commands`: o funcionário ignora hooks,
  `.mcp.json`, `.claude/settings`, `.claude/agents` e `.claude/skills` que venham dentro de um repositório clonado
  (verificado com uma execução real). Um repo malicioso não executa nada sozinho só por ser aberto.
- Sem internet por padrão (WebFetch e WebSearch desligados).
- Limites de custo e tempo (tabela abaixo) e no máximo 4 funcionários trabalhando ao mesmo tempo.
- O servidor só escuta em `127.0.0.1`. Toda rota confere o Host, a origem e um cabeçalho anti-CSRF, então outro site
  aberto no navegador não consegue mandar nada.
- O `git status` das placas lê a configuração do repo pelo próprio git e não roda se ela tiver coisas perigosas
  (hooks, fsmonitor, include, sshCommand, commondir); filtros clean/smudge do repo são neutralizados.
- Clone: host que resolve para a rede local/interna é recusado (para um GitLab da empresa, veja
  `ESC_CLONE_HOSTS_INTERNOS`); no máximo 2 clones ao mesmo tempo. Se a URL tiver `usuario:token@`, o token vai por
  variável de ambiente e **não** fica gravado no `.git/config` da sala (nem aparece no `ps`).
- Quando um funcionário termina e deixou algo rodando (`npm run dev &`, um watch), o app encerra essas sobras
  (`ESC_MATAR_SOBRAS=0` para deixar).

O que continua valendo mesmo assim (não tem como o app bloquear):
- O **`CLAUDE.md` / `AGENTS.md` do projeto é lido como instrução**. Num repo de terceiros ele pode mandar o funcionário
  fazer besteira. Se a sala for clonada (ou colocada por fora) e tiver esses arquivos ou uma pasta `.claude/`, a tela
  de contratar mostra um alerta extra "Repositório de terceiros".
- Seus plugins e agentes do nível usuário (os de `~/.claude`) carregam em todo funcionário.
- Um funcionário em modo liberado consegue chamar a própria API do Escritório (por `curl` no localhost) e contratar
  colegas em outras salas, dentro do limite de funcionários.

O que você deve fazer:
- **Só contrate funcionários em projetos em que você confia.** Cuidado especial com repositórios clonados de
  terceiros: um README ou arquivo com instruções maliciosas pode tentar convencer o Claude a fazer besteira
  (*prompt injection*), e no modo liberado ninguém vai te perguntar antes.
- Tenha o projeto no git (ou em backup) antes de pedir mudanças grandes.
- Quer menos liberdade? Rode com `ESC_MODO=acceptEdits` (edita arquivos, mas comandos que precisariam de permissão
  são recusados) ou `ESC_MODO=auto` (o classificador do Claude decide). Como ninguém está olhando para aprovar,
  o que for recusado deixa o funcionário com o selo ⛔ e o feed mostra o motivo.

### Limites (variáveis de ambiente)

| variável | padrão | o que é |
|---|---|---|
| `ESC_MODO` | `bypassPermissions` | modo de permissão: `bypassPermissions`, `acceptEdits` ou `auto` |
| `ESC_MAX_FUNC` | 4 | funcionários trabalhando ao mesmo tempo no servidor |
| `ESC_MAX_POR_SALA` | 3 | funcionários por sala |
| `ESC_BUDGET` | 1.00 | teto em US$ por turno (`--max-budget-usd`) |
| `ESC_BUDGET_SESSAO` | 5.00 | acima desse custo acumulado, ele não aceita mais mensagens |
| `ESC_WALL` | 1800 | segundos máximos de um turno (depois disso é interrompido) |
| `ESC_TURNS` | 80 | `--max-turns` por turno |
| `ESC_SUBS_PAR` | 3 | subagentes ao mesmo tempo por funcionário |
| `ESC_WEB` | desligado | `ESC_WEB=1` libera WebFetch/WebSearch |
| `ESC_FILA` | desligado | `ESC_FILA=1` enfileira uma mensagem enquanto ele trabalha |
| `ESC_CLONE_TIMEOUT` / `ESC_CLONE_MAX_MB` | 600 / 2048 | segundos e MB máximos de um `git clone` |
| `ESC_CLONE_HOSTS_INTERNOS` | vazio | hosts (vírgula) que podem resolver para a rede interna, ex. o GitLab da empresa (`ESC_CLONE_REDE_INTERNA=1` libera todos) |
| `ESC_MATAR_SOBRAS` | 1 | encerra processos que o funcionário deixou rodando ao terminar (`0` = só registra no log) |
| `ESC_ENCERRAR_AO_SAIR` | desligado | `1` = ao fechar o servidor com Ctrl+C, dispensa quem ainda estiver trabalhando |
| `ESC_DRY_RUN` | desligado | modo de teste: não abre o navegador e os funcionários são **simulados** (não gastam nada) |

## Onde ficam os dados

```
~/escritorios/
└── <Nome do escritório>/
    ├── quadro/                  notas do quadro (.md) — edite à vontade por fora também
    ├── <Sala 1>/                cada sala é uma pasta de projeto normal (o seu código)
    ├── <Sala 2>/
    └── .escritorio/             metadados do app (pode apagar se quiser recomeçar do zero)
        ├── office.json          nome, cores e ordem das salas
        ├── quadro.json          posição dos post-its
        ├── lixeira/             notas apagadas
        ├── rh/<id>/             cada funcionário: meta.json, eventos.ndjson (feed), out.ndjson (stream bruto), err.log
        └── rh/.arquivo/         funcionários arquivados
```

- Fora o README e o `git init` de uma sala criada do zero, o app não grava nada dentro das salas. Quem mexe lá
  são os funcionários (e você).
- Uma pasta criada por fora dentro do escritório vira sala sozinha. Se você apagar a pasta, a sala some.
- As conversas dos funcionários também ficam no histórico normal do Claude Code (`~/.claude/projects/…`).
- O app não apaga pastas de sala. Para renomear ou remover um projeto, faça pelo sistema de arquivos.

## Problemas comuns

- **Tela cinza / "Não consegui falar com o servidor":** o servidor não está rodando ou está em outra porta.
- **Lento:** aperte I até "baixa" e recarregue (F5). No modo auto a resolução já se ajusta sozinha. F3 mostra os números.
- **O funcionário fica com ⚠️ (erro):** abra o feed (E) ou o resultado (F). A última linha do erro do `claude` aparece ali.
  Confira se o `claude` está logado (`claude` no terminal).
- **O clone falhou:** a obra fica "embargada" com o motivo (repo privado, URL errada, sem rede). Chegue perto para
  "Tentar de novo" ou "Dispensar aviso".
- **"o host … aponta para um endereço local/interno":** o nome resolve para a rede da empresa/local. Se for um servidor
  git seu de confiança, rode com `ESC_CLONE_HOSTS_INTERNOS=gitlab.suaempresa.com`.
- **"funcionário sem sessão conhecida (ou a sessão mudou)":** o registro não bate com a sessão que ele mesmo criou
  (meta.json alterado?). Por segurança não há `--resume`; contrate outro.
